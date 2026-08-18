/**
 * Cloud Functions base URL.
 *
 * Normally empty: in production Hosting rewrites `/api/**` to the `api` function
 * and in development the Vite proxy does the same, so both are same-origin.
 * `VITE_FUNCTIONS_BASE_URL` exists only to bypass that.
 */
const BASE = (import.meta.env.VITE_FUNCTIONS_BASE_URL ?? '').replace(/\/$/, '')

export function apiUrl(path: string): string {
  return `${BASE}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Where `POST /generate` goes, which is deliberately **not** where everything
 * else goes.
 *
 * Hosting fronts a rewrite with a CDN that buffers the whole response before it
 * sends a byte, and gives up on the origin at sixty seconds. A generation runs to
 * two minutes: the browser got a 502 while the function ran on, finished, and
 * stored the reply — so the turn "failed" and the answer was there on the next
 * reload, and nothing ever streamed, it arrived in one piece at the end.
 * Measured 0.35s to first byte direct, against 11.8s through the rewrite.
 *
 * Set `VITE_GENERATE_URL` to the function's own URL and Hosting is out of this
 * one request's path. The rest of the API stays same-origin, where the rewrite
 * costs nothing — those calls are short.
 *
 * The whole URL rather than a base: nothing is joined onto it, so there is no way
 * to configure `…/generate/generate` by accident. Blank means same-origin, which
 * is what development, the emulator and the test suite all want.
 */
const GENERATE_URL = (import.meta.env.VITE_GENERATE_URL ?? '').trim()

export function generateUrl(): string {
  return GENERATE_URL === '' ? apiUrl('/generate') : GENERATE_URL
}

/**
 * A failed API call, as the app's own error type.
 *
 * `code` and `detail` mirror the server's error envelope: `code` is the
 * machine-readable reason a caller may branch on, and `detail` is upstream's own
 * text about the request, which the HighLevel proxy passes through — the
 * dashboard's probe composes it onto the message, so "Could not read contacts.
 * (Invalid JWT)" is a fix where a shrug is not.
 *
 * Both are declared `string | undefined` rather than optional: under
 * `exactOptionalPropertyTypes` those are different types, and this is what lets the
 * constructor assign unconditionally.
 */
export class ApiError extends Error {
  readonly code: string | undefined
  readonly detail: string | undefined

  constructor(
    message: string,
    readonly status: number,
    code?: string,
    detail?: string,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.detail = detail
  }
}

/**
 * What the app says when the browser could not complete the request at all.
 *
 * One sentence, one author: it reaches the user from four places that cannot see
 * each other's copy, and a copy-edit used to be four edits and one surface left
 * behind. Status 0 because no response arrived, so a caller branching on one must
 * not mistake this for a server that answered.
 */
export const CONNECTION_MESSAGE = 'Something went wrong. Check your connection and try again.'

export function connectionError(): ApiError {
  return new ApiError(CONNECTION_MESSAGE, 0)
}

/** Fetch JSON from the functions API, turning non-2xx into a typed error. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  // Built conditionally: under `exactOptionalPropertyTypes`, passing an
  // explicitly-undefined `signal` is not the same as omitting it.
  const res = await fetch(apiUrl(path), signal ? { signal } : {})

  if (!res.ok) {
    throw new ApiError(`Request failed (${res.status})`, res.status)
  }

  // A 200 carrying HTML means the request never reached a Cloud Function — the dev
  // proxy or the Hosting rewrite sent it to the SPA fallback. Say that, rather than
  // letting JSON.parse report a stray '<'.
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new ApiError(
      `Expected JSON from ${path} but received ${contentType || 'an unknown content type'}. ` +
        'The request did not reach a Cloud Function — check that the emulators are running.',
      res.status,
    )
  }

  return (await res.json()) as T
}

/**
 * The typed error for a failed response — canonical, and shared by every caller: it
 * was briefly duplicated per client and the copies had already diverged, one having
 * lost its 429 case.
 *
 * It returns the error rather than the message alone because the envelope's `code`
 * is part of what a caller needs. The body is read **once**, before any branch: a
 * 429 still carries an envelope worth lifting, and `Response.json()` can only be
 * called once.
 */
export async function errorForResponse(res: Response): Promise<ApiError> {
  let serverMessage: string | undefined
  let code: string | undefined
  let detail: string | undefined

  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null) {
      const envelope = body as { error?: unknown; code?: unknown; detail?: unknown }
      if (typeof envelope.error === 'string' && envelope.error !== '') {
        serverMessage = envelope.error
      }
      if (typeof envelope.code === 'string') code = envelope.code
      if (typeof envelope.detail === 'string') detail = envelope.detail
    }
  } catch {
    // A non-JSON body means the request never reached a Cloud Function.
  }

  // The one message that overrides the server's: throttling is the only failure
  // where what the user should do next is knowable here and not there.
  const message =
    res.status === 429
      ? 'Too many attempts. Try again in a few minutes.'
      : (serverMessage ?? 'Something went wrong. Please try again.')

  return new ApiError(message, res.status, code, detail)
}
