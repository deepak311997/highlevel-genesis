import { logProxyEvent, type ProxyLogContext } from '../lib/log'

/**
 * The proxy itself: match, resolve, inject, forward, mirror, log.
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
