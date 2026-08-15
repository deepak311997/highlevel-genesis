import { ApiError, apiUrl } from './api'

/**
 * The three endpoints that must not answer differently for a known and an
 * unknown address.
 *
 * Nothing here inspects the response beyond its status, and that is deliberate:
 * the whole design depends on the body being identical across branches, so any
 * code that branched on it would be reading a signal that is not there — and
 * would break the moment someone assumed it was.
 */

async function post(path: string, body: unknown): Promise<void> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Something went wrong. Check your connection and try again.', 0)
  }

  if (res.ok) return

  throw new ApiError(await messageFor(res), res.status)
}

/**
 * Prefer the server's message when there is one, since it carries the field
 * error a form needs, and fall back to something a person can act on.
 */
async function messageFor(res: Response): Promise<string> {
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
    // A non-JSON body means the request never reached the function — the
    // Hosting rewrite or the dev proxy sent it to the SPA fallback instead.
  }

  return 'Something went wrong. Please try again.'
}

export function register(email: string, password: string): Promise<void> {
  return post('/api/auth/register', { email, password })
}

export function resendVerification(email: string): Promise<void> {
  return post('/api/auth/resend', { email })
}

export function requestPasswordReset(email: string): Promise<void> {
  return post('/api/auth/password-reset', { email })
}
