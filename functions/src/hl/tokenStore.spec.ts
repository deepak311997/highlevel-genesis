import { Timestamp } from 'firebase-admin/firestore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DocumentReference, Transaction } from 'firebase-admin/firestore'

import type { TokenResponse } from './schema'

/**
 * The rotation, and the one thing about it that no emulator-backed test can
 * see: **a Firestore transaction retry re-runs the body**.
 *
 * `tests/integration/hl-token-refresh.spec.ts` proves what the emulator can
 * prove — that a rotation persists, that `invalid_grant` marks and a 500 does
 * not, that concurrent callers converge. It cannot prove this, for two reasons
 * that compound: the emulator does not implement the pessimistic read lock, and
 * the fake token endpoint mints a fresh grant for *any* refresh token and never
 * invalidates one. So the emulator is a HighLevel that does not rotate, against
 * a Firestore that does not lock — and the failure this file is about needs a
 * HighLevel that *does* rotate.
 *
 * The fake below is the faithful one: it spends a refresh token on use and
 * answers `400 invalid_grant` to anyone who presents it again, which is what
 * `HIGHLEVEL_PLATFORM.md` §3 says the real endpoint does.
 */

const getDb = vi.hoisted(() => vi.fn())
const refreshTokens = vi.hoisted(() => vi.fn())

// Hoisted above the imports below by Vitest, so `tokenStore` closes over these.
// `HlRequestError` has to come from the mock rather than the real module: the
// `instanceof` check in `isDefinitiveRefreshFailure` compares against whatever
// `./exchange` resolved to, and two classes of the same name are two classes.
const HlRequestError = vi.hoisted(
  () =>
    class HlRequestError extends Error {
      constructor(
        readonly status: number,
        readonly body: string,
      ) {
        super(`HighLevel responded ${String(status)}`)
        this.name = 'HlRequestError'
      }
    },
)

vi.mock('../lib/firebase', () => ({ getDb }))
vi.mock('./exchange', () => ({ refreshTokens, HlRequestError }))

import { firestoreTokenDeps, markNeedsReconnect } from './tokenStore'
import { HlReconnectRequiredError, HlRefreshUnavailableError } from './token'

const UID = 'alice'
const LOCATION = 'lUanVn0CtZJTlymH8ySo'

/** Two minutes out — inside the five-minute skew, so a call must rotate. */
const INSIDE_SKEW_MS = 120_000
const OUTSIDE_SKEW_MS = 3_600_000

function connection(expiresInMs: number, refreshToken: string): Record<string, unknown> {
  return {
    accessToken: 'seeded-access',
    refreshToken,
    expiresAt: Timestamp.fromMillis(Date.now() + expiresInMs),
    locationId: LOCATION,
    needsReconnect: false,
  }
}

function issued(n: number): TokenResponse {
  return {
    access_token: `access-${String(n)}`,
    refresh_token: `refresh-${String(n)}`,
    expires_in: 86_400,
    token_type: 'Bearer',
    scope: 'contacts.readonly',
    companyId: 'swdGTJYeSOLEHFfgZgPf',
    userType: 'Location',
    locationId: LOCATION,
  }
}

/**
 * HighLevel's documented behaviour: each refresh issues a new refresh token and
 * **invalidates the one presented** (§3). Presenting a spent one is
 * `400 invalid_grant`.
 */
function rotatingHighLevel(): void {
  const spent = new Set<string>()
  let n = 0
  refreshTokens.mockImplementation((token: string) => {
    if (spent.has(token)) {
      return Promise.reject(
        new HlRequestError(400, '{"error":"invalid_grant","error_description":"already used"}'),
      )
    }
    spent.add(token)
    n += 1
    return Promise.resolve(issued(n))
  })
}

interface FakeDb {
  /** What committed, in order. The last one is the document's final state. */
  commits: Record<string, unknown>[]
  /** Plain `.update()` calls, outside any transaction. */
  updates: Record<string, unknown>[]
}

/**
 * A Firestore that retries, modelled on the only two properties that matter.
 *
 * `attempts` is how many times the SDK re-invokes the body before a commit
 * sticks — the real default is five. The second property is the one the bug
 * lives in: **an attempt that does not commit discards its writes**, so the
 * next attempt re-reads a document that has not moved. Anything the body did to
 * the outside world on the way — spending a refresh token, say — is not
 * discarded with it.
 */
function fakeDb(
  options: { attempts?: number; exists?: boolean; data?: Record<string, unknown> } = {},
): FakeDb {
  const attempts = options.attempts ?? 1
  const exists = options.exists ?? true
  const commits: Record<string, unknown>[] = []
  const updates: Record<string, unknown>[] = []
  let data = options.data

  const db = {
    doc: () => ({
      get: () => Promise.resolve({ exists, data: () => data }),
      update: (patch: Record<string, unknown>) => {
        if (!exists) return Promise.reject(new Error('5 NOT_FOUND: no entity to update'))
        updates.push(patch)
        return Promise.resolve()
      },
    }),
    runTransaction: async <T>(body: (tx: Transaction) => Promise<T>): Promise<T> => {
      let result: T | undefined
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const staged: Record<string, unknown>[] = []
        const tx = {
          get: () => Promise.resolve({ exists, data: () => data }),
          update: (_ref: DocumentReference, patch: Record<string, unknown>) => staged.push(patch),
        } as unknown as Transaction

        result = await body(tx)

        // Only the final attempt commits; the earlier ones are rolled back, so
        // the document the next attempt reads is the one this attempt read.
        if (attempt === attempts) {
          for (const patch of staged) {
            commits.push(patch)
            data = { ...data, ...patch }
          }
        }
      }
      return result as T
    },
  }

  getDb.mockReturnValue(db)
  return { commits, updates }
}

beforeEach(() => {
  vi.stubGlobal('console', { ...console, info: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('the transactional rotation', () => {
  it('rotates once and persists the grant it was issued', async () => {
    rotatingHighLevel()
    const db = fakeDb({ data: connection(INSIDE_SKEW_MS, 'refresh-0') })

    await expect(firestoreTokenDeps().refresh(UID)).resolves.toBe('access-1')

    expect(refreshTokens).toHaveBeenCalledTimes(1)
    expect(db.commits[0]).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
  })

  /*
   * The hazard. A retried transaction re-enters the body and re-reads a
   * document that the aborted attempt did not change — so a body that decides
   * "this token is stale, refresh it" decides that again, with the **same**
   * refresh token the first attempt already spent.
   *
   * Against a HighLevel that rotates, that second call is `invalid_grant`,
   * which is indistinguishable from a genuinely dead grant: the connection is
   * marked `needsReconnect`, the perfectly good grant the first attempt was
   * issued is discarded with the rolled-back write, and the user has to
   * reinstall the marketplace app to recover. A blip becomes a reinstall.
   *
   * The refresh token is spent by the *network call*, not by the transaction,
   * so a rollback cannot take it back. The only thing that can is not spending
   * it twice.
   */
  it('spends the refresh token once even when the transaction is retried', async () => {
    rotatingHighLevel()
    const db = fakeDb({ attempts: 2, data: connection(INSIDE_SKEW_MS, 'refresh-0') })

    await expect(firestoreTokenDeps().refresh(UID)).resolves.toBe('access-1')

    expect(refreshTokens).toHaveBeenCalledTimes(1)
    expect(refreshTokens).toHaveBeenCalledWith('refresh-0')
    // The grant the one refresh issued, not a second one and not nothing.
    expect(db.commits[0]).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
    expect(db.commits[0]).not.toHaveProperty('needsReconnect')
  })

  it('does not mark a connection dead because it retried', async () => {
    rotatingHighLevel()
    const db = fakeDb({ attempts: 3, data: connection(INSIDE_SKEW_MS, 'refresh-0') })

    await firestoreTokenDeps().refresh(UID)

    for (const commit of db.commits) expect(commit['needsReconnect']).toBeUndefined()
  })

  /*
   * The short-circuit, which is the *other* caller's protection and still has
   * to work: a body that re-enters and finds a token somebody else already
   * rotated uses it rather than refreshing again.
   */
  it('reuses a token another caller rotated rather than refreshing', async () => {
    rotatingHighLevel()
    fakeDb({ data: connection(OUTSIDE_SKEW_MS, 'refresh-0') })

    await expect(firestoreTokenDeps().refresh(UID)).resolves.toBe('seeded-access')

    expect(refreshTokens).not.toHaveBeenCalled()
  })

  // D26's first half, unchanged: a genuinely dead grant is still recorded, and
  // the refresh token is still left exactly where it was.
  it('marks the connection when the first refresh is a definitive invalid_grant', async () => {
    refreshTokens.mockRejectedValue(new HlRequestError(400, '{"error":"invalid_grant"}'))
    const db = fakeDb({ data: connection(INSIDE_SKEW_MS, 'dead-refresh') })

    await expect(firestoreTokenDeps().refresh(UID)).rejects.toBeInstanceOf(HlReconnectRequiredError)

    expect(db.commits[0]).toMatchObject({ needsReconnect: true })
    expect(db.commits[0]).not.toHaveProperty('refreshToken')
  })

  // D26's second half: a blip writes nothing at all.
  it('writes nothing when the refresh fails transiently', async () => {
    refreshTokens.mockRejectedValue(new HlRequestError(500, 'upstream exploded'))
    const db = fakeDb({ data: connection(INSIDE_SKEW_MS, 'refresh-0') })

    await expect(firestoreTokenDeps().refresh(UID)).rejects.toBeInstanceOf(
      HlRefreshUnavailableError,
    )

    expect(db.commits).toEqual([])
  })
})

describe('markNeedsReconnect', () => {
  it('records the flag on a connection that is there', async () => {
    const db = fakeDb({ data: connection(OUTSIDE_SKEW_MS, 'refresh-0') })

    await markNeedsReconnect(UID)

    expect(db.updates[0]).toMatchObject({ needsReconnect: true })
  })

  /*
   * Best effort, deliberately.
   *
   * The write races a disconnect: `handleDeleteConnection` hard-deletes the
   * document, so a proxy call that resolved a connection and then got a 401
   * from HighLevel can find nothing left to mark. `.update()` rejects on a
   * missing document, and an unguarded rejection here would replace the
   * `409 hl_reconnect_required` the caller is owed with a `500 internal` — the
   * marking, which is an optimisation, would have eaten the answer, which is
   * the contract (D20, AC-31).
   */
  it('does not turn a vanished connection into a failed request', async () => {
    fakeDb({ exists: false })

    await expect(markNeedsReconnect(UID)).resolves.toBeUndefined()
  })
})
