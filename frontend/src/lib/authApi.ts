import { ApiError, apiUrl, errorForResponse } from './api'
import { appCheckHeader } from './appCheck'

/**
 * The one endpoint that must not answer differently for a known and an unknown
 * address.
 *
 * Nothing here inspects the response beyond its status, and that is deliberate:
 * the whole design depends on the body being identical across branches, so any
 * code that branched on it would be reading a signal that is not there — and
 * would break the moment someone assumed it was.
 *
 * Verification and password-reset emails are sent by Firebase through the
 * client SDK, not through here. With email-enumeration protection enabled
 * `sendPasswordResetEmail` does not disclose whether an account exists, so
 * proxying it would add a hop and buy nothing.
 */

async function post(path: string, body: unknown): Promise<void> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      // App Check proves the caller is our app. Resolved per request rather
      // than once at module load, because the token expires and the SDK
      // rotates it; a cached header would start failing after an hour open.
      headers: { 'Content-Type': 'application/json', ...(await appCheckHeader()) },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Something went wrong. Check your connection and try again.', 0)
  }

  if (res.ok) return

  throw await errorForResponse(res)
}

export function register(email: string, password: string): Promise<void> {
  return post('/api/auth/register', { email, password })
}
