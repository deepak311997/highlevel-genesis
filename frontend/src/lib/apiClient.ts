import { ApiError, apiUrl, errorForResponse } from './api'
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
 * Everything that authenticates a call: the ID token, and the App Check token.
 *
 * The ID token is read per request rather than cached — Firebase rotates it
 * roughly hourly, and a stale one produces a 401 on a tab that has merely been
 * left open.
 *
 * **Exported because the streaming call cannot use `request`** (D32). It must
 * not read its body as JSON, so the choice was to share the credential minting
 * or to write it a second time — and this module exists precisely because the
 * same logic once lived privately inside two typed clients and the copies
 * diverged, leaving one of them telling a throttled user "something went wrong"
 * instead of to wait. A third copy would repeat that.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser
  if (user === null) throw new ApiError('Sign in and try again.', 401)

  return {
    Authorization: `Bearer ${await user.getIdToken()}`,
    ...(await appCheckHeader()),
  }
}

/**
 * The caller's own headers go first, so neither of the two below can be
 * overwritten by one of them — the ones that authenticate the request are the
 * ones a caller must not be able to unset by accident.
 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    ...(await authHeaders()),
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

  if (!res.ok) throw await errorForResponse(res)
  return (await res.json()) as T
}
