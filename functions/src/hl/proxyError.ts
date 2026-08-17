import { HlRequestError } from './exchange'
import { HttpError } from '../lib/errors'
import { HlNotConnectedError, HlReconnectRequiredError, HlRefreshUnavailableError } from './token'

/**
 * Every way a proxied call can fail, turned into one of our conditions.
 *
 * Pure and separate from the handler on purpose: this is the half of F8.3 a
 * reader has to be able to check against the PRD's failure table line by line,
 * and the half whose one catastrophic mistake is invisible in a handler test.
 *
 * ## The proxy never answers 401 (D20)
 *
 * `apiClient` reads a 401 as "your session died". Mirroring HighLevel's 401
 * would therefore sign the user out of Genesis because their *CRM* token was
 * revoked — two unrelated sessions, one of them perfectly good. A HighLevel 401
 * becomes `409 hl_reconnect_required`, which is both true and actionable: with
 * D25's proactive five-minute skew a 401 is never an expiry we should have
 * caught, it is a revoked install or a removed scope, and both are fixed by
 * reconnecting.
 *
 * ## What `detail` may carry (D19)
 *
 * Upstream's own text about the *request*, truncated. Never ours about our
 * internals, and never a field we went looking for in their body — only the
 * three message fields HighLevel actually uses.
 */

/** Long enough for a real upstream message, short enough to exclude a page. */
const DETAIL_MAX = 200

/**
 * The largest body worth parsing to find a two-hundred-character message.
 *
 * The proxy's cap allows an upstream response of 5 MiB, and every failing one
 * arrives here. Parsing megabytes to read `message` would make the *error* path
 * the most expensive path through the proxy — measurably so, around 12 ms of
 * CPU and 10 MiB of heap on a 5 MiB body — on the one path whose size is chosen
 * by upstream rather than by us.
 *
 * 64 KiB is roughly 700× the largest recorded HighLevel error body
 * (`location-401-missing-scope.json` is 84 bytes). Anything past it is a page,
 * a stack trace or a payload, none of which `detail` may carry anyway.
 */
const PARSEABLE_MAX = 64 * 1024

/**
 * The user-facing copy, in one map beside the codes.
 *
 * F8.3's strings are read together far more often than they are read one at a
 * time — "does every failure have a message a user could act on?" is a question
 * about the set, not about a line in a switch.
 */
const MESSAGES = {
  route_not_allowed: 'That HighLevel route is not available through Genesis.',
  route_disabled: 'That HighLevel route is switched off in this environment.',
  invalid_path: 'That is not a HighLevel path Genesis can forward.',
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
 * The same set, as **data** — one table, two consumers (Slice 9 D5).
 *
 * Slice 9's cheat-sheet has to name every code a rejected `hl()` call can carry,
 * so that generated code can branch on one; a hand-written list in the system
 * prompt would drift on the first code added here, and the drift is invisible —
 * generated code branching on a `code` that no longer exists simply never runs
 * that branch.
 *
 * Derived from `MESSAGES` rather than written out, and `ProxyErrorCode` is
 * derived from the same object, so the array and the type cannot disagree.
 * `MESSAGES` itself stays private: its *values* are user-facing copy, which is
 * this module's business and nobody else's.
 */
export const PROXY_ERROR_CODES = Object.keys(MESSAGES) as readonly ProxyErrorCode[]

/** Build one of our failures from its code, with upstream's text attached. */
export function proxyError(status: number, code: ProxyErrorCode, detail?: string): HttpError {
  return new HttpError(status, MESSAGES[code], code, detail)
}

/**
 * The three refusals the allowlist itself issues, and their statuses.
 *
 * `403` for both route refusals rather than `404`, because 403 states the true
 * reason (D21): the path may well exist at HighLevel and we are declining to
 * reach it, whereas a 404 implies it does not exist and sends a generated app
 * looking for a typo. `route_disabled` is deliberately *not* `route_not_allowed`
 * — the row exists and is safed, and a caller that cannot tell those apart
 * cannot tell a policy from an omission (D5, R5).
 *
 * `400` for `invalid_path`, because the caller sent a path parameter outside the
 * grammar rather than asking for a route we refuse.
 */
const ROUTE_STATUS = {
  route_not_allowed: 403,
  route_disabled: 403,
  invalid_path: 400,
} as const

export type RouteRefusalCode = keyof typeof ROUTE_STATUS

/**
 * A refusal decided by the table, before any Firestore read and any upstream
 * call. Here rather than in the handler so that **every** copy string and every
 * status this surface can answer with is readable in one file (F8.3).
 */
export function routeRefusal(code: RouteRefusalCode): HttpError {
  return new HttpError(ROUTE_STATUS[code], MESSAGES[code], code)
}

/**
 * HighLevel's own message, or nothing.
 *
 * `message` first because that is the field their errors actually use — see
 * `tests/fixtures/highlevel/location-401-missing-scope.json` — then the two
 * OAuth-shaped fields their token endpoint answers with. Anything unparseable,
 * or a value that is not a string, yields nothing rather than
 * `"[object Object]"`.
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
 * A token-resolution failure, mapped.
 *
 * Rethrows anything it does not recognise rather than flattening it to a 500:
 * an unrecognised error is not a token condition, and swallowing it here would
 * leave the terminal handler with nothing to log.
 */
export function mapTokenError(err: unknown): HttpError {
  if (err instanceof HlNotConnectedError) return proxyError(409, 'hl_not_connected')
  if (err instanceof HlReconnectRequiredError) return proxyError(409, 'hl_reconnect_required')
  if (err instanceof HlRefreshUnavailableError) return proxyError(502, 'hl_unavailable')
  throw err
}

/**
 * The upstream call was aborted because it outlived {@link hlUpstreamTimeoutMs}.
 *
 * A distinct class rather than an inspection of the `AbortError` `fetch`
 * raises, because an abort is also how the size cap stops a read — the two
 * failures are indistinguishable from the exception alone, and they map to
 * different statuses.
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
 * A failure of the call itself, as distinct from a status it answered with.
 *
 * The tail is `502 hl_unavailable` rather than a rethrow, because at this point
 * every remaining possibility is a network-shaped one — DNS, a refused
 * connection, a reset — and each of them means the same thing to a caller.
 */
export function mapForwardError(err: unknown): HttpError {
  if (err instanceof UpstreamTimeoutError) return proxyError(504, 'hl_timeout')
  if (err instanceof UpstreamTooLargeError) return proxyError(502, 'hl_too_large')
  return proxyError(502, 'hl_unavailable')
}

/**
 * Whether a failed refresh means the grant is dead.
 *
 * **Only `invalid_grant` on a 400.** §3's first rule is never to destroy a
 * refresh token that may still be valid, so a 500, a network error and a
 * timeout are all transient by definition — the asymmetry is deliberate and it
 * is what keeps a HighLevel blip from being recorded as a dead connection
 * (D26).
 */
export function isDefinitiveRefreshFailure(err: unknown): boolean {
  if (!(err instanceof HlRequestError)) return false
  return err.status === 400 && err.body.includes('invalid_grant')
}
