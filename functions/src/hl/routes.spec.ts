import { describe, expect, it } from 'vitest'

import { HL_ROUTES, isLegalParam, matchRoute, type HlRoute } from './routes'

/**
 * The allowlist, and the matcher that is the whole of the confused-deputy fix.
 *
 * Most of this file is written as **refusals**, because that is where the
 * security property lives: a matcher that is subtly too permissive — a greedy
 * parameter that swallows a `/`, a prefix match where an exact match was meant —
 * reopens every endpoint HighLevel serves to generated code (R3).
 *
 * The ordering cases matter for the same reason. `/calendars/events` and
 * `/calendars/:calendarId` are the same shape, so whichever the matcher happens
 * to try first wins; a test written from the table's own order would pass
 * against a matcher that is only accidentally right. Every ordering case here is
 * therefore run twice, once against a reversed copy of the table (AC-4).
 */

/** One legal concrete path per row, in table order. */
const CONCRETE: Record<string, string> = {
  'POST /contacts/search': '/contacts/search',
  'GET /contacts/:contactId': '/contacts/JwwI60NJqfc8I4Ay2MiA',
  'POST /contacts/': '/contacts/',
  'PUT /contacts/:contactId': '/contacts/JwwI60NJqfc8I4Ay2MiA',
  'GET /conversations/search': '/conversations/search',
  'GET /conversations/:conversationId': '/conversations/2TZBqxrjGObOAeuLRRqS',
  'GET /conversations/:conversationId/messages': '/conversations/2TZBqxrjGObOAeuLRRqS/messages',
  'POST /conversations/messages': '/conversations/messages',
  'GET /calendars/': '/calendars/',
  'GET /calendars/:calendarId': '/calendars/2oKn7but6Q2WaHIu7pqC',
  'GET /calendars/events': '/calendars/events',
  'GET /calendars/events/appointments/:eventId':
    '/calendars/events/appointments/sWUUpNfU7obtpdYjy1QI',
  'GET /calendars/:calendarId/free-slots': '/calendars/2oKn7but6Q2WaHIu7pqC/free-slots',
}

function key(row: HlRoute): string {
  return `${row.method} ${row.pattern}`
}

describe('HL_ROUTES', () => {
  it('is the thirteen rows the PRD authorises, and nothing else', () => {
    expect(HL_ROUTES).toHaveLength(13)
  })

  it('names a version and a scope on every row', () => {
    for (const row of HL_ROUTES) {
      expect(row.version).toMatch(/^2021-(07-28|04-15)$/)
      expect(row.scope).not.toBe('')
    }
  })

  /*
   * The four D4 exclusions, asserted on the table itself rather than only
   * through the matcher: a row added by accident would be caught here even if
   * nothing ever called it.
   */
  it('carries none of the routes deliberately left off it', () => {
    const keys = HL_ROUTES.map(key)

    expect(keys).not.toContain('DELETE /contacts/:contactId')
    expect(keys).not.toContain('POST /contacts/upsert')
    expect(keys).not.toContain('POST /calendars/events/appointments')
    expect(keys).not.toContain('GET /locations/:locationId')
  })
})

describe('matchRoute', () => {
  // AC-1 — every row is reachable, with the facts the proxy needs intact.
  it.each(HL_ROUTES.map((row) => [key(row), row] as const))(
    'matches %s with its version, scope and locationIn intact',
    (name, row) => {
      const path = CONCRETE[name]
      expect(path, `no concrete path for ${name}`).toBeDefined()

      const match = matchRoute(row.method, path ?? '')

      expect(match.kind).toBe('matched')
      if (match.kind !== 'matched') return
      expect(match.row.pattern).toBe(row.pattern)
      expect(match.row.version).toBe(row.version)
      expect(match.row.scope).toBe(row.scope)
      expect(match.row.locationIn).toBe(row.locationIn)
    },
  )

  // AC-2 — the exclusions, over the wire-shaped input the proxy will hand it.
  it.each([
    ['DELETE', '/contacts/abc123'],
    ['POST', '/contacts/upsert'],
    ['POST', '/calendars/events/appointments'],
    ['GET', '/locations/abc123'],
    ['GET', '/users/'],
    ['GET', '/'],
  ] as const)('refuses %s %s, which is not on the table', (method, path) => {
    expect(matchRoute(method, path)).toEqual({ kind: 'not_allowed' })
  })

  /*
   * AC-3 — the path is on the table; this method is not on that row.
   *
   * `GET /contacts/search` is the case worth naming. `search` is a perfectly
   * legal id shape, so a matcher that filtered by method before ranking by
   * specificity would answer `GET /contacts/:contactId` here and forward a
   * lookup for a contact nobody has. A literal spelled out by any row wins its
   * position outright, and the method then picks within that class.
   */
  it.each([
    ['GET', '/contacts/search'],
    ['DELETE', '/calendars/'],
    ['GET', '/conversations/messages'],
  ] as const)('refuses %s %s — the right path with the wrong method', (method, path) => {
    expect(matchRoute(method, path)).toEqual({ kind: 'not_allowed' })
  })

  /*
   * AC-4. Run against a reversed copy as well as the real table, because the
   * specificity rule is the property under test and "the rows happen to be in a
   * lucky order" is not that property.
   */
  describe.each([
    ['the table as written', HL_ROUTES],
    ['a reversed copy of the table', [...HL_ROUTES].reverse()],
  ] as const)('given %s', (_name, table) => {
    it('prefers the literal segment to the parameter', () => {
      const events = matchRoute('GET', '/calendars/events', table)
      const one = matchRoute('GET', '/calendars/2oKn7but6Q2WaHIu7pqC', table)

      expect(events.kind === 'matched' && events.row.pattern).toBe('/calendars/events')
      expect(one.kind === 'matched' && one.row.pattern).toBe('/calendars/:calendarId')
    })

    it('extracts the parameter from the row it chose', () => {
      const one = matchRoute('GET', '/calendars/2oKn7but6Q2WaHIu7pqC', table)

      expect(one.kind === 'matched' && one.params).toEqual({ calendarId: '2oKn7but6Q2WaHIu7pqC' })
    })
  })

  /*
   * AC-5, the grammar. Every value here sits in a *parameter* position, so it
   * reaches the grammar and is refused by it — undecoded, deliberately: a legal
   * HighLevel id contains no `%`, so `%2E%2E%2F` fails as written rather than
   * becoming `../` after a decode we would then have to re-check.
   */
  it.each([
    ['..', '/contacts/..'],
    ['a percent-encoded slash', '/contacts/a%2Fb'],
    ['sixty-five characters', `/contacts/${'a'.repeat(65)}`],
    ['an empty segment', '/contacts//'],
    ['a dot', '/contacts/abc.123'],
  ] as const)('refuses %s as a path parameter', (_name, path) => {
    expect(matchRoute('GET', path)).toEqual({ kind: 'invalid_path' })
  })

  /*
   * A slash inside a parameter is not a bad parameter — it is two segments, so
   * it cannot reach the grammar at all. It is refused one step earlier, as a
   * shape no row has, which is the stronger refusal: `not_allowed` happens
   * before any Firestore read. Asserted here so the distinction is deliberate
   * rather than discovered.
   */
  it('refuses a slash inside a parameter as a shape no row has', () => {
    expect(matchRoute('GET', '/contacts/a/b')).toEqual({ kind: 'not_allowed' })
  })

  it.each(['..', 'a/b', 'a%2Fb', 'a'.repeat(65), '', 'abc.123'])(
    'holds %s outside the parameter grammar',
    (value) => {
      expect(isLegalParam(value)).toBe(false)
    },
  )

  it.each(['JwwI60NJqfc8I4Ay2MiA', 'a', 'A-Z_0-9', 'a'.repeat(64)])(
    'holds %s inside the parameter grammar',
    (value) => {
      expect(isLegalParam(value)).toBe(true)
    },
  )

  // AC-7, first half. `/calendars` and `/calendars/` are one request.
  it.each(['/calendars', '/calendars/'])('normalises the trailing slash on %s', (path) => {
    const match = matchRoute('GET', path)

    expect(match.kind === 'matched' && match.row.pattern).toBe('/calendars/')
  })

  it('normalises the trailing slash on a create as well', () => {
    const match = matchRoute('POST', '/contacts')

    expect(match.kind === 'matched' && match.row.pattern).toBe('/contacts/')
  })
})
