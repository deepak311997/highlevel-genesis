import type { Request, Response } from 'express'

import { firestoreTokenDeps } from './tokenStore'
import { isRouteEnabled, matchRoute } from './routes'
import { logProxyEvent, type ProxyLogContext } from '../lib/log'
import { mapTokenError, routeRefusal } from './proxyError'
import { resolveConnection } from './token'

/**
 * The proxy itself: match, resolve, inject, forward, mirror, log.
 *
 * ## The order of the refusals is the security property
 *
 * The table is consulted **first**, before Firestore is read and before
 * anything is sent upstream. That is not an optimisation: a caller asking for a
 * route we do not serve must learn nothing about whether they have a connection,
 * and a route we do not serve must cost us no read. It is also the only part of
 * the ordering that is observable from outside — a caller with no connection
 * document who asks for a route that is not on the table gets `403
 * route_not_allowed` and never `409 hl_not_connected`, which is exactly what the
 * integration suite asserts, because there is no other way to watch a read that
 * did not happen.
 *
 * The uid arrives as an argument from `withVerifiedUser`, out of the verified ID
 * token, and appears nowhere in the route. The `locationId` comes from that
 * uid's own document. Neither is ever taken from the request.
 */

/**
 * The five rate-limit headers HighLevel sends (§5), in **one** constant.
 *
 * D18 needs the same names in two places — the handler copies them onto our
 * response, and `api/index.ts` puts them in the CORS `exposedHeaders` list so
 * they survive a cross-origin configuration. Two literals is how those drift,
 * and the failure mode is silent: the headers are present on the wire and
 * invisible to the browser.
 */
export const RATE_LIMIT_HEADERS = [
  'X-RateLimit-Limit-Daily',
  'X-RateLimit-Daily-Remaining',
  'X-RateLimit-Interval-Milliseconds',
  'X-RateLimit-Max',
  'X-RateLimit-Remaining',
] as const

/**
 * The one line per call (D28).
 *
 * Projected field by field rather than spread, exactly as `logGeneration` does
 * and for the same stated reason: a spread would carry whatever the caller
 * happened to be holding, and this is the log line whose entire value is what
 * it cannot contain.
 */
export function logProxy(context: ProxyLogContext): void {
  logProxyEvent('hl.proxy', {
    pattern: context.pattern,
    status: context.status,
    durationMs: context.durationMs,
    rateLimitRemaining: context.rateLimitRemaining,
  })
}

/**
 * `<METHOD> /api/hl/proxy/<HighLevel path>` (D1).
 *
 * Mounted with a *pathful* `router.use`, so it catches every method — a `DELETE`
 * has to be refused with 403 rather than fall through to the app's 404 — and the
 * bare subtree with it (P2, AC-23).
 */
export async function handleProxy(req: Request, _res: Response, uid: string): Promise<void> {
  // Inside a `use` mount Express rewrites `req.url` to the remainder, so this is
  // the HighLevel path and nothing else. Undecoded, deliberately: `%2E%2E%2F`
  // has to fail the grammar as written rather than become `../` after a decode
  // we would then have to re-check.
  const match = matchRoute(req.method, req.path)
  if (match.kind === 'invalid_path') throw routeRefusal('invalid_path')
  if (match.kind === 'not_allowed') throw routeRefusal('route_not_allowed')
  if (!isRouteEnabled(match.row, process.env)) throw routeRefusal('route_disabled')

  try {
    await resolveConnection(uid, firestoreTokenDeps())
  } catch (err) {
    // Rethrows anything that is not a token condition, so an unexpected failure
    // reaches the terminal handler with its own log line rather than being
    // flattened into a HighLevel-shaped answer.
    throw mapTokenError(err)
  }

  // T9 attaches our four headers and forwards. Loud rather than silent until
  // then: nothing in the suite reaches this line, and a plausible status here
  // would hide that.
  throw new Error('The upstream call lands in T9.')
}
