import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logProxy, RATE_LIMIT_HEADERS } from './proxy'

/**
 * The one line per proxied call, and the negative that matters.
 *
 * The interesting assertion here is not that the line carries four fields — it is that there is
 * **nowhere to put a fifth**. `ProxyLogContext` has no field for a request body, a response
 * body, a token or a contact id, so "we do not log payloads" is a property of the type rather
 * than of whoever remembered. `AuthLogContext` and `GenerationLogContext` are narrow for the
 * same reason and say so in as many words.
 */

let info: ReturnType<typeof vi.fn>

function lines(): Record<string, unknown>[] {
  return info.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
}

beforeEach(() => {
  info = vi.fn()
  vi.stubGlobal('console', { ...console, info })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('logProxy', () => {
  it('emits exactly one hl.proxy line with the four fields it exists to carry', () => {
    logProxy({
      pattern: '/contacts/:contactId',
      status: 200,
      durationMs: 143,
      rateLimitRemaining: '9998',
    })

    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toEqual({
      event: 'hl.proxy',
      pattern: '/contacts/:contactId',
      status: 200,
      durationMs: 143,
      rateLimitRemaining: '9998',
    })
  })

  it('logs the matched pattern rather than the concrete path', () => {
    logProxy({
      pattern: '/contacts/:contactId',
      status: 200,
      durationMs: 12,
      rateLimitRemaining: null,
    })

    const raw = String(info.mock.calls[0]?.[0])
    expect(raw).toContain('/contacts/:contactId')
    expect(raw).not.toContain('JwwI60NJqfc8I4Ay2MiA')
  })

  /*
   * The keys, exactly. A regression that added a `body` or a `uid` would pass
   * every assertion above and fail this one, which is the whole point of
   * writing it as an equality over the key set rather than as a `toContain`.
   */
  it('has nowhere to put a body, a token or a contact', () => {
    logProxy({ pattern: '/calendars/', status: 429, durationMs: 8, rateLimitRemaining: '0' })

    expect(Object.keys(lines()[0] ?? {}).sort()).toEqual([
      'durationMs',
      'event',
      'pattern',
      'rateLimitRemaining',
      'status',
    ])
  })

  it('records a missing rate-limit header as null rather than dropping the field', () => {
    logProxy({ pattern: '/calendars/', status: 502, durationMs: 20, rateLimitRemaining: null })

    expect(lines()[0]?.['rateLimitRemaining']).toBeNull()
  })
})

/**
 * D18's five names, in one constant because they are needed in two places — the
 * handler copies them onto the response and `api/index.ts` exposes them through
 * CORS. Two literals is how those drift.
 */
describe('RATE_LIMIT_HEADERS', () => {
  it('is the five headers HighLevel sends', () => {
    expect([...RATE_LIMIT_HEADERS]).toEqual([
      'X-RateLimit-Limit-Daily',
      'X-RateLimit-Daily-Remaining',
      'X-RateLimit-Interval-Milliseconds',
      'X-RateLimit-Max',
      'X-RateLimit-Remaining',
    ])
  })
})
