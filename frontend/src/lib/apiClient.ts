import { ApiError, apiUrl, connectionError, errorForResponse } from './api'
import { appCheckHeader } from './appCheck'
import { auth } from './firebase'

/**
 * The one authenticated fetch, for every call the browser makes to our API.
 *
 * The frontend does not talk to Firestore at all, so this is the whole of its data
 * access. Having exactly one of it is the point: the same logic previously lived
 * privately inside two typed clients, the copies diverged, and the one that had
 * lost its 429 case told a throttled user "something went wrong" instead of to wait.
 */

/**
 * Everything that authenticates a call: the ID token, and the App Check token.
 *
 * The ID token is read per request rather than cached — Firebase rotates it roughly
 * hourly, and a stale one produces a 401 on a tab that has merely been left open.
 *
 * **Exported because the streaming call cannot use `request`**: it must not read its
 * body as JSON, and a third copy of the credential minting is what this module
 * exists to prevent.
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
 * A callback rather than a direct call into the router and the auth store: those
 * live above this module, so importing them here would be a cycle — and would make
 * every typed client's unit test need a Pinia instance to exercise a fetch.
 */
export type SessionExpiredHook = () => void

let onSessionExpired: SessionExpiredHook | null = null

/**
 * Once per death, not once per request. A screen that loads three panels answers a
 * dead session with three 401s within milliseconds; three sign-outs would be three
 * navigations racing over what `?redirect=` should say.
 */
let signalled = false

/** Registered once, in `main.ts`. `null` restores the no-op default and clears the latch. */
export function registerSessionExpiredHook(hook: SessionExpiredHook | null): void {
  onSessionExpired = hook
  signalled = false
}

/**
 * Fire the hook iff this is a 401 whose code is `unauthenticated`, and at most once.
 *
 * **The branch is on `code`, not on `status`.** A 401 is two unrelated conditions:
 * `unauthenticated` means the credential is dead, while `app_check_failed` means the
 * *page* could not be attested — the session is fine and reloading fixes it. Signing
 * a user out for the second destroys a good session and takes their unsaved editor
 * buffers with it. A bare 401 with no code is likewise not a death.
 */
export function noteApiError(err: unknown): void {
  if (!(err instanceof ApiError)) return
  if (err.status !== 401 || err.code !== 'unauthenticated') return
  if (signalled) return

  signalled = true
  onSessionExpired?.()
}

/**
 * Re-arm the latch: the next death is a new one.
 *
 * Two things prove that, and it took both. A call that **succeeded** proves the
 * session is alive. And an expiry that has **finished being answered** is over by
 * definition — a dead session cannot produce the successful call that would
 * otherwise clear this, so with only the first, the *second* death in a page session
 * was swallowed as a repeat of the first: every panel reading "Sign in and try
 * again." with nothing to click.
 */
export function rearmSessionExpiry(): void {
  signalled = false
}

/**
 * The caller's own headers go first, so neither of the two below can be overwritten
 * by one of them: the ones that authenticate the request are the ones a caller must
 * not be able to unset by accident.
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
    // needs something with a message in it, and "check your connection" is the only
    // advice that is ever right here.
    throw connectionError()
  }

  if (!res.ok) {
    const err = await errorForResponse(res)
    noteApiError(err)
    throw err
  }

  rearmSessionExpiry()
  return (await res.json()) as T
}
