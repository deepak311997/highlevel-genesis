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
 * What to do when the session turns out to be dead.
 *
 * A callback rather than a direct call into the router and the auth store
 * (D10): those live above this module, and importing them here would be a
 * cycle — and would make every typed client's unit test need a Pinia instance
 * to exercise a fetch. `main.ts` is the one place that knows about all three,
 * so `main.ts` is where the wiring goes.
 */
export type SessionExpiredHook = () => void

let onSessionExpired: SessionExpiredHook | null = null

/**
 * Once per death, not once per request.
 *
 * A screen that loads three panels answers a dead session with three 401s
 * within a few milliseconds of each other. The user must be signed out once;
 * three sign-outs would be three navigations, and the second and third would
 * race the first over what `?redirect=` should say.
 */
let signalled = false

/** Registered once, in `main.ts`. `null` restores the no-op default and clears the latch. */
export function registerSessionExpiredHook(hook: SessionExpiredHook | null): void {
  onSessionExpired = hook
  signalled = false
}

/**
 * Fire the hook iff this is a 401 whose code is `unauthenticated`, and at most
 * once.
 *
 * **The branch is on `code`, not on `status`.** A 401 is two unrelated
 * conditions: `unauthenticated` means the credential is dead and there is
 * nothing to do but sign in again, while `app_check_failed` means the *page*
 * could not be attested — the session is fine and reloading fixes it. Signing a
 * user out for the second destroys a good session and takes their unsaved
 * editor buffers with it. A 401 carrying no code at all is likewise not a
 * death: `authHeaders` throws one when nobody was ever signed in.
 */
export function noteApiError(err: unknown): void {
  if (!(err instanceof ApiError)) return
  if (err.status !== 401 || err.code !== 'unauthenticated') return
  if (signalled) return

  signalled = true
  onSessionExpired?.()
}

/** A call that succeeded proves the session is alive; the next death is a new one. */
export function noteSessionAlive(): void {
  signalled = false
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

  if (!res.ok) {
    const err = await errorForResponse(res)
    noteApiError(err)
    throw err
  }

  noteSessionAlive()
  return (await res.json()) as T
}
