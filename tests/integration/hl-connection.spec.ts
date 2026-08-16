import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adminDb, deleteJson, getJson, idTokenFor, resetEmulators, seedUser } from './helpers'

/**
 * `GET` and `DELETE /api/hl/connection` — the only window the browser has onto
 * a connection.
 *
 * `hlConnections/{uid}` holds a live OAuth access token and a refresh token,
 * and Firestore rules deny it to every client including its owner. So the
 * dashboard cannot read it; it asks this endpoint, which returns a deliberately
 * narrow projection.
 *
 * The assertion that matters most is a negative one: no token material in the
 * response body. It is checked against the **raw text** rather than the parsed
 * object, because a leak nested one level down survives a check on top-level
 * keys.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'conn-alice@example.test'
const BOB = 'conn-bob@example.test'
const UNVERIFIED = 'conn-unverified@example.test'

let aliceUid: string
let bobUid: string
let aliceToken: string
let bobToken: string
let unverifiedToken: string

const ACCESS_TOKEN = 'access-token-must-never-be-returned'
const REFRESH_TOKEN = 'refresh-token-must-never-be-returned'

async function seedConnection(uid: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await adminDb()
    .doc(`hlConnections/${uid}`)
    .set({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      locationId: 've9EPM428h8vShlRW1KT',
      locationName: 'Genesis Sandbox',
      companyId: 'swdGTJYeSOLEHFfgZgPf',
      hlUserId: 'hl-user-1',
      scope: 'contacts.readonly',
      needsReconnect: false,
      connectedAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      ...overrides,
    })
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

beforeAll(async () => {
  await resetEmulators()
  aliceUid = await seedUser(ALICE, PASSWORD, true)
  bobUid = await seedUser(BOB, PASSWORD, true)
  await seedUser(UNVERIFIED, PASSWORD, false)
  aliceToken = await idTokenFor(ALICE, PASSWORD)
  bobToken = await idTokenFor(BOB, PASSWORD)
  unverifiedToken = await idTokenFor(UNVERIFIED, PASSWORD)
})

beforeEach(async () => {
  await adminDb().doc(`hlConnections/${aliceUid}`).delete()
  await adminDb().doc(`hlConnections/${bobUid}`).delete()
})

describe('GET /api/hl/connection', () => {
  it('reports not connected when there is no connection', async () => {
    const res = await getJson('/api/hl/connection', auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ connected: false })
  })

  it('reports the location once connected', async () => {
    await seedConnection(aliceUid)

    const res = await getJson('/api/hl/connection', auth(aliceToken))
    const body = res.body as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body['connected']).toBe(true)
    expect(body['locationId']).toBe('ve9EPM428h8vShlRW1KT')
    expect(body['locationName']).toBe('Genesis Sandbox')
    expect(body['needsReconnect']).toBe(false)
    expect(typeof body['connectedAt']).toBe('string')
  })

  /*
   * Asserted on the raw text, not the parsed object. A token nested inside some
   * future field would pass a top-level key check and still be on the wire.
   */
  it('never puts token material on the wire', async () => {
    await seedConnection(aliceUid)

    const res = await getJson('/api/hl/connection', auth(aliceToken))

    expect(res.raw).not.toContain(ACCESS_TOKEN)
    expect(res.raw).not.toContain(REFRESH_TOKEN)
    expect(res.raw).not.toContain('expiresAt')
  })

/*
   * A stored document that cannot describe a connection is treated as no
   * connection, not as a connection with blanks in it.
   *
   * The earlier version filled the gaps with `?? ''` and reported
   * `connected: true`, which rendered as "Connected to " with nothing after it
   * — a broken screen that offers no way out, because the panel only shows
   * Connect when it believes you are disconnected. Failing closed puts the
   * recovery back in reach: reconnecting overwrites the document.
   */
  it('reports not connected when the stored document is unusable', async () => {
    await adminDb().doc(`hlConnections/${aliceUid}`).set({ accessToken: 'orphaned' })

    const res = await getJson('/api/hl/connection', auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ connected: false })
  })

  it('never leaks a token from a document it could not parse', async () => {
    await adminDb().doc(`hlConnections/${aliceUid}`).set({ accessToken: ACCESS_TOKEN })

    const res = await getJson('/api/hl/connection', auth(aliceToken))

    expect(res.raw).not.toContain(ACCESS_TOKEN)
  })

  it('surfaces a connection that needs reconnecting', async () => {
    await seedConnection(aliceUid, { needsReconnect: true })

    const body = (await getJson('/api/hl/connection', auth(aliceToken))).body as Record<
      string,
      unknown
    >

    expect(body['needsReconnect']).toBe(true)
  })

  it('reports the location id when the name lookup had failed', async () => {
    await seedConnection(aliceUid, { locationName: null })

    const body = (await getJson('/api/hl/connection', auth(aliceToken))).body as Record<
      string,
      unknown
    >

    expect(body['locationName']).toBeNull()
    expect(body['locationId']).toBe('ve9EPM428h8vShlRW1KT')
  })

  it("returns the caller's own connection, never another user's", async () => {
    await seedConnection(aliceUid)

    const res = await getJson('/api/hl/connection', auth(bobToken))

    expect(res.body).toEqual({ connected: false })
    expect(res.raw).not.toContain('Genesis Sandbox')
  })

  it('refuses an unverified caller', async () => {
    expect((await getJson('/api/hl/connection', auth(unverifiedToken))).status).toBe(403)
  })

  it('refuses an unauthenticated caller', async () => {
    expect((await getJson('/api/hl/connection')).status).toBe(401)
  })
})

describe('DELETE /api/hl/connection', () => {
  it('removes the stored connection', async () => {
    await seedConnection(aliceUid)

    const res = await deleteJson('/api/hl/connection', auth(aliceToken))

    expect(res.status).toBe(200)
    expect((await adminDb().doc(`hlConnections/${aliceUid}`).get()).exists).toBe(false)
  })

  /*
   * Idempotent because the UI cannot know for certain whether it is connected —
   * a stale panel, a double click, a retry after a timeout. Answering 404 to any
   * of those would put an error on screen for a user who already has exactly
   * what they asked for.
   */
  it('succeeds when there was nothing to disconnect', async () => {
    const res = await deleteJson('/api/hl/connection', auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it("never deletes another user's connection", async () => {
    await seedConnection(aliceUid)

    await deleteJson('/api/hl/connection', auth(bobToken))

    expect((await adminDb().doc(`hlConnections/${aliceUid}`).get()).exists).toBe(true)
  })

  it('refuses an unverified caller', async () => {
    await seedConnection(aliceUid)

    expect((await deleteJson('/api/hl/connection', auth(unverifiedToken))).status).toBe(403)
    expect((await adminDb().doc(`hlConnections/${aliceUid}`).get()).exists).toBe(true)
  })
})
