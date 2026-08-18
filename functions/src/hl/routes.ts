import { hlApiBase } from './config'

/**
 * The HighLevel allowlist — one table, three consumers.
 *
 * The rows are **data**, not a `switch`: the proxy matches against them, the
 * system prompt's cheat-sheet renders them, and the README renders them again. A
 * table that is data can be rendered three ways.
 *
 * **A generated app reaches HighLevel only through this file**, and the property
 * is stronger than filtering: the upstream URL is assembled by substituting
 * validated parameters into the matched row's **own pattern**, so no substring of
 * the caller's raw path can appear in it. `..`, `%2F`, `//`, an absolute URL and
 * an `@` userinfo trick are not rejected — they are unrepresentable.
 *
 * Two consequences, implemented below: parameters are validated **undecoded** (a
 * legal HighLevel id contains no `%`, so `%2E%2E%2F` fails the grammar as written
 * rather than after a decode we would have to re-check), and specificity is
 * **computed, never read off the table** — `/calendars/events` and
 * `/calendars/:calendarId` are the same shape, and taking the first row to fit
 * would be correct only by the order somebody typed them in.
 */

/** A row of the allowlist. `:name` marks a path parameter. */
export interface HlRoute {
  method: 'GET' | 'POST' | 'PUT'
  /** The HighLevel path, exactly as sent upstream. */
  pattern: string
  version: '2021-07-28' | '2021-04-15'
  scope: string
  /** Where the connection's `locationId` is injected, if anywhere. */
  locationIn: 'query' | 'body' | null
  /** Set on a row that is refused unless this environment variable is `true`. */
  flag?: 'HL_ALLOW_MESSAGE_SEND'
}

/**
 * A discriminated union rather than `HlRoute | undefined`: a shape no row has is
 * `403 route_not_allowed` — the path may well exist at HighLevel and we are
 * declining to reach it — while a parameter outside the grammar is `400
 * invalid_path`.
 */
export type RouteMatch =
  | { kind: 'matched'; row: HlRoute; params: Record<string, string> }
  | { kind: 'not_allowed' }
  | { kind: 'invalid_path' }

/**
 * The rows, mapped onto the platform doc's verified paths.
 *
 * `locationIn` is per row because HighLevel is not consistent about it and the
 * inconsistency is load-bearing: `/contacts/search` with `locationId` in the
 * query answers 4xx, and `/calendars/` without it answers someone else's idea of
 * "all". Encoding it in the table that authorises the row means the two cannot
 * disagree.
 *
 * `DELETE /contacts/:contactId`, `POST /contacts/upsert` and
 * `POST /calendars/events/appointments` are absent on purpose: their scopes are
 * granted, so this is an allowlist decision rather than a capability we lack.
 */
export const HL_ROUTES: readonly HlRoute[] = [
  {
    method: 'POST',
    pattern: '/contacts/search',
    version: '2021-07-28',
    scope: 'contacts.readonly',
    locationIn: 'body',
  },
  {
    method: 'GET',
    pattern: '/contacts/:contactId',
    version: '2021-07-28',
    scope: 'contacts.readonly',
    locationIn: null,
  },
  {
    method: 'POST',
    pattern: '/contacts/',
    version: '2021-07-28',
    scope: 'contacts.write',
    locationIn: 'body',
  },
  // An update addresses one record by id, and the token is already scoped to
  // the location that record lives in — so there is nowhere to put a location.
  {
    method: 'PUT',
    pattern: '/contacts/:contactId',
    version: '2021-07-28',
    scope: 'contacts.write',
    locationIn: null,
  },
  {
    method: 'GET',
    pattern: '/conversations/search',
    version: '2021-04-15',
    scope: 'conversations.readonly',
    locationIn: 'query',
  },
  {
    method: 'GET',
    pattern: '/conversations/:conversationId',
    version: '2021-04-15',
    scope: 'conversations.readonly',
    locationIn: null,
  },
  {
    method: 'GET',
    pattern: '/conversations/:conversationId/messages',
    version: '2021-04-15',
    scope: 'conversations/message.readonly',
    locationIn: null,
  },
  /*
   * Sends a real SMS or email — it costs money and reaches a real person, so the
   * row exists and is refused unless `HL_ALLOW_MESSAGE_SEND` is set, which it is
   * in no environment including the test suite.
   */
  {
    method: 'POST',
    pattern: '/conversations/messages',
    version: '2021-04-15',
    scope: 'conversations/message.write',
    locationIn: null,
    flag: 'HL_ALLOW_MESSAGE_SEND',
  },
  {
    method: 'GET',
    pattern: '/calendars/',
    version: '2021-04-15',
    scope: 'calendars.readonly',
    locationIn: 'query',
  },
  {
    method: 'GET',
    pattern: '/calendars/:calendarId',
    version: '2021-04-15',
    scope: 'calendars.readonly',
    locationIn: null,
  },
  {
    method: 'GET',
    pattern: '/calendars/events',
    version: '2021-04-15',
    scope: 'calendars/events.readonly',
    locationIn: 'query',
  },
  {
    method: 'GET',
    pattern: '/calendars/events/appointments/:eventId',
    version: '2021-04-15',
    scope: 'calendars/events.readonly',
    locationIn: null,
  },
  {
    method: 'GET',
    pattern: '/calendars/:calendarId/free-slots',
    version: '2021-04-15',
    scope: 'calendars.readonly',
    locationIn: null,
  },
]

/**
 * The parameter grammar — the same shape as `projectIdSchema`'s, and a second
 * copy of it on purpose: that rule describes a Genesis project id, this one a
 * HighLevel record id, and coupling them would let a future widening on one side
 * silently widen what may be substituted into an upstream URL.
 *
 * Excluding `/`, `.`, `%` and every other URL metacharacter by construction is
 * what makes the re-encoding in {@link buildUpstreamUrl} total.
 */
const PARAM = /^[A-Za-z0-9_-]{1,64}$/

export function isLegalParam(value: string): boolean {
  return PARAM.test(value)
}

/**
 * Split a path into segments, with **exactly one** trailing slash removed, which
 * makes `/calendars` and `/calendars/` the same request. Removing more would turn
 * `/contacts//` into a legal one-segment path; keeping the interior empty means it
 * reaches the grammar as an empty parameter and is refused there.
 */
function segmentsOf(path: string): string[] {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const parts = trimmed.split('/')
  return parts[0] === '' ? parts.slice(1) : parts
}

function isParam(segment: string): boolean {
  return segment.startsWith(':')
}

/**
 * Literal beats parameter at the earliest position they differ — computed from
 * the patterns, so the result is identical against a reversed copy of the table.
 */
function bySpecificity(a: string[], b: string[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const pa = isParam(a[i] ?? '')
    const pb = isParam(b[i] ?? '')
    if (pa !== pb) return pa ? 1 : -1
  }
  return 0
}

/**
 * Which row a method and a path reach, if any.
 *
 * **Shape first, method second**, and that ordering is the point. Filtering by
 * method first makes `GET /contacts/search` match `GET /contacts/:contactId` with
 * the parameter `search`, because `search` is a legal id shape — a request for a
 * contact nobody has, forwarded to HighLevel, in place of a refusal. Ranking the
 * shape first means a literal some row spells out can never be swallowed by
 * another row's parameter.
 */
export function matchRoute(
  method: string,
  path: string,
  table: readonly HlRoute[] = HL_ROUTES,
): RouteMatch {
  const segments = segmentsOf(path)

  const sameShape = table
    .map((row) => ({ row, pattern: segmentsOf(row.pattern) }))
    .filter(
      ({ pattern }) =>
        pattern.length === segments.length &&
        pattern.every((segment, i) => isParam(segment) || segment === segments[i]),
    )
    .sort((a, b) => bySpecificity(a.pattern, b.pattern))

  const best = sameShape[0]
  if (best === undefined) return { kind: 'not_allowed' }

  // Everything tied with the winner on specificity. Rows differing only by method
  // are one class, and the caller's method picks within it.
  const chosen = sameShape
    .filter(({ pattern }) => bySpecificity(pattern, best.pattern) === 0)
    .find(({ row }) => row.method === method)
  if (chosen === undefined) return { kind: 'not_allowed' }

  const params: Record<string, string> = {}
  for (const [i, segment] of chosen.pattern.entries()) {
    if (!isParam(segment)) continue
    const value = segments[i] ?? ''
    if (!isLegalParam(value)) return { kind: 'invalid_path' }
    params[segment.slice(1)] = value
  }

  return { kind: 'matched', row: chosen.row, params }
}

/**
 * Whether a flagged row may be reached, given an environment.
 *
 * The environment is an argument so this module stays pure and importable without
 * dragging `process.env` in. Exactly `'true'` enables.
 */
export function isRouteEnabled(row: HlRoute, env: Record<string, string | undefined>): boolean {
  if (row.flag === undefined) return true
  return env[row.flag]?.trim() === 'true'
}

/** The one query and body key we own on every row (P1). */
const LOCATION_KEY = 'locationId'

/**
 * Whether a caller's key is a `locationId` under another spelling.
 *
 * An exact-key `delete` is not enough: query parsers are widely case-insensitive,
 * and `qs` — which HighLevel parses with — folds `locationId[]=x` and
 * `locationId[0]=x` back into the same field. Those are precisely the spellings a
 * caller smuggling a location would reach for.
 *
 * Exact-or-bracketed rather than a prefix test, so a genuine field that merely
 * begins the same way (`locationIdentifier`) is not swallowed with them.
 */
function isLocationKey(name: string): boolean {
  const lowered = name.toLowerCase()
  return (
    lowered === LOCATION_KEY.toLowerCase() || lowered.startsWith(`${LOCATION_KEY.toLowerCase()}[`)
  )
}

/**
 * The upstream URL, assembled from **the matched row** and never from a string.
 *
 * The signature is the argument: it takes an `HlRoute`, which only
 * {@link matchRoute} produces, plus parameters it re-checks against the grammar.
 * There is no overload accepting a path, so "the caller's path was concatenated
 * onto the base" is not a mistake this module can make.
 *
 * The re-check is not redundant: a claim that holds only because today's one
 * caller is careful is not a structural claim.
 *
 * `locationId` is deleted from the caller's query on **every** row and re-added
 * only where the row asks for it, so a caller-supplied location never reaches
 * HighLevel rather than being overridden on the rows we thought about.
 */
export function buildUpstreamUrl(
  row: HlRoute,
  params: Record<string, string>,
  rawQuery: string,
  locationId: string,
): URL {
  const pathname = row.pattern.replace(/:(\w+)/g, (_match, name: string) => {
    const value = params[name]
    if (value === undefined || !isLegalParam(value)) {
      throw new Error(`Refusing to build an upstream URL from an illegal ${name}`)
    }
    return encodeURIComponent(value)
  })

  const url = new URL(`${hlApiBase()}${pathname}`)

  // The raw query string, not `req.query`: qs parsing cannot round-trip a
  // repeated parameter or bracket syntax back to what the caller sent.
  const query = new URLSearchParams(rawQuery)
  for (const name of [...new Set(query.keys())]) {
    if (isLocationKey(name)) query.delete(name)
  }
  if (row.locationIn === 'query') query.set(LOCATION_KEY, locationId)
  url.search = query.toString()

  return url
}

/**
 * The upstream body — the caller's, opaquely, with `locationId` ours.
 *
 * Not validated against a schema: parse-don't-validate governs *our* boundary,
 * and a per-route mirror of HighLevel's filter DSL would be a second copy of an
 * API we do not control, stale on their next release. The allowlist is the
 * security control, and it has already decided this endpoint may be reached.
 *
 * A non-object body is forwarded untouched, arrays included: there is no
 * top-level `locationId` to reserve on one.
 */
export function buildUpstreamBody(row: HlRoute, body: unknown, locationId: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body

  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) }
  for (const name of Object.keys(out)) {
    if (isLocationKey(name)) Reflect.deleteProperty(out, name)
  }
  if (row.locationIn === 'body') out[LOCATION_KEY] = locationId
  return out
}
