import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adminDb, deleteJson, getJson, idTokenFor, postJson, resetEmulators, seedUser } from './helpers'

/**
 * `/api/hl/proxy/**` — the boundary, over the wire.
 *
 * The unit tests prove the matcher refuses what it should. This file proves the
 * *refusals reach a caller*, in the right order, with nothing touched on the way
 * — which is a different claim and the one R1 and R3 actually rest on.
 *
 * ## Ordering is the assertion, not a detail of it
 *
 * Several cases here look like they only check a status code. They check an
 * **order**: a caller with no connection document who asks for a route that is
 * not on the allowlist gets `403 route_not_allowed` and not `409
 * hl_not_connected`. The second status is what a proxy that read Firestore
 * before consulting the table would answer. So the status *is* the evidence that
 * the read never happened — there is no other way to observe a read that did not
 * occur.
 *
 * The upstream call is observed directly instead, through the fake's own counter
 * (`GET /__fake-hl/__calls`), because a call that was never made is otherwise
 * indistinguishable from one that failed.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'proxy-alice@example.test'
const BOB = 'proxy-bob@example.test'
const UNVERIFIED = 'proxy-unverified@example.test'

/** The fake's own location, and the one its fixtures are recorded against. */
const ALICE_LOCATION = 'lUanVn0CtZJTlymH8ySo'
const BOB_LOCATION = 'aB9zzQ1CtZJTlymH8ySo'

const ACCESS_TOKEN = 'alice-access-token-must-never-be-returned'
const REFRESH_TOKEN = 'alice-refresh-token-must-never-be-returned'

let aliceUid: string
let bobUid: string
let aliceToken: string
let bobToken: string
let unverifiedToken: string

/**
 * A connection an hour from expiry, so nothing here refreshes by accident.
 *
 * `tests/integration/hl-token-refresh.spec.ts` owns the skew; a case in this
 * file that rotated a token would be testing that file's subject with this
 * file's fixtures.
 */
async function seedConnection(uid: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await adminDb()
    .doc(`hlConnections/${uid}`)
    .set({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      locationId: ALICE_LOCATION,
      locationName: 'India Square',
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

/** How many requests the stub has received since the last reset. */
async function upstreamCalls(): Promise<number> {
  const res = await getJson('/__fake-hl/__calls')
  return (res.body as { total: number }).total
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
  await deleteJson('/__fake-hl/__calls')
})

describe('the proxy boundary', () => {
  it('refuses a request with no Authorization header', async () => {
    await seedConnection(aliceUid)

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 })

    expect(res.status).toBe(401)
    expect((res.body as { code?: string }).code).toBe('unauthenticated')
    expect(await upstreamCalls()).toBe(0)

    // Untouched, field for field — a refusal that still wrote something would
    // pass a status assertion and fail AC-17's actual claim.
    const stored = (await adminDb().doc(`hlConnections/${aliceUid}`).get()).data()
    expect(stored?.['accessToken']).toBe(ACCESS_TOKEN)
    expect(stored?.['needsReconnect']).toBe(false)
  })

  it('refuses a caller whose email is not verified', async () => {
    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(unverifiedToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('email_unverified')
    expect(await upstreamCalls()).toBe(0)
  })

  it('refuses a route the allowlist does not name', async () => {
    await seedConnection(aliceUid)

    const res = await deleteJson('/api/hl/proxy/contacts/abc123', auth(aliceToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_not_allowed')
    expect(await upstreamCalls()).toBe(0)
  })

  /*
   * The ordering proof described at the top of this file. Bob has no connection
   * document at all: a proxy that resolved a token before consulting the table
   * would answer `409 hl_not_connected` here, and that is the only way the
   * difference is observable from outside.
   */
  it('consults the allowlist before it reads a connection', async () => {
    const res = await deleteJson('/api/hl/proxy/contacts/abc123', auth(bobToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_not_allowed')
  })

  it('refuses the bare subtree rather than 404ing', async () => {
    await seedConnection(aliceUid)

    const res = await getJson('/api/hl/proxy', auth(aliceToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_not_allowed')
  })

  it('refuses an allowlisted path reached with the wrong method', async () => {
    await seedConnection(aliceUid)

    const res = await getJson('/api/hl/proxy/contacts/search', auth(aliceToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_not_allowed')
    expect(await upstreamCalls()).toBe(0)
  })

  it('refuses a path parameter outside the grammar', async () => {
    await seedConnection(aliceUid)

    const res = await getJson('/api/hl/proxy/contacts/%2E%2E%2Foauth', auth(aliceToken))

    expect(res.status).toBe(400)
    expect((res.body as { code?: string }).code).toBe('invalid_path')
    expect(await upstreamCalls()).toBe(0)
  })

  /*
   * `route_disabled` and **not** `route_not_allowed`, which is the whole point:
   * the row exists and is deliberately safed, so the refusal has to read
   * differently from one for a path nobody put on the table (D5, R5).
   */
  it('refuses the message-send route, which is off in every environment', async () => {
    await seedConnection(aliceUid)

    const res = await postJson(
      '/api/hl/proxy/conversations/messages',
      { type: 'SMS', message: 'hello' },
      auth(aliceToken),
    )

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_disabled')
    expect(await upstreamCalls()).toBe(0)
  })

  it('answers hl_not_connected when there is no connection document', async () => {
    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(aliceToken))

    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('hl_not_connected')
    expect(await upstreamCalls()).toBe(0)
  })

  /*
   * AC-29 over the wire. The pure half is in `functions/src/hl/token.spec.ts`;
   * what this adds is that no refresh request leaves the process — the counter
   * would see it, because the token endpoint is on the same stub.
   */
  it('refuses a connection already marked needsReconnect, without refreshing', async () => {
    await seedConnection(aliceUid, {
      needsReconnect: true,
      // Inside the skew, so a handler that checked freshness first would refresh.
      expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
    })

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(aliceToken))

    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('hl_reconnect_required')
    expect(await upstreamCalls()).toBe(0)
  })

  it('puts no token material in a refusal', async () => {
    await seedConnection(aliceUid, { needsReconnect: true })

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(aliceToken))

    expect(res.raw).not.toContain(ACCESS_TOKEN)
    expect(res.raw).not.toContain(REFRESH_TOKEN)
    expect(res.raw).not.toContain(aliceUid)
  })

  it("never reads another user's connection", async () => {
    await seedConnection(bobUid, { locationId: BOB_LOCATION })

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(aliceToken))

    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('hl_not_connected')
  })
})
