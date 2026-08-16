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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
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
 * The message to show for a failed response.
 *
 * Canonical, and shared by every caller: it was briefly duplicated per client
 * and the copies had already diverged — one had lost the 429 case, so a
 * throttled user on that path saw "Something went wrong" instead of being told
 * to wait.
 *
 * Prefers the server's own message, since that carries the field error a form
 * needs, and falls back to something a person can act on.
 */
export async function messageForResponse(res: Response): Promise<string> {
  if (res.status === 429) {
    return 'Too many attempts. Try again in a few minutes.'
  }

  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null) {
      const { error } = body as { error?: unknown }
      if (typeof error === 'string' && error !== '') return error
    }
  } catch {
    // A non-JSON body means the request never reached a Cloud Function — the
    // Hosting rewrite or the dev proxy sent it to the SPA fallback instead.
  }

  return 'Something went wrong. Please try again.'
}
