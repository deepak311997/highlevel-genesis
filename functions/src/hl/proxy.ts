import type { Request, Response } from 'express'

import { buildUpstreamBody, buildUpstreamUrl, isRouteEnabled, matchRoute, type HlRoute } from './routes'
import { firestoreTokenDeps } from './tokenStore'
import { logProxyEvent, type ProxyLogContext } from '../lib/log'
import { mapTokenError, mapUpstreamStatus, routeRefusal } from './proxyError'
import { resolveConnection, type ResolvedConnection } from './token'

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

/** What came back, held as text so the body is never re-serialised (D17). */
interface UpstreamResponse {
  status: number
  text: string
  headers: Headers
}

/**
 * The raw query string, not `req.query`.
 *
 * `req.query` is qs-parsed, and a repeated parameter or bracket syntax cannot
 * be round-tripped back to what the caller sent — so forwarding it would make
 * D12's "verbatim" a claim about the common case only. Everything after the
 * first `?` of the original URL is what the caller actually wrote.
 */
function rawQueryOf(req: Request): string {
  const mark = req.originalUrl.indexOf('?')
  return mark === -1 ? '' : req.originalUrl.slice(mark + 1)
}

/**
 * The upstream request: **exactly four headers, all ours** (D14).
 *
 * Allowlisting the caller's headers to nothing is simpler than allowlisting
 * them to something, and two of the ones a caller might send are worse than
 * untidy — an `Authorization` of their own is credential substitution, and a
 * `Version` of their own is a way to reach undocumented behaviour. So the
 * header set is built from scratch here and nothing is ever copied off `req`.
 */
async function forwardUpstream(
  row: HlRoute,
  url: URL,
  body: unknown,
  accessToken: string,
): Promise<UpstreamResponse> {
  const writes = row.method === 'POST' || row.method === 'PUT'

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Version: row.version,
    Accept: 'application/json',
  }
  if (writes) headers['Content-Type'] = 'application/json'

  const upstream = await fetch(url, {
    method: row.method,
    headers,
    ...(writes ? { body: JSON.stringify(body) } : {}),
  })

  return { status: upstream.status, text: await upstream.text(), headers: upstream.headers }
}

/**
 * `<METHOD> /api/hl/proxy/<HighLevel path>` (D1).
 *
 * Mounted with a *pathful* `router.use`, so it catches every method — a `DELETE`
 * has to be refused with 403 rather than fall through to the app's 404 — and the
 * bare subtree with it (P2, AC-23).
 */
export async function handleProxy(req: Request, res: Response, uid: string): Promise<void> {
  const started = Date.now()

  // Inside a `use` mount Express rewrites `req.url` to the remainder, so this is
  // the HighLevel path and nothing else. Undecoded, deliberately: `%2E%2E%2F`
  // has to fail the grammar as written rather than become `../` after a decode
  // we would then have to re-check.
  const match = matchRoute(req.method, req.path)
  if (match.kind === 'invalid_path') throw routeRefusal('invalid_path')
  if (match.kind === 'not_allowed') throw routeRefusal('route_not_allowed')

  const { row, params } = match
  if (!isRouteEnabled(row, process.env)) throw routeRefusal('route_disabled')

  let connection: ResolvedConnection
  try {
    connection = await resolveConnection(uid, firestoreTokenDeps())
  } catch (err) {
    // Rethrows anything that is not a token condition, so an unexpected failure
    // reaches the terminal handler with its own log line rather than being
    // flattened into a HighLevel-shaped answer.
    throw mapTokenError(err)
  }

  const upstream = await forwardUpstream(
    row,
    buildUpstreamUrl(row, params, rawQueryOf(req), connection.locationId),
    buildUpstreamBody(row, req.body, connection.locationId),
    connection.accessToken,
  )

  // Copied before the status is decided, so a 429 still carries the numbers
  // that explain it (D18). `api/index.ts` exposes the same list through CORS.
  for (const name of RATE_LIMIT_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) res.setHeader(name, value)
  }

  logProxy({
    pattern: row.pattern,
    status: upstream.status,
    durationMs: Date.now() - started,
    rateLimitRemaining: upstream.headers.get('X-RateLimit-Remaining'),
  })

  if (upstream.status >= 400) throw mapUpstreamStatus(upstream.status, upstream.text)

  // `send` on the text we read, never `json` on a parsed object: Slice 9's
  // system prompt carries recorded HighLevel payloads as response-shape
  // examples, and a re-serialised body would make every one of them a lie.
  res.status(upstream.status).type('application/json').send(upstream.text)
}
