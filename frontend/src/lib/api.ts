/**
 * Cloud Functions base URL.
 *
 * Normally empty: in production Firebase Hosting rewrites `/api/**` to the
 * `api` function, and in development the Vite dev-server proxy does the same.
 * Both cases are same-origin, so CORS never enters the picture.
 *
 * Set VITE_FUNCTIONS_BASE_URL only to bypass that — e.g. pointing a local SPA
 * at a deployed backend.
 */
const BASE = (import.meta.env.VITE_FUNCTIONS_BASE_URL ?? '').replace(/\/$/, '')

export function apiUrl(path: string): string {
  return `${BASE}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * A failed API call, as the app's own error type.
 *
 * `code` and `detail` mirror the server's error envelope
 * (`functions/src/lib/errors.ts`): `code` is the machine-readable reason a
 * caller may branch on — `hl_reconnect_required` is the one that matters — and
 * `detail` is upstream's own text about the request, which the HighLevel proxy
 * passes through so a preview can say what was actually wrong with the call
 * rather than only that something was.
 *
 * Both are declared `string | undefined` rather than optional (`?:`): under
 * `exactOptionalPropertyTypes` an optional property and one that may hold
 * `undefined` are different types, and the constructor assigns unconditionally
 * from optional parameters. Declaring them this way is what lets the assignment
 * stay unconditional and every existing two-argument `new ApiError(...)` keep
 * compiling.
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

/** Fetch JSON from the functions API, turning non-2xx into a typed error. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  // Build the init conditionally: under exactOptionalPropertyTypes, passing an
  // explicitly-undefined `signal` is not the same as omitting it.
  const res = await fetch(apiUrl(path), signal ? { signal } : {})

  if (!res.ok) {
    throw new ApiError(`Request failed (${res.status})`, res.status)
  }

  // A 200 carrying HTML means the request never reached a Cloud Function —
  // the dev-server proxy or the Hosting rewrite sent it to the SPA fallback
  // instead. Say that, rather than letting JSON.parse report a stray '<'.
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
 * The typed error for a failed response.
 *
 * Canonical, and shared by every caller: it was briefly duplicated per client
 * and the copies had already diverged — one had lost the 429 case, so a
 * throttled user on that path saw "Something went wrong" instead of being told
 * to wait.
 *
 * Prefers the server's own message, since that carries the field error a form
 * needs, and falls back to something a person can act on. It returns the error
 * rather than the message alone because the envelope's `code` and `detail` are
 * part of what a caller needs — the preview bridge reports both back to the
 * generated app, and a store branching on `hl_reconnect_required` reads `code`.
 *
 * The body is read **once**, before any branch: a 429 still carries an envelope
 * worth lifting even though its message is fixed, and `Response.json()` can only
 * be called once.
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
    // A non-JSON body means the request never reached a Cloud Function — the
    // Hosting rewrite or the dev proxy sent it to the SPA fallback instead.
  }

  // The one message that overrides the server's: throttling is the only failure
  // where what the user should do next is knowable here and not there.
  const message =
    res.status === 429
      ? 'Too many attempts. Try again in a few minutes.'
      : (serverMessage ?? 'Something went wrong. Please try again.')

  return new ApiError(message, res.status, code, detail)
}
