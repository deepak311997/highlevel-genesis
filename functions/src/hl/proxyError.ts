import { HlRequestError } from './exchange'
import { HttpError } from '../lib/errors'
import { HlNotConnectedError, HlReconnectRequiredError, HlRefreshUnavailableError } from './token'

/**
 * Every way a proxied call can fail, turned into one of our conditions.
 *
 * Pure and separate from the handler, because this is the half a reader has to
 * check against the failure table line by line.
 *
 * **The proxy never answers 401.** `apiClient` reads a 401 as "your session
 * died", so mirroring HighLevel's would sign the user out of Genesis because
 * their *CRM* token was revoked. A HighLevel 401 becomes `409
 * hl_reconnect_required`, which is both true and actionable: with proactive skew
 * a 401 is never an expiry we should have caught, it is a revoked install or a
 * removed scope.
 *
 * `detail` may carry upstream's own text about the *request*, truncated — never
 * ours about our internals, and never a field we went looking for.
 */

/** Long enough for a real upstream message, short enough to exclude a page. */
const DETAIL_MAX = 200

/**
 * The largest body worth parsing to find a two-hundred-character message.
 *
 * Every failing response arrives here and may be 5 MiB. Parsing megabytes to read
 * `message` would make the *error* path the most expensive path through the proxy
 * — around 12 ms of CPU and 10 MiB of heap on a 5 MiB body. 64 KiB is roughly
 * 700× the largest recorded HighLevel error body.
 */
const PARSEABLE_MAX = 64 * 1024

/**
 * The user-facing copy, in one map beside the codes: "does every failure have a
 * message a user could act on?" is a question about the set.
 */
const MESSAGES = {
  route_not_allowed: 'That Genesis CRM route is not available.',
  route_disabled: 'That Genesis CRM route is switched off in this environment.',
  invalid_path: 'That is not a Genesis CRM route this app can call.',
  hl_reconnect_required: 'Your HighLevel connection expired.',
  hl_not_connected: 'No HighLevel account is connected.',
  hl_forbidden: 'HighLevel refused that request for this account.',
  hl_not_found: 'HighLevel could not find that record.',
  hl_rate_limited: 'HighLevel is rate-limiting this account. Try again shortly.',
  hl_bad_request: 'HighLevel rejected that request.',
  hl_unavailable: 'HighLevel is not responding. Try again.',
  hl_timeout: 'HighLevel took too long to answer.',
  hl_too_large: 'That HighLevel response was too large.',
} as const

export type ProxyErrorCode = keyof typeof MESSAGES

/**
 * The same set, as **data** — one table, two consumers.
 *
 * The cheat-sheet has to name every code a rejected `hl()` call can carry, and a
 * hand-written list would drift invisibly: generated code branching on a `code`
 * that no longer exists simply never runs that branch. `MESSAGES` itself stays
 * private, because its values are user-facing copy.
 */
export const PROXY_ERROR_CODES = Object.keys(MESSAGES) as readonly ProxyErrorCode[]

/** Build one of our failures from its code, with upstream's text attached. */
export function proxyError(status: number, code: ProxyErrorCode, detail?: string): HttpError {
  return new HttpError(status, MESSAGES[code], code, detail)
}

/**
 * The three refusals the allowlist itself issues, and their statuses.
 *
 * `403` rather than `404` for the route refusals, because the path may well exist
 * at HighLevel and we are declining to reach it — a 404 sends a generated app
 * looking for a typo. `route_disabled` is deliberately not `route_not_allowed`: a
 * caller that cannot tell them apart cannot tell a policy from an omission.
 */
const ROUTE_STATUS = {
  route_not_allowed: 403,
  route_disabled: 403,
  invalid_path: 400,
} as const

export type RouteRefusalCode = keyof typeof ROUTE_STATUS

/**
 * A refusal decided by the table, before any Firestore read or upstream call.
 * Here rather than in the handler, so every copy string and status this surface
 * can answer with is readable in one file.
 */
export function routeRefusal(code: RouteRefusalCode): HttpError {
  return new HttpError(ROUTE_STATUS[code], MESSAGES[code], code)
}

/**
 * HighLevel's own message, or nothing. `message` first because that is the field
 * their errors use, then the two OAuth-shaped fields. Anything unparseable, or a
 * value that is not a string, yields nothing rather than `"[object Object]"`.
 */
export function detailFrom(raw: string): string | undefined {
  if (raw.length > PARSEABLE_MAX) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined

  const body = parsed as Record<string, unknown>
  for (const field of ['message', 'error_description', 'error']) {
    const value = body[field]
    if (typeof value === 'string' && value !== '') return value.slice(0, DETAIL_MAX)
  }
  return undefined
}

/** The PRD's upstream-status table, and nothing else. */
export function mapUpstreamStatus(status: number, raw: string): HttpError {
  const detail = detailFrom(raw)

  if (status === 401) return proxyError(409, 'hl_reconnect_required', detail)
  if (status === 403) return proxyError(403, 'hl_forbidden', detail)
  if (status === 404) return proxyError(404, 'hl_not_found', detail)
  if (status === 429) return proxyError(429, 'hl_rate_limited', detail)
  if (status >= 400 && status < 500) return proxyError(400, 'hl_bad_request', detail)
  return proxyError(502, 'hl_unavailable', detail)
}

/**
 * A token-resolution failure, mapped. Rethrows what it does not recognise rather
 * than flattening it to a 500 — an unrecognised error is not a token condition,
 * and swallowing it would leave the terminal handler with nothing to log.
 */
export function mapTokenError(err: unknown): HttpError {
  if (err instanceof HlNotConnectedError) return proxyError(409, 'hl_not_connected')
  if (err instanceof HlReconnectRequiredError) return proxyError(409, 'hl_reconnect_required')
  if (err instanceof HlRefreshUnavailableError) return proxyError(502, 'hl_unavailable')
  throw err
}

/**
 * The upstream call outlived its timeout.
 *
 * A distinct class rather than an inspection of `fetch`'s `AbortError`, because an
 * abort is also how the size cap stops a read: indistinguishable from the
 * exception alone, and they map to different statuses.
 */
export class UpstreamTimeoutError extends Error {
  constructor() {
    super('HighLevel took too long to answer.')
    this.name = 'UpstreamTimeoutError'
  }
}

/** The upstream body passed the 5 MiB cap and the read was abandoned (D27). */
export class UpstreamTooLargeError extends Error {
  constructor() {
    super('That HighLevel response was too large.')
    this.name = 'UpstreamTooLargeError'
  }
}

/**
 * A failure of the call itself, as distinct from a status it answered with. The
 * tail is `502 hl_unavailable` rather than a rethrow: every remaining possibility
 * is network-shaped, and each means the same thing to a caller.
 */
export function mapForwardError(err: unknown): HttpError {
  if (err instanceof UpstreamTimeoutError) return proxyError(504, 'hl_timeout')
  if (err instanceof UpstreamTooLargeError) return proxyError(502, 'hl_too_large')
  return proxyError(502, 'hl_unavailable')
}

/**
 * Whether a failed refresh means the grant is dead — **only `invalid_grant` on a
 * 400**. Never destroy a refresh token that may still be valid: a 500, a network
 * error and a timeout are transient by definition, and the asymmetry is what keeps
 * a HighLevel blip from being recorded as a dead connection.
 */
export function isDefinitiveRefreshFailure(err: unknown): boolean {
  if (!(err instanceof HlRequestError)) return false
  return err.status === 400 && err.body.includes('invalid_grant')
}
