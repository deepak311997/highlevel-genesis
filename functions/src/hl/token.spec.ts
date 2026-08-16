import { describe, expect, it, vi } from 'vitest'

import { getAccessToken, HlNotConnectedError, isFresh, SKEW_MS, type TokenDeps } from './token'

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

function deps(overrides: Partial<TokenDeps> = {}): TokenDeps {
  return {
    read: vi.fn().mockResolvedValue({ accessToken: 'stored-token', expiresAtMs: NOW + 60 * 60_000 }),
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
