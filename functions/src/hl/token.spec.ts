import { describe, expect, it, vi } from 'vitest'

import {
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
 * Kept separate from performing the refresh, which is a Firestore transaction and is covered at
 * L4 in `tests/integration/hl-refresh.spec.ts`. What is worth testing here is the arithmetic,
 * because the interesting case is not "expired" — it is "close enough to expiry that a request
 * in flight would outlive the token".
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
   * Slice 2's review named this as travelling with the transaction: harmless when nothing called
   * the proxy, wasteful now that a preview can fire several calls at once at a connection that
   * is already known to be dead.
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

  it('rotates exactly once, never twice, for a single call', async () => {
    const d = deps({
      read: vi.fn().mockResolvedValue({
        accessToken: 'stale',
        expiresAtMs: NOW - 1,
        locationId: LOCATION,
        needsReconnect: false,
      }),
    })

    await resolveConnection(UID, d, NOW)

    expect(d.refresh).toHaveBeenCalledTimes(1)
    expect(d.refresh).toHaveBeenCalledWith(UID)
  })

  /*
   * Rejecting rather than returning undefined is the point: a caller that received undefined
   * would send `Authorization: Bearer undefined` and get a 401 back from HighLevel, which reads
   * as "your connection expired" when the truth is that no connection was ever made.
   */
  it('rejects when the user has no connection at all', async () => {
    const d = deps({ read: vi.fn().mockResolvedValue(undefined) })

    await expect(resolveConnection(UID, d, NOW)).rejects.toBeInstanceOf(HlNotConnectedError)
    expect(d.refresh).not.toHaveBeenCalled()
  })
})
