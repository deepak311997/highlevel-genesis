import { rearmSessionExpiry, type SessionExpiredHook } from './apiClient'
import { SIGN_IN_PATH } from '@/router/guard'

/**
 * What the app does when the API says the session is dead.
 *
 * This is the *policy*; `apiClient` owns the detection and knows nothing about the
 * router or the auth store. The two meet in `main.ts`, which is what stops an
 * import cycle and lets every typed client's tests run without a Pinia instance.
 *
 * The return path travels in the query string rather than `sessionStorage`, so a
 * browser that refuses storage still puts the user back where they were.
 */

/** Why the sign-in page is showing a notice. The only value it recognises. */
export const SESSION_EXPIRED_REASON = 'session_expired'

/**
 * Everything the hook needs, injected — four narrow functions rather than the
 * router and the store, so the whole behaviour is assertable with four `vi.fn()`s
 * and nothing here can form a cycle back into `apiClient`.
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
 * The async half, kept out of the hook itself, so the returned hook can be
 * genuinely synchronous — its caller is a `catch` inside a fetch wrapper — while
 * `no-floating-promises` still has a named call to point its `void` at.
 */
async function expire(deps: SessionExpiryDeps): Promise<void> {
  // Read the path *before* signing out: signing out flips the auth store, so a
  // later read risks reporting wherever the app has moved to.
  const from = deps.currentPath()

  try {
    await deps.signOut()
    await deps.replace(expiredSignInPath(from))
  } catch {
    /*
     * Nothing here can be retried and nothing can be said: the surface that would
     * say it is the page we just failed to navigate to. What must not happen is the
     * failure *latching* — swallowing it and re-arming below leaves the next 401 its
     * own attempt.
     */
  } finally {
    expiring = false
    rearmSessionExpiry()
  }
}

/**
 * One expiry at a time, and the guard is here rather than only in `apiClient`.
 *
 * That latch is cleared by any call that *succeeds*, and a request the server had
 * already committed can land during the sign-out — at which point a second 401
 * would start a second `expire()`, re-read `currentPath()` as `/signin?redirect=…`,
 * and land the user on a sign-in page pointing at the sign-in page.
 */
let expiring = false

/**
 * The hook `main.ts` registers with `apiClient`. Does nothing when nobody is signed
 * in: a 401 arriving after the user has already signed out is not news, and acting
 * on it would bounce them off whichever public page they had walked to.
 */
export function createSessionExpiredHook(deps: SessionExpiryDeps): SessionExpiredHook {
  return () => {
    if (expiring || !deps.isSignedIn()) return
    expiring = true
    void expire(deps)
  }
}
