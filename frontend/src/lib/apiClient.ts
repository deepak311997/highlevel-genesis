import { ApiError, apiUrl, messageForResponse } from './api'
import { appCheckHeader } from './appCheck'
import { auth } from './firebase'

/**
 * The one authenticated fetch, for every call the browser makes to our API.
 *
 * Everything the app reads or writes goes through a Cloud Function route: the
 * frontend does not talk to Firestore at all, so this is the whole of its data
 * access. Having exactly one of it is the point — the same logic previously
 * lived privately inside two typed clients, the copies diverged, and the one
 * that had lost its 429 case told a throttled user "something went wrong"
 * instead of to wait.
 */

/**
 * The ID token for the current user.
 *
 * Read per request rather than cached: Firebase rotates it roughly hourly, and
 * a stale one produces a 401 on a tab that has merely been left open.
 */
async function authHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser
  if (user === null) throw new ApiError('Sign in and try again.', 401)
  return { Authorization: `Bearer ${await user.getIdToken()}` }
}

/**
 * The caller's own headers go first, so neither of the two below can be
 * overwritten by one of them — the ones that authenticate the request are the
 * ones a caller must not be able to unset by accident.
 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    ...(await authHeader()),
    ...(await appCheckHeader()),
  }

  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    // Status 0 rather than a thrown TypeError: a caller rendering an error state
    // needs something with a message in it, and "check your connection" is the
    // only advice that is ever right here.
    throw new ApiError('Something went wrong. Check your connection and try again.', 0)
  }

  if (!res.ok) throw new ApiError(await messageForResponse(res), res.status)
  return (await res.json()) as T
}
