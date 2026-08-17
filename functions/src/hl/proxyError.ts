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
