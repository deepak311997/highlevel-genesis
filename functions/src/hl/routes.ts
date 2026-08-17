import { hlApiBase } from './config'

/**
 * The HighLevel allowlist — one table, three consumers.
 *
 * The rows are **data**, exported, and deliberately not a `switch`: the proxy
 * matches against them, Slice 9 renders them into the system prompt's
 * cheat-sheet, and Slice 13's README renders them again (PRD D2). A table that
 * is data can be rendered three ways; a table that is control flow can be
 * rendered once and restated twice.
 *
 * ## The structural claim (D6)
 *
 * A generated app reaches HighLevel only through this file, so the matcher is
 * the whole of the confused-deputy fix. The property it is built to give is
 * stronger than filtering: the upstream URL is assembled by substituting
 * validated parameters into the **matched row's own pattern**, so no substring
 * of the caller's raw path can appear in it. `..`, `%2F`, `//`, an absolute URL,
 * an `@` userinfo trick and a fragment are therefore not *rejected* — they are
 * unrepresentable.
 *
 * Two consequences worth stating where they are implemented:
 *
 * - Parameters are validated **undecoded**. A legal HighLevel id contains no
 *   `%`, so `%2E%2E%2F` fails the grammar as written rather than becoming `../`
 *   after a decode we would then have to re-check.
 * - Specificity is **computed, never read off the table**. `/calendars/events`
 *   and `/calendars/:calendarId` are the same shape, and a matcher that took the
 *   first row to fit would be correct only by the order somebody typed the rows
 *   in.
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
 * A discriminated union rather than `HlRoute | undefined`, because the two
 * refusals answer with different statuses: a shape no row has is `403
 * route_not_allowed` (the path may well exist at HighLevel and we are declining
 * to reach it), while a parameter outside the grammar is `400 invalid_path`.
 */
export type RouteMatch =
  | { kind: 'matched'; row: HlRoute; params: Record<string, string> }
  | { kind: 'not_allowed' }
  | { kind: 'invalid_path' }

/**
 * The thirteen rows F7.1 asks for, mapped onto HIGHLEVEL_PLATFORM.md §6's
 * verified paths.
 *
 * `locationIn` is per row because HighLevel is not consistent about it and the
 * inconsistency is load-bearing: `/contacts/search` with `locationId` in the
 * query answers 4xx, and `/calendars/` without it answers someone else's idea of
 * "all". Encoding it in the same table that authorises the row means the two can
 * never disagree.
 *
 * `DELETE /contacts/:contactId`, `POST /contacts/upsert`,
 * `POST /calendars/events/appointments` and `GET /locations/:id` are absent on
 * purpose (D4). The scopes for the first and third are granted, so this is an
 * allowlist decision rather than a capability we lack — which is the point of
 * having one.
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
   * Sends a real SMS or email. It costs money and reaches a real person, so the
   * row exists — F7.1 names "send" and the ledger grades it — and is refused
   * unless `HL_ALLOW_MESSAGE_SEND` is set, which it is in no environment
   * including the test suite (D5, R5).
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
 * The parameter grammar — **the same shape as `projectIdSchema`'s**, and a
 * second copy of it on purpose.
 *
 * Shared would be wrong: that rule describes a Genesis project id, this one
 * describes a HighLevel record id, and they are two namespaces that happen to
 * agree today. Coupling them would mean a future widening on one side silently
 * widening what may be substituted into an upstream URL, which is the one place
 * in this codebase a widening must be deliberate.
 *
 * HighLevel ids are 20–24 character alphanumerics. Excluding `/`, `.`, `%` and
 * every other URL metacharacter by construction is what makes the re-encoding in
 * {@link buildUpstreamUrl} total rather than best-effort.
 */
const PARAM = /^[A-Za-z0-9_-]{1,64}$/

export function isLegalParam(value: string): boolean {
  return PARAM.test(value)
}

/**
 * Split a path into segments, with **exactly one** trailing slash removed.
 *
 * Removing one is what makes `/calendars` and `/calendars/` the same request
 * (AC-7). Removing more — or dropping empty segments generally — would quietly
 * turn `/contacts//` into a legal one-segment path; keeping the interior empty
 * means it arrives at the grammar as an empty parameter and is refused there.
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
 * Literal beats parameter at the earliest position they differ.
 *
 * Computed from the patterns, never read off the table, which is what makes the
 * result identical against a reversed copy of it (AC-4, R4).
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
 * ## Shape first, method second — and that ordering is the point
 *
 * Candidates are gathered **across every method**, ranked by specificity, and
 * only then filtered to the caller's method. The alternative — filter by method
 * first — makes `GET /contacts/search` match `GET /contacts/:contactId` with the
 * parameter `search`, because `search` is a perfectly legal id shape. That is a
 * request for a contact nobody has, forwarded to HighLevel, in place of the
 * refusal AC-3 asks for. Ranking the shape first means a segment some row
 * spells out as a literal can never be swallowed by another row's parameter, and
 * a path that exists on the table under a different method is refused as
 * `not_allowed` rather than reinterpreted.
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

  // Everything tied with the winner on specificity. Rows differing only by
  // method — `GET`/`PUT /contacts/:contactId` — are one class, and the caller's
  // method picks within it.
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
 * The environment is an *argument* so this module stays pure and testable and
 * Slice 9 can import the table without dragging `process.env` in; `proxy.ts`
 * passes `process.env`. Exactly `'true'` enables — see `hlAllowMessageSend`'s
 * comment for why nothing looser will do.
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
 * An exact-key `delete` does not deliver P1's sentence. HTTP header and query
 * parsers are widely case-insensitive, and `qs` — which Nest, and so HighLevel,
 * parses queries with — folds `locationId[]=x` and `locationId[0]=x` back into
 * the same field. So the three spellings that survive an exact match are
 * precisely the three a caller trying to smuggle a location would reach for.
 *
 * Exact-or-bracketed rather than a prefix test, so a genuine field that merely
 * begins the same way — `locationIdentifier` — is not swallowed with them. We
 * do not control HighLevel's field list and must not delete from it by guess.
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
 * {@link matchRoute} produces, plus parameters it re-checks against the grammar
 * itself. There is no overload that accepts a path, so "the caller's path was
 * concatenated onto the base" is not a mistake this module can make — which is
 * the whole of D6.
 *
 * The re-check looks redundant next to `matchRoute`'s, and is not: a claim that
 * holds only because the one caller today is careful is not a structural claim.
 * It is also what keeps `URL` from silently normalising a `..` segment away.
 *
 * `locationId` is deleted from the caller's query on **every** row and re-added
 * only where the row asks for it (P1, D8). A caller-supplied location therefore
 * never reaches HighLevel, on any route, rather than being overridden on the
 * rows we happened to think about.
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
  // repeated parameter or bracket syntax back to what the caller sent, and D12
  // promises verbatim forwarding.
  const query = new URLSearchParams(rawQuery)
  for (const name of [...new Set(query.keys())]) {
    if (isLocationKey(name)) query.delete(name)
  }
  if (row.locationIn === 'query') query.set(LOCATION_KEY, locationId)
  url.search = query.toString()

  return url
}

/**
 * The upstream body — the caller's, opaquely, with `locationId` ours (D11).
 *
 * Not validated against a schema. Parse-don't-validate governs *our* boundary;
 * this body's boundary is HighLevel's, and a per-route Zod mirror of their
 * filter DSL would be a second copy of an API we do not control, stale on their
 * next release and rejecting valid fields a correct generated app used. The
 * allowlist is the security control, and it has already decided this endpoint
 * may be reached.
 *
 * A non-object body is forwarded untouched, arrays included: there is no
 * top-level `locationId` to reserve on one, and re-serialising it would be the
 * re-shaping D17 refuses.
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
