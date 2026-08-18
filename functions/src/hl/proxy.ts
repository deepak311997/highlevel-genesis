import type { Request, Response } from 'express'

import {
  buildUpstreamBody,
  buildUpstreamUrl,
  isRouteEnabled,
  matchRoute,
  type HlRoute,
} from './routes'
import { firestoreTokenDeps, markNeedsReconnect } from './tokenStore'
import { hlUpstreamTimeoutMs } from './config'
import { logProxyEvent, type ProxyLogContext } from '../lib/log'
import {
  mapForwardError,
  mapTokenError,
  mapUpstreamStatus,
  routeRefusal,
  UpstreamTimeoutError,
  UpstreamTooLargeError,
} from './proxyError'
import { resolveConnection, type ResolvedConnection } from './token'

/**
 * The proxy itself: match, resolve, inject, forward, mirror, log.
 *
 * **The order of the refusals is the security property.** The table is consulted
 * first, before Firestore is read and before anything goes upstream: a caller
 * asking for a route we do not serve must learn nothing about whether they have a
 * connection, and must cost us no read. It is also the only part of the ordering
 * observable from outside — no connection plus an unlisted route gives `403
 * route_not_allowed`, never `409 hl_not_connected`.
 *
 * The uid arrives from the verified ID token and appears nowhere in the route;
 * the `locationId` comes from that uid's own document. Neither is ever taken from
 * the request.
 */

/**
 * The five rate-limit headers HighLevel sends, in **one** constant: the handler
 * copies them onto our response and `api/index.ts` lists them in the CORS
 * `exposedHeaders`. Two literals is how those drift, and the failure is silent —
 * the headers present on the wire and invisible to the browser.
 */
export const RATE_LIMIT_HEADERS = [
  'X-RateLimit-Limit-Daily',
  'X-RateLimit-Daily-Remaining',
  'X-RateLimit-Interval-Milliseconds',
  'X-RateLimit-Max',
  'X-RateLimit-Remaining',
] as const

/**
 * The one line per call, projected field by field rather than spread: a spread
 * would carry whatever the caller happened to be holding, and this is the log line
 * whose entire value is what it cannot contain.
 */
export function logProxy(context: ProxyLogContext): void {
  logProxyEvent('hl.proxy', {
    pattern: context.pattern,
    status: context.status,
    durationMs: context.durationMs,
    rateLimitRemaining: context.rateLimitRemaining,
  })
}

/** What came back, held as text so the body is never re-serialised. */
interface UpstreamResponse {
  status: number
  text: string
  headers: Headers
}

/**
 * The response cap — roughly 25× the largest recorded fixture, and real rather
 * than overridden under test: 5 MiB over localhost costs milliseconds, and a cap
 * that is 5 MiB in production and 5 KiB in the suite is one nobody has tested.
 * Without it a pathological `pageLimit` is an out-of-memory rather than an error.
 */
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024

/**
 * Read the body, abandoning it the moment it passes the cap.
 *
 * Two checks, because either alone leaves a hole: `Content-Length` saves
 * downloading megabytes we would discard, but a chunked response declares none and
 * a declared length is upstream's claim rather than a fact. The running count
 * enforces the bound; aborting stops the rest arriving after we stopped wanting it.
 */
async function readCapped(
  // `globalThis.Response` explicitly: this module also imports Express's
  // `Response`, and the two are different things one letter apart.
  upstream: globalThis.Response,
  controller: AbortController,
): Promise<string> {
  const declared = Number(upstream.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES) {
    controller.abort()
    throw new UpstreamTooLargeError()
  }

  // A 204, or any response with no body — an empty string rather than a throw,
  // because "nothing" is a legitimate thing for HighLevel to say.
  if (upstream.body === null) return ''

  // Annotated rather than inferred: Node's `fetch` types the body as
  // `ReadableStream<any>`, and an `any` chunk would leave the byte count unchecked.
  const body: ReadableStream<Uint8Array> = upstream.body
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_UPSTREAM_BYTES) {
      controller.abort()
      throw new UpstreamTooLargeError()
    }
    text += decoder.decode(value, { stream: true })
  }

  return text + decoder.decode()
}

/**
 * The raw query string, not `req.query`, which is qs-parsed: a repeated parameter
 * or bracket syntax cannot be round-tripped back to what the caller sent, so
 * forwarding it would make "verbatim" a claim about the common case only.
 */
function rawQueryOf(req: Request): string {
  const mark = req.originalUrl.indexOf('?')
  return mark === -1 ? '' : req.originalUrl.slice(mark + 1)
}

/**
 * The upstream request: **exactly four headers, all ours**.
 *
 * Allowlisting the caller's headers to nothing is simpler than allowlisting them
 * to something, and two are worse than untidy — an `Authorization` of their own is
 * credential substitution, and a `Version` of their own reaches undocumented
 * behaviour.
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

  /*
   * One controller for both bounds. `timedOut` is a flag rather than an inspection
   * of the `AbortError`, because the cap aborts through the same controller and
   * the two map to a 504 and a 502 respectively.
   */
  const controller = new AbortController()
  // A field rather than a `let`: the compiler narrows a captured local to its
  // initial value across the await and reports the check below as dead code.
  const bound = { timedOut: false }
  const timer = setTimeout(() => {
    bound.timedOut = true
    controller.abort()
  }, hlUpstreamTimeoutMs())

  try {
    const upstream = await fetch(url, {
      method: row.method,
      headers,
      signal: controller.signal,
      ...(writes ? { body: JSON.stringify(body) } : {}),
    })

    return {
      status: upstream.status,
      text: await readCapped(upstream, controller),
      headers: upstream.headers,
    }
  } catch (err) {
    if (bound.timedOut) throw new UpstreamTimeoutError()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `<METHOD> /api/hl/proxy/<Genesis CRM route>`, mounted with a pathful
 * `router.use` so it catches every method — a `DELETE` has to be refused with
 * 403 rather than fall through to the app's 404 — and the bare subtree with it.
 */
export async function handleProxy(req: Request, res: Response, uid: string): Promise<void> {
  const started = Date.now()

  // Inside a `use` mount Express rewrites `req.url` to the remainder, so this is
  // the stable Genesis CRM route and nothing else. Undecoded, deliberately.
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
    // reaches the terminal handler with its own log line.
    throw mapTokenError(err)
  }

  let upstream: UpstreamResponse
  try {
    upstream = await forwardUpstream(
      row,
      buildUpstreamUrl(row, params, rawQueryOf(req), connection.locationId),
      buildUpstreamBody(row, req.body, connection.locationId),
      connection.accessToken,
    )
  } catch (err) {
    throw mapForwardError(err)
  }

  // Copied before the status is decided, so a 429 still carries the numbers that
  // explain it. `api/index.ts` exposes the same list through CORS.
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

  /*
   * Marked before the error is built, and only on a 401: with the proactive skew a
   * 401 is never an expiry we should have caught — it is a revoked install or a
   * removed scope, both fixed by reconnecting rather than refreshing.
   */
  if (upstream.status === 401) await markNeedsReconnect(uid)
  if (upstream.status >= 400) throw mapUpstreamStatus(upstream.status, upstream.text)

  // `send` on the text we read, never `json` on a parsed object: the system
  // prompt carries recorded payloads as response-shape examples, and a
  // re-serialised body would make every one of them a lie.
  res.status(upstream.status).type('application/json').send(upstream.text)
}
