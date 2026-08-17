import { request } from './apiClient'

/**
 * One call to HighLevel, through our proxy.
 *
 * ## Why the signature looks like this
 *
 * `hlProxy('POST', '/contacts/search', { pageLimit: 1 })` is
 * `HIGHLEVEL_PLATFORM.md` §8's `hl()` convention, argument for argument, and
 * that is the point rather than a coincidence. Slice 9 teaches the model that
 * exact string; Slice 10's `srcdoc` shim will mirror it so generated code can
 * call `hl(...)` unchanged; and the URL it produces is `/api/hl/proxy` plus the
 * same path. There is no translation table between the string in the system
 * prompt and the string on the wire, because there is nothing to translate.
 *
 * ## What it deliberately does not do
 *
 * No re-shaping, no envelope, no per-surface wrapper. Slice 9's system prompt
 * carries recorded HighLevel payloads as response-shape examples, and a client
 * that unwrapped or renamed anything would make every one of those examples a
 * lie (D17). Responses are narrowed by hand at the point of use (D32) — Zod on
 * the frontend's own API responses is Slice 12's cross-cutting pass, and doing
 * it for this one client would leave two conventions in the codebase.
 */

/** The subset of HTTP methods the allowlist actually uses. */
export type HlMethod = 'GET' | 'POST' | 'PUT'

const PROXY_BASE = '/api/hl/proxy'

/**
 * On a `GET` the payload is the query string; on a write it is the JSON body.
 *
 * Split on the method rather than on a fourth argument, because HighLevel's own
 * convention is that a search is a `POST` with a filter body and a list is a
 * `GET` with parameters — so the method already says which one a caller means.
 */
export function hlProxy<T>(method: HlMethod, path: string, payload?: unknown): Promise<T> {
  if (method === 'GET') {
    const query = new URLSearchParams(
      Object.entries((payload ?? {}) as Record<string, unknown>).map(([key, value]) => [
        key,
        String(value),
      ]),
    ).toString()

    // Named rather than left to `fetch`'s default. The method is this
    // function's own argument, so a request that carries it implicitly would be
    // the one place the caller's choice is not visible in what goes out.
    return request<T>(`${PROXY_BASE}${path}${query === '' ? '' : `?${query}`}`, { method })
  }

  return request<T>(`${PROXY_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
}
