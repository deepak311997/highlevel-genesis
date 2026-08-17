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
 * Its own file because it is its own subject. `hl-proxy.spec.ts` seeds every
 * connection an hour from expiry precisely so that nothing there rotates by
 * accident; everything here is inside the five-minute skew on purpose.
 *
 * ## Why the network call is inside the transaction
 *
 * A naive reading of that says a contended retry re-sends a refresh token the
 * first attempt already spent, which is the bricked-connection scare from
 * `HIGHLEVEL_PLATFORM.md` §3. Two properties make it safe, and this file tries
 * to break both. Firestore read-write transactions are **pessimistic**, so the
 * second caller's `tx.get` blocks on the first's lock rather than racing it;
 * and the transaction body **re-reads and short-circuits** when it finds a
 * token somebody else already rotated, so a retried transaction cannot refresh
 * twice.
 *
 * **Only the second of those is observable here.** The Firestore emulator does
 * not implement the read lock, so the simultaneous case measures 3–4 refreshes
 * for three callers rather than one. That is recorded in full on the case
 * itself and in the build log; it is a property of the emulator, and the
 * connection survives it either way because §3's measured grace window accepts
 * a reused refresh token at least once. The short-circuit *is* asserted
 * exactly, by staggering the callers.
 *
 * ## What is written on a failure is the other half
 *
 * The asymmetry in D26 is the whole point and it is easy to get backwards: a
 * definitive `invalid_grant` writes `needsReconnect` and **keeps** the refresh
 * token, while a 500 or a network error writes **nothing at all**. A blip
 * recorded as a dead connection is a connection nobody can revive without
 * reinstalling.
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

  /*
   * The short-circuit, proved deterministically.
   *
   * Three calls, staggered so the later two arrive after the first has
   * committed. Exactly one refresh reaches HighLevel: the others find a token
   * somebody else already rotated and use it. This is the mechanism D23 rests
   * on, and it is the half that can be asserted without depending on how the
   * store schedules two simultaneous readers.
   */
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

  /*
   * The hazard itself (D23, R2) — and the one place this suite cannot assert
   * what the PRD asks for.
   *
   * AC-26 says exactly one refresh request reaches HighLevel when three calls
   * arrive at once. That rests on Firestore read-write transactions being
   * **pessimistic**: the second caller's `tx.get` blocks on the first's lock
   * rather than racing it. **The Firestore emulator does not implement that
   * lock.** All three readers see the stale document, all three refresh, one
   * commits and the rest retry — measured over six rounds as 3, 3, 4, 4, 4, 4.
   * Never one, and never a storm.
   *
   * So the count is asserted as a *bound* rather than as one, and the bound is
   * chosen to still catch the regression that matters. Delete the in-transaction
   * re-read and each of three callers can refresh on each of five attempts —
   * fifteen. Six is comfortably above what the emulator produces and far below
   * that, so a short-circuit that stopped working fails this case loudly.
   *
   * What is asserted unconditionally is what actually protects the user, and it
   * holds in both worlds: every caller succeeds, the connection is left usable
   * rather than marked dead, and the token every later call carries is the one
   * that was persisted — so the losers converged on the winner's result and did
   * not strand themselves on a token nobody stored. §3's measured grace window
   * (a reused refresh token still works at least once) is why the extra rotations
   * are survivable rather than fatal, and it is the reason this is recorded as a
   * residue rather than treated as a defect to design around.
   */
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
   * D26's first half. `invalid_grant` is the one answer that means the grant is
   * genuinely gone, so the flag is written — and the refresh token is left
   * exactly as it was, because §3's first rule is never to destroy a token that
   * may still be valid and reconnecting overwrites the document anyway.
   *
   * This is also P8: the transaction has to **commit** to record the flag. A
   * body that threw to signal the refusal would discard `needsReconnect: true`
   * with everything else, and this case would fail in a way that reads like a
   * Firestore bug.
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
   * D26's second half, and the asymmetry that is the whole decision. A 500 says
   * nothing about the connection, so nothing is written — not the flag, not a
   * cleared token, nothing. The caller retries and the next attempt may well
   * work.
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
