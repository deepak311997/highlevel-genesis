import { describe, expect, it, vi } from 'vitest'

import {
  getAccessToken,
  HlNotConnectedError,
  HlReconnectRequiredError,
  isFresh,
  resolveConnection,
  SKEW_MS,
  type TokenDeps,
} from './token'

/**
 * Deciding *whether* to refresh.
 *
 * Kept separate from performing the refresh, which is a Firestore transaction
 * and is covered at L4 in `tests/integration/hl-refresh.spec.ts`. What is worth
 * testing here is the arithmetic, because the interesting case is not "expired"
 * — it is "close enough to expiry that a request in flight would outlive the
 * token".
 *
 * HighLevel rotates refresh tokens on use: every refresh invalidates the
 * previous refresh token. Refreshing five minutes early is what keeps the
 * number of callers who arrive at an expired token — and therefore all try to
 * rotate at once — as close to zero as possible.
 */

const UID = 'user-1'
const NOW = 1_700_000_000_000
const LOCATION = 'lUanVn0CtZJTlymH8ySo'

function deps(overrides: Partial<TokenDeps> = {}): TokenDeps {
  return {
    read: vi.fn().mockResolvedValue({
      accessToken: 'stored-token',
      expiresAtMs: NOW + 60 * 60_000,
      locationId: LOCATION,
      needsReconnect: false,
    }),
    refresh: vi.fn().mockResolvedValue('rotated-token'),
    ...overrides,
  }
}

describe('SKEW_MS', () => {
  it('refreshes five minutes early', () => {
    expect(SKEW_MS).toBe(5 * 60_000)
  })
})

describe('isFresh', () => {
  it('is true one millisecond outside the skew window', () => {
    expect(isFresh(NOW + SKEW_MS + 1, NOW)).toBe(true)
  })

  it('is false exactly at the skew boundary, so the boundary refreshes', () => {
    expect(isFresh(NOW + SKEW_MS, NOW)).toBe(false)
  })

  it('is false inside the window, before the token has actually expired', () => {
    expect(isFresh(NOW + SKEW_MS - 1, NOW)).toBe(false)
  })

  it('is false for a token that has already expired', () => {
    expect(isFresh(NOW - 1, NOW)).toBe(false)
  })
})

describe('getAccessToken', () => {
  it('returns the stored token without touching HighLevel when it is fresh', async () => {
    const d = deps()

    await expect(getAccessToken(UID, d, NOW)).resolves.toBe('stored-token')
    expect(d.refresh).not.toHaveBeenCalled()
  })

  it('rotates when the token falls inside the skew window', async () => {
    const d = deps({
      read: vi.fn().mockResolvedValue({ accessToken: 'stale', expiresAtMs: NOW + SKEW_MS - 1 }),
    })

    await expect(getAccessToken(UID, d, NOW)).resolves.toBe('rotated-token')
    expect(d.refresh).toHaveBeenCalledTimes(1)
    expect(d.refresh).toHaveBeenCalledWith(UID)
  })

  it('rotates exactly once, never twice, for a single call', async () => {
    const d = deps({
      read: vi.fn().mockResolvedValue({ accessToken: 'stale', expiresAtMs: NOW - 1 }),
    })

    await getAccessToken(UID, d, NOW)

    expect(d.refresh).toHaveBeenCalledTimes(1)
  })

  /*
   * Rejecting rather than returning undefined is the point: a caller that
   * received undefined would send `Authorization: Bearer undefined` and get a
   * 401 back from HighLevel, which reads as "your connection expired" when the
   * truth is that no connection was ever made.
   */
  it('rejects when the user has no connection at all', async () => {
    const d = deps({ read: vi.fn().mockResolvedValue(undefined) })

    await expect(getAccessToken(UID, d, NOW)).rejects.toBeInstanceOf(HlNotConnectedError)
    expect(d.refresh).not.toHaveBeenCalled()
  })
})

/**
 * The token *and* the location, from one read.
 *
 * The proxy needs both — the token to authenticate the call and the connection's
 * own `locationId` to inject (D10) — and a second Firestore read for a value the
 * first one already returned would be a lookup that changes nothing.
 */
describe('resolveConnection', () => {
  it('returns the stored token and the location without a refresh when fresh', async () => {
    const d = deps()

    await expect(resolveConnection(UID, d, NOW)).resolves.toEqual({
      accessToken: 'stored-token',
      locationId: LOCATION,
    })
    expect(d.refresh).not.toHaveBeenCalled()
  })

  it('refreshes and still returns the connection’s location when inside the skew', async () => {
    const d = deps({
      read: vi.fn().mockResolvedValue({
        accessToken: 'stale',
        expiresAtMs: NOW + SKEW_MS - 1,
        locationId: LOCATION,
        needsReconnect: false,
      }),
    })

    await expect(resolveConnection(UID, d, NOW)).resolves.toEqual({
      accessToken: 'rotated-token',
      locationId: LOCATION,
    })
  })

  /*
   * AC-29. Slice 2's review named this as travelling with the transaction:
   * harmless when nothing called the proxy, wasteful now that a preview can fire
   * several calls at once at a connection that is already known to be dead. The
   * assertion that matters is `refresh` never being reached — a refused
   * connection must cost no HighLevel round trip at all.
   */
  it('refuses a connection already marked needsReconnect, without refreshing', async () => {
    const d = deps({
      read: vi.fn().mockResolvedValue({
        accessToken: 'stored-token',
        expiresAtMs: NOW + 60 * 60_000,
        locationId: LOCATION,
        needsReconnect: true,
      }),
    })

    await expect(resolveConnection(UID, d, NOW)).rejects.toBeInstanceOf(HlReconnectRequiredError)
    expect(d.refresh).not.toHaveBeenCalled()
  })

  it('refuses a dead connection even when the token is stale', async () => {
    const d = deps({
      read: vi.fn().mockResolvedValue({
        accessToken: 'stale',
        expiresAtMs: NOW - 1,
        locationId: LOCATION,
        needsReconnect: true,
      }),
    })

    await expect(resolveConnection(UID, d, NOW)).rejects.toBeInstanceOf(HlReconnectRequiredError)
    expect(d.refresh).not.toHaveBeenCalled()
  })

  it('rejects when the user has no connection at all', async () => {
    const d = deps({ read: vi.fn().mockResolvedValue(undefined) })

    await expect(resolveConnection(UID, d, NOW)).rejects.toBeInstanceOf(HlNotConnectedError)
  })
})
