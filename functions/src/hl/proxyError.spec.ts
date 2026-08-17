import { describe, expect, it } from 'vitest'

import { HlRequestError } from './exchange'
import { HttpError } from '../lib/errors'
import {
  detailFrom,
  isDefinitiveRefreshFailure,
  mapTokenError,
  mapUpstreamStatus,
  proxyError,
  PROXY_ERROR_CODES,
} from './proxyError'
import { HlNotConnectedError, HlReconnectRequiredError, HlRefreshUnavailableError } from './token'

/**
 * Turning a HighLevel condition into one of ours.
 *
 * Pure, and separate from the handler, because the mapping table is the part of
 * F8.3 that a reader has to be able to check against the PRD line by line — and
 * because the one regression that matters here is invisible in a handler test:
 * **the proxy must never answer 401**. `apiClient` reads a 401 as "your session
 * died" and signs the user out of Genesis, so mirroring HighLevel's 401 would
 * turn an expired *CRM* token into an expired *Genesis* session (D20).
 */

/** What actually goes on the wire, which is what AC-34 is about. */
function envelope(err: HttpError): string {
  return JSON.stringify({ error: err.message, code: err.code, detail: err.detail })
}

describe('mapUpstreamStatus', () => {
  // AC-30, the PRD's table row by row.
  it.each([
    [401, 409, 'hl_reconnect_required'],
    [403, 403, 'hl_forbidden'],
    [404, 404, 'hl_not_found'],
    [429, 429, 'hl_rate_limited'],
    [400, 400, 'hl_bad_request'],
    [422, 400, 'hl_bad_request'],
    [418, 400, 'hl_bad_request'],
    [503, 502, 'hl_unavailable'],
    [500, 502, 'hl_unavailable'],
  ] as const)('maps upstream %i to %i %s', (upstream, status, code) => {
    const mapped = mapUpstreamStatus(upstream, '')

    expect(mapped).toBeInstanceOf(HttpError)
    expect(mapped.status).toBe(status)
    expect(mapped.code).toBe(code)
  })

  /*
   * The regression D20 names, asserted across the whole 4xx range rather than
   * on one status: a 401 from HighLevel means the install was revoked or a
   * scope was removed, and answering 401 to the browser would sign the user out
   * of an application whose own session is perfectly good.
   */
  it.each([400, 401, 403, 404, 418, 422, 429, 500, 502, 503])(
    'never answers 401, whatever HighLevel said (%i)',
    (upstream) => {
      expect(mapUpstreamStatus(upstream, '').status).not.toBe(401)
    },
  )

  it('gives every condition a message a user could act on', () => {
    for (const upstream of [401, 403, 404, 429, 400, 503]) {
      expect(mapUpstreamStatus(upstream, '').message).toMatch(/\w+/)
    }
  })

  // AC-32 — HighLevel's own text, so the preview can say what was wrong.
  it("carries HighLevel's message as detail", () => {
    const raw = JSON.stringify({
      statusCode: 401,
      message: 'The token is not authorized for this scope.',
    })

    expect(mapUpstreamStatus(401, raw).detail).toBe('The token is not authorized for this scope.')
  })

  it('omits detail for a body it cannot parse', () => {
    expect(mapUpstreamStatus(500, '<html>502 Bad Gateway</html>').detail).toBeUndefined()
    expect(mapUpstreamStatus(500, '').detail).toBeUndefined()
  })

  /*
   * AC-34. Built from a body that carries everything a leak would need, for
   * every status, and asserted against the *rendered envelope* rather than the
   * error object — a field that never reaches the wire cannot leak, and a field
   * that does is what this is looking for.
   */
  it('puts no token and no uid in any mapped error', () => {
    const raw = JSON.stringify({
      message: 'Missing scope',
      access_token: 'live-access-token-xyz',
      refresh_token: 'live-refresh-token-xyz',
      uid: 'firebase-uid-abc',
    })

    for (const upstream of [400, 401, 403, 404, 422, 429, 500, 503]) {
      const wire = envelope(mapUpstreamStatus(upstream, raw))

      expect(wire).not.toContain('live-access-token-xyz')
      expect(wire).not.toContain('live-refresh-token-xyz')
      expect(wire).not.toContain('firebase-uid-abc')
    }
  })
})

describe('detailFrom', () => {
  it("prefers HighLevel's own `message` field", () => {
    expect(detailFrom(JSON.stringify({ message: 'Contact not found', error: 'Not Found' }))).toBe(
      'Contact not found',
    )
  })

  it('falls back to error_description, then error', () => {
    expect(detailFrom(JSON.stringify({ error_description: 'token expired' }))).toBe('token expired')
    expect(detailFrom(JSON.stringify({ error: 'invalid_grant' }))).toBe('invalid_grant')
  })

  // AC-32 — 200 characters, so a stack trace or an HTML page cannot ride along.
  it('truncates at two hundred characters', () => {
    const detail = detailFrom(JSON.stringify({ message: 'x'.repeat(500) }))

    expect(detail).toHaveLength(200)
  })

  it.each([
    ['unparseable text', 'not json at all'],
    ['an empty body', ''],
    ['a JSON array', '[1,2,3]'],
    ['a JSON string', '"just a string"'],
    ['an object with no message', JSON.stringify({ statusCode: 500 })],
    ['a non-string message', JSON.stringify({ message: { nested: true } })],
  ])('returns nothing for %s', (_name, raw) => {
    expect(detailFrom(raw)).toBeUndefined()
  })

  /*
   * The failure path must not be the expensive one.
   *
   * `mapUpstreamStatus` hands this whatever came back, and the proxy's cap
   * allows that to be 5 MiB — so an unguarded `JSON.parse` here would parse
   * megabytes to read at most two hundred characters, on the one path whose
   * size is chosen by upstream rather than by us. A real HighLevel error body
   * is under a hundred bytes: `location-401-missing-scope.json` is 84.
   */
  it('does not parse an error body far larger than any message it could hold', () => {
    const huge = JSON.stringify({ message: 'Invalid JWT', padding: 'x'.repeat(200_000) })

    expect(detailFrom(huge)).toBeUndefined()
  })

  it('still reads a message from a body of a plausible size', () => {
    const roomy = JSON.stringify({ message: 'Invalid JWT', padding: 'x'.repeat(2_000) })

    expect(detailFrom(roomy)).toBe('Invalid JWT')
  })
})

describe('mapTokenError', () => {
  it.each([
    [new HlNotConnectedError(), 409, 'hl_not_connected'],
    [new HlReconnectRequiredError(), 409, 'hl_reconnect_required'],
    [new HlRefreshUnavailableError(), 502, 'hl_unavailable'],
  ] as const)('maps %s', (err, status, code) => {
    const mapped = mapTokenError(err)

    expect(mapped.status).toBe(status)
    expect(mapped.code).toBe(code)
  })

  /*
   * Rethrown rather than flattened to a 500 here: an error this function does
   * not recognise is not a *token* condition, and swallowing it would give the
   * terminal handler nothing to log.
   */
  it('rethrows anything that is not a token condition', () => {
    const other = new Error('something else entirely')

    expect(() => mapTokenError(other)).toThrow(other)
  })

  it('puts no token material in what it returns', () => {
    expect(envelope(mapTokenError(new HlReconnectRequiredError()))).not.toMatch(
      /token[- ]?[a-z0-9]{8}/i,
    )
  })
})

describe('isDefinitiveRefreshFailure', () => {
  /*
   * Only `invalid_grant` is definitive (D26, §3 rule 1). Everything else — a
   * 500, a network blip, a timeout — must leave the stored refresh token
   * exactly where it is, because destroying one that may still be valid is how
   * a connection is bricked until the user reinstalls.
   */
  it('treats a 400 carrying invalid_grant as definitive', () => {
    const err = new HlRequestError(400, JSON.stringify({ error: 'invalid_grant' }))

    expect(isDefinitiveRefreshFailure(err)).toBe(true)
  })

  it.each([
    ['a 400 without it', new HlRequestError(400, JSON.stringify({ error: 'invalid_request' }))],
    ['a 500 mentioning it', new HlRequestError(500, JSON.stringify({ error: 'invalid_grant' }))],
    ['a plain Error', new Error('invalid_grant')],
    ['a network failure', new TypeError('fetch failed')],
  ])('treats %s as transient', (_name, err) => {
    expect(isDefinitiveRefreshFailure(err)).toBe(false)
  })
})

/**
 * The code set, exported as **data** — Slice 9's one addition here.
 *
 * The cheat-sheet in the system prompt has to name every code a rejected `hl()`
 * call can carry (Slice 9 D5, AC-7), and the only honest way to assert that is to
 * read the set rather than restate it. A hand-written list in the prompt would
 * drift on the first code added, and the failure mode is the bad one: generated
 * code branching on a `code` string that no longer exists, silently never running
 * that branch.
 *
 * `MESSAGES` itself stays private — its values are user-facing copy, not a
 * contract — so the array is the export and every member of it is checked to
 * build a real failure with real copy.
 */
describe('PROXY_ERROR_CODES', () => {
  /** The twelve names the PRD's `hl()` contract lists, and no thirteenth. */
  it('is exactly the twelve codes the contract names', () => {
    expect([...PROXY_ERROR_CODES].sort()).toEqual(
      [
        'route_not_allowed',
        'route_disabled',
        'invalid_path',
        'hl_reconnect_required',
        'hl_not_connected',
        'hl_forbidden',
        'hl_not_found',
        'hl_rate_limited',
        'hl_bad_request',
        'hl_unavailable',
        'hl_timeout',
        'hl_too_large',
      ].sort(),
    )
  })

  /*
   * The array cannot disagree with the copy table, because every member of it is
   * used to look one up. A code in the array with no message would answer an
   * empty string to a user; a message with no code would be unreachable copy.
   */
  it('carries a non-empty user-facing message for every member', () => {
    for (const code of PROXY_ERROR_CODES) {
      expect(proxyError(400, code).message).not.toBe('')
      expect(proxyError(400, code).code).toBe(code)
    }
  })

  /* No duplicates: it is the key set of an object, and a scan over it is a scan. */
  it('names each code once', () => {
    expect(new Set(PROXY_ERROR_CODES).size).toBe(PROXY_ERROR_CODES.length)
  })
})
