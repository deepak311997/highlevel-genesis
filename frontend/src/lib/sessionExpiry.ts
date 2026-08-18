import { rearmSessionExpiry, type SessionExpiredHook } from './apiClient'
import { SIGN_IN_PATH } from '@/router/guard'

/**
 * What the app does when the API says the session is dead.
 *
 * This is the *policy*; `apiClient` owns the detection and knows nothing about
 * the router or the auth store (D10). The two meet in `main.ts`, which is the
 * only place that has all three to hand — and keeping it that way is what stops
 * an import cycle and what lets every typed client's unit tests run without a
 * Pinia instance.
 *
 * The return path travels in the query string rather than `sessionStorage`, so
 * a browser that refuses storage (private mode, some embedded webviews) still
 * puts the user back in the project they were working in.
 */

/** Why the sign-in page is showing a notice. The only value it recognises. */
export const SESSION_EXPIRED_REASON = 'session_expired'

/**
 * Everything the hook needs, injected.
 *
 * Four narrow functions rather than the router and the store themselves: the
 * whole behaviour is then assertable with four `vi.fn()`s, and the module has
 * no dependency that could form a cycle back into `apiClient`.
 */
export interface SessionExpiryDeps {
  isSignedIn: () => boolean
  currentPath: () => string
  signOut: () => Promise<void>
  replace: (path: string) => Promise<void>
}

/** `/projects/abc` → `/signin?redirect=%2Fprojects%2Fabc&reason=session_expired` */
export function expiredSignInPath(from: string): string {
  return `${SIGN_IN_PATH}?redirect=${encodeURIComponent(from)}&reason=${SESSION_EXPIRED_REASON}`
}

/**
 * The async half, kept out of the hook itself.
 *
 * Split out so the returned hook can be genuinely synchronous — its caller is a
 * `catch` inside a fetch wrapper, which has no promise to await — while
 * `no-floating-promises` still has a named call to point its `void` at.
 */
async function expire(deps: SessionExpiryDeps): Promise<void> {
  // Read the path *before* signing out. Signing out flips the auth store, so a
  // later read risks reporting wherever the app has moved to rather than the
  // project the user was actually in.
  const from = deps.currentPath()

  try {
    await deps.signOut()
    await deps.replace(expiredSignInPath(from))
  } catch {
    /*
     * Nothing here can be retried and nothing can be said: the surface that
     * would say it is the page we just failed to navigate to. `signOut` ends in
     * a storage write, which private browsing and a full quota both refuse.
     *
     * What must not happen is the failure *latching*. Swallowing it here and
     * re-arming below is what leaves the next 401 its own attempt, rather than
     * one transient storage error stranding the session for the life of the
     * page.
     */
  } finally {
    expiring = false
    rearmSessionExpiry()
  }
}

/**
 * One expiry at a time, and the guard is here rather than only in `apiClient`.
 *
 * `apiClient`'s latch is cleared by any call that *succeeds*, and a request the
 * server had already committed can land during the `await deps.signOut()` above
 * — at which point `isSignedIn()` is still true and a second 401 would start a
 * second `expire()`. That one re-reads `currentPath()`, by then already
 * `/signin?redirect=…`, and lands the user on a sign-in page pointing at the
 * sign-in page. They would reach the dashboard after signing in, not their
 * project.
 */
let expiring = false

/**
 * The hook `main.ts` registers with `apiClient`.
 *
 * Does nothing when nobody is signed in (E7): a 401 arriving after the user has
 * already signed out is not news, and acting on it would bounce them off
 * whichever public page they had walked to.
 */
export function createSessionExpiredHook(deps: SessionExpiryDeps): SessionExpiredHook {
  return () => {
    if (expiring || !deps.isSignedIn()) return
    expiring = true
    void expire(deps)
  }
}
