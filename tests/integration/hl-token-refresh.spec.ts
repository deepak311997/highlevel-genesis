import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminDb,
  deleteJson,
  getJson,
  idTokenFor,
  postJson,
  resetEmulators,
  seedUser,
} from './helpers'

/**
 * The token rotation, and the hazard it carries.
 *
 * Its own file because it is its own subject. `hl-proxy.spec.ts` seeds every connection an hour
 * from expiry precisely so that nothing there rotates by accident; everything here is inside the
 * five-minute skew on purpose.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'refresh-alice@example.test'

const LOCATION = 'lUanVn0CtZJTlymH8ySo'
const SEEDED_ACCESS = 'seeded-access-token'
const SEEDED_REFRESH = 'seeded-refresh-token'

/** Two minutes out — inside the five-minute skew, so a call must rotate. */
const INSIDE_SKEW_MS = 120_000
/** An hour out — comfortably outside it, so a call must not. */
const OUTSIDE_SKEW_MS = 3_600_000

let aliceUid: string
let aliceToken: string

interface StoredConnection {
  accessToken: string
  refreshToken: string
  expiresAt: Timestamp
  needsReconnect: boolean
}

async function seedConnection(expiresInMs: number, refreshToken = SEEDED_REFRESH): Promise<void> {
  await adminDb()
    .doc(`hlConnections/${aliceUid}`)
    .set({
      accessToken: SEEDED_ACCESS,
      refreshToken,
      expiresAt: Timestamp.fromMillis(Date.now() + expiresInMs),
      locationId: LOCATION,
      locationName: 'India Square',
      companyId: 'swdGTJYeSOLEHFfgZgPf',
      hlUserId: 'hl-user-1',
      scope: 'contacts.readonly',
      needsReconnect: false,
      connectedAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
    })
}

async function stored(): Promise<StoredConnection> {
  const snapshot = await adminDb().doc(`hlConnections/${aliceUid}`).get()
  return snapshot.data() as unknown as StoredConnection
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${aliceToken}` }
}

/** How many refresh grants the stub has been asked for since the last reset. */
async function refreshes(): Promise<number> {
  const res = await getJson('/__fake-hl/__refresh-count')
  return (res.body as { total: number }).total
}

/** The bearer the stub actually received, through the `__echo` marker id. */
async function bearerSeenUpstream(): Promise<string> {
  const res = await getJson('/api/hl/proxy/contacts/__echo', auth())
  const { headers } = res.body as { headers: Record<string, string> }
  return headers['authorization'] ?? ''
}

beforeAll(async () => {
  await resetEmulators()
  aliceUid = await seedUser(ALICE, PASSWORD, true)
  aliceToken = await idTokenFor(ALICE, PASSWORD)
})

beforeEach(async () => {
  await adminDb().doc(`hlConnections/${aliceUid}`).delete()
  await deleteJson('/__fake-hl/__refresh-count')
})

describe('the transactional refresh', () => {
  it('uses the stored token and asks for no refresh when it is fresh', async () => {
    await seedConnection(OUTSIDE_SKEW_MS)

    expect(await bearerSeenUpstream()).toBe(`Bearer ${SEEDED_ACCESS}`)
    expect(await refreshes()).toBe(0)

    const after = await stored()
    expect(after.refreshToken).toBe(SEEDED_REFRESH)
    expect(after.accessToken).toBe(SEEDED_ACCESS)
  })

  it('rotates inside the skew and persists all three fields', async () => {
    await seedConnection(INSIDE_SKEW_MS)
    const before = await stored()

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth())

    expect(res.status).toBe(200)
    expect(await refreshes()).toBe(1)

    const after = await stored()
    expect(after.accessToken).not.toBe(SEEDED_ACCESS)
    expect(after.refreshToken).not.toBe(SEEDED_REFRESH)
    expect(after.expiresAt.toMillis()).toBeGreaterThan(before.expiresAt.toMillis())
    // A successful rotation says nothing about the connection being dead, and
    // writing it here would strand the user behind a Reconnect button.
    expect(after.needsReconnect).toBe(false)
  })

  /* The short-circuit, proved deterministically. */
  it('reuses a token another caller already rotated', async () => {
    await seedConnection(INSIDE_SKEW_MS)
    const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

    const results = await Promise.all([
      postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth()),
      wait(250).then(() => postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth())),
      wait(500).then(() => postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth())),
    ])

    for (const res of results) expect(res.status).toBe(200)
    expect(await refreshes()).toBe(1)

    const after = await stored()
    expect(after.needsReconnect).toBe(false)
    expect(await bearerSeenUpstream()).toBe(`Bearer ${after.accessToken}`)
  })

  /* The hazard itself — and the one place this suite cannot assert what the PRD asks for. */
  it('leaves one usable connection when three calls arrive at once', async () => {
    await seedConnection(INSIDE_SKEW_MS)

    const results = await Promise.all([
      postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth()),
      postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth()),
      postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth()),
    ])

    for (const res of results) expect(res.status).toBe(200)

    const refreshCount = await refreshes()
    expect(refreshCount).toBeGreaterThan(0)
    expect(refreshCount).toBeLessThanOrEqual(6)

    const after = await stored()
    expect(after.needsReconnect).toBe(false)
    expect(after.accessToken).not.toBe(SEEDED_ACCESS)
    expect(after.refreshToken).not.toBe(SEEDED_REFRESH)
    expect(await bearerSeenUpstream()).toBe(`Bearer ${after.accessToken}`)
  })

  /*
   * D26's first half. `invalid_grant` is the one answer that means the grant is genuinely gone,
   * so the flag is written — and the refresh token is left exactly as it was, because §3's first
   * rule is never to destroy a token that may still be valid and reconnecting overwrites the
   * document anyway.
   */
  it('marks the connection and keeps the refresh token when the grant is dead', async () => {
    await seedConnection(INSIDE_SKEW_MS, 'dead-refresh-token')

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth())

    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('hl_reconnect_required')

    const after = await stored()
    expect(after.needsReconnect).toBe(true)
    expect(after.refreshToken).toBe('dead-refresh-token')
    expect(after.accessToken).toBe(SEEDED_ACCESS)
  })

  /*
   * D26's second half, and the asymmetry that is the whole decision. A 500 says nothing about
   * the connection, so nothing is written — not the flag, not a cleared token, nothing.
   */
  it('writes nothing when the refresh fails transiently', async () => {
    await seedConnection(INSIDE_SKEW_MS, 'boom-refresh-token')
    const before = await stored()

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth())

    expect(res.status).toBe(502)
    expect((res.body as { code?: string }).code).toBe('hl_unavailable')

    const after = await stored()
    expect(after.accessToken).toBe(before.accessToken)
    expect(after.refreshToken).toBe('boom-refresh-token')
    expect(after.expiresAt.toMillis()).toBe(before.expiresAt.toMillis())
    expect(after.needsReconnect).toBe(false)
  })

  it('puts no token material in a refresh failure', async () => {
    await seedConnection(INSIDE_SKEW_MS, 'dead-refresh-token')

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth())

    expect(res.raw).not.toContain(SEEDED_ACCESS)
    expect(res.raw).not.toContain('dead-refresh-token')
    expect(res.raw).not.toContain(aliceUid)
  })
})
