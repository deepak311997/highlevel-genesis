import { describe, expect, it } from 'vitest'

import { hlApiBase } from './config'
import {
  buildUpstreamBody,
  buildUpstreamUrl,
  HL_ROUTES,
  isLegalParam,
  isRouteEnabled,
  matchRoute,
  type HlRoute,
} from './routes'

/** The connection's location — the only one that is ever injected (D10). */
const LOCATION = 'lUanVn0CtZJTlymH8ySo'

/**
 * The allowlist, and the matcher that is the whole of the confused-deputy fix.
 *
 * Most of this file is written as **refusals**, because that is where the security property
 * lives: a matcher that is subtly too permissive — a greedy parameter that swallows a `/`, a
 * prefix match where an exact match was meant — reopens every endpoint HighLevel serves to
 * generated code.
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
   * The four D4 exclusions, asserted on the table itself rather than only through the matcher: a
   * row added by accident would be caught here even if nothing ever called it.
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

  /* AC-3 — the path is on the table; this method is not on that row. */
  it.each([
    ['GET', '/contacts/search'],
    ['DELETE', '/calendars/'],
    ['GET', '/conversations/messages'],
  ] as const)('refuses %s %s — the right path with the wrong method', (method, path) => {
    expect(matchRoute(method, path)).toEqual({ kind: 'not_allowed' })
  })

  /*
   * Run against a reversed copy as well as the real table, because the specificity rule is the
   * property under test and "the rows happen to be in a lucky order" is not that property.
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
   * A slash inside a parameter is not a bad parameter — it is two segments, so it cannot reach
   * the grammar at all.
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

/**
 * Assembling the upstream request.
 *
 * AC-6 is asserted on the **assembled URL** rather than on the match, because the match is not
 * the property that matters: a matcher can be right and a handler can still concatenate the
 * caller's path onto a base and undo all of it. What is tested here is that there is no way to
 * express that mistake — the URL is a compile-time template plus `[A-Za-z0-9_-]` parameters, and
 * nothing else.
 */
describe('buildUpstreamUrl', () => {
  function matched(
    method: HlRoute['method'],
    path: string,
  ): {
    row: HlRoute
    params: Record<string, string>
  } {
    const match = matchRoute(method, path)
    if (match.kind !== 'matched') throw new Error(`${method} ${path} did not match`)
    return { row: match.row, params: match.params }
  }

  // AC-6 — every row, from its own template.
  it.each(Object.entries(CONCRETE))('assembles %s from the row template', (name, path) => {
    const method = name.split(' ')[0] as HlRoute['method']
    const { row, params } = matched(method, path)

    const url = buildUpstreamUrl(row, params, '', LOCATION)

    expect(url.href.startsWith(hlApiBase())).toBe(true)
    expect(url.pathname).toBe(
      row.pattern.replace(/:(\w+)/g, (_m, key: string) => encodeURIComponent(params[key] ?? '')),
    )
  })

  /*
   * The total form of D6. `matchRoute` can never hand this over — the grammar refuses `..` — but
   * the claim is that the URL cannot be built from a caller-supplied string *at all*, and a
   * claim that depends on its only caller being careful is not structural.
   */
  it('refuses to assemble a URL from a parameter outside the grammar', () => {
    const { row } = matched('GET', '/contacts/JwwI60NJqfc8I4Ay2MiA')

    expect(() => buildUpstreamUrl(row, { contactId: '../../oauth/token' }, '', LOCATION)).toThrow()
    expect(() => buildUpstreamUrl(row, { contactId: '..' }, '', LOCATION)).toThrow()
  })

  // AC-7, second half.
  it.each(['/calendars', '/calendars/'])('assembles /calendars/ from %s', (path) => {
    const { row, params } = matched('GET', path)

    expect(buildUpstreamUrl(row, params, '', LOCATION).pathname).toBe('/calendars/')
  })

  /*
   * AC-9. Our location wins, once, and nothing else about the caller's query is
   * touched — including a repeated parameter, which is why the raw query string
   * is carried rather than Express's qs-parsed `req.query` (P3, D12).
   */
  it('writes our locationId into the query, leaving unrelated parameters alone', () => {
    const { row, params } = matched('GET', '/calendars/')

    const url = buildUpstreamUrl(
      row,
      params,
      'locationId=someone-else&limit=5&showDrafted=true',
      LOCATION,
    )

    expect(url.searchParams.getAll('locationId')).toEqual([LOCATION])
    expect(url.searchParams.get('limit')).toBe('5')
    expect(url.searchParams.get('showDrafted')).toBe('true')
  })

  it('round-trips a repeated query parameter', () => {
    const { row, params } = matched('GET', '/conversations/search')

    const url = buildUpstreamUrl(row, params, 'tag=a&tag=b', LOCATION)

    expect(url.searchParams.getAll('tag')).toEqual(['a', 'b'])
  })

  /*
   * AC-10, and P1's stronger form: `locationId` is a reserved key on *every* row, so a caller-
   * supplied one never reaches HighLevel even where we inject nothing of our own.
   */
  it('adds no locationId on a row that takes none, and removes the caller’s', () => {
    const { row, params } = matched('GET', '/contacts/JwwI60NJqfc8I4Ay2MiA')

    const url = buildUpstreamUrl(row, params, 'locationId=someone-else&fields=email', LOCATION)

    expect(url.searchParams.has('locationId')).toBe(false)
    expect(url.searchParams.get('fields')).toBe('email')
  })

  /*
   * P1's claim is "a caller-supplied location never reaches HighLevel, on any route" — and an
   * exact-key `delete` does not deliver it.
   */
  it('drops a locationId however the caller spelled it', () => {
    const { row, params } = matched('GET', '/calendars/')

    const url = buildUpstreamUrl(
      row,
      params,
      'LocationId=theirs&locationId[]=theirs&locationId[0]=theirs&LOCATIONID=theirs&limit=5',
      LOCATION,
    )

    expect(url.search).not.toContain('theirs')
    expect(url.searchParams.getAll('locationId')).toEqual([LOCATION])
    expect(url.searchParams.get('limit')).toBe('5')
  })

  it('leaves a field that merely begins the same way', () => {
    const { row, params } = matched('GET', '/calendars/')

    const url = buildUpstreamUrl(row, params, 'locationIdentifier=keep-me', LOCATION)

    expect(url.searchParams.get('locationIdentifier')).toBe('keep-me')
  })
})

describe('buildUpstreamBody', () => {
  function rowFor(pattern: string): HlRoute {
    const row = HL_ROUTES.find((r) => r.pattern === pattern)
    if (row === undefined) throw new Error(`no row for ${pattern}`)
    return row
  }

  // AC-8.
  it('writes our locationId over the caller’s, leaving every other field', () => {
    const body = { locationId: 'someone-else', pageLimit: 1, filters: [{ field: 'email' }] }

    const out = buildUpstreamBody(rowFor('/contacts/search'), body, LOCATION) as Record<
      string,
      unknown
    >

    expect(out['locationId']).toBe(LOCATION)
    expect(out['pageLimit']).toBe(1)
    expect(out['filters']).toEqual([{ field: 'email' }])
  })

  it('leaves the caller’s own object alone', () => {
    const body = { locationId: 'someone-else' }

    buildUpstreamBody(rowFor('/contacts/search'), body, LOCATION)

    expect(body.locationId).toBe('someone-else')
  })

  // AC-10 in the body, again in P1's stronger form.
  it('removes a locationId on a row that takes none', () => {
    const out = buildUpstreamBody(
      rowFor('/conversations/messages'),
      { locationId: 'someone-else', type: 'SMS' },
      LOCATION,
    ) as Record<string, unknown>

    expect(out).toEqual({ type: 'SMS' })
  })

  it('drops a body locationId however the caller spelled it', () => {
    const out = buildUpstreamBody(
      rowFor('/contacts/search'),
      { LocationId: 'theirs', 'locationId[]': 'theirs', locationIdentifier: 'keep-me', page: 1 },
      LOCATION,
    ) as Record<string, unknown>

    expect(out).toEqual({ locationId: LOCATION, locationIdentifier: 'keep-me', page: 1 })
  })

  it.each([['a string'], [42], [null], [['an', 'array']]])(
    'forwards a non-object body (%s) unchanged',
    (body) => {
      expect(buildUpstreamBody(rowFor('/contacts/search'), body, LOCATION)).toEqual(body)
    },
  )
})

/**
 * AC-21's enabled half, at L1.
 *
 * The functions emulator's environment is fixed for the whole `emulators:exec`
 * run, so a shell value that turns the flag on turns it on for *every* case in
 * the integration suite — including the one that has to prove the default is
 * off. The safety-critical direction keeps its wire test; this is the other one.
 */
describe('isRouteEnabled', () => {
  function rowFor(pattern: string): HlRoute {
    const row = HL_ROUTES.find((r) => r.pattern === pattern)
    if (row === undefined) throw new Error(`no row for ${pattern}`)
    return row
  }

  const send = rowFor('/conversations/messages')
  const search = rowFor('/contacts/search')

  it('leaves an unflagged row enabled whatever the environment says', () => {
    expect(isRouteEnabled(search, {})).toBe(true)
    expect(isRouteEnabled(search, { HL_ALLOW_MESSAGE_SEND: 'false' })).toBe(true)
  })

  /*
   * Exactly `'true'`, and nothing else. A looser reading — "anything but empty", or a truthiness
   * check — turns a stray `HL_ALLOW_MESSAGE_SEND=0` in somebody's shell into a switch that is
   * on, for a route that sends a real SMS or email.
   */
  it.each([
    {},
    { HL_ALLOW_MESSAGE_SEND: '' },
    { HL_ALLOW_MESSAGE_SEND: '   ' },
    { HL_ALLOW_MESSAGE_SEND: 'false' },
    { HL_ALLOW_MESSAGE_SEND: '0' },
    { HL_ALLOW_MESSAGE_SEND: '1' },
    { HL_ALLOW_MESSAGE_SEND: 'no' },
    { HL_ALLOW_MESSAGE_SEND: 'yes' },
    { HL_ALLOW_MESSAGE_SEND: 'TRUE' },
  ])('keeps a flagged row disabled for %o', (env) => {
    expect(isRouteEnabled(send, env)).toBe(false)
  })

  it('enables a flagged row only when its variable is exactly true', () => {
    expect(isRouteEnabled(send, { HL_ALLOW_MESSAGE_SEND: 'true' })).toBe(true)
  })
})
