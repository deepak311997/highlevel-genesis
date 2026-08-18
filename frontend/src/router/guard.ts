import type { NavigationGuardWithThis, RouteMeta, Router } from 'vue-router'

import { useAuthStore } from '@/stores/auth'
import { DEFAULT_REDIRECT, storeRedirect } from '@/lib/redirect'

/**
 * How a route is reachable. Declared per route rather than inferred, so adding
 * a route in a later slice is a decision someone has to make rather than a
 * default they inherit.
 */
export type RouteAccess =
  /** Reachable by anyone, signed in or not. */
  | 'public'
  /** Sign in, sign up, forgot password — for people who do *not* have a session. */
  | 'auth-flow'
  /** The verify-email gate itself. */
  | 'gate'
  /**
   * The handler for emailed links, exempt in **every** auth state — which is the
   * whole reason this class exists. The person following a verification link is by
   * definition signed in and unverified, the exact state the gate intercepts, so
   * `protected` would bounce them before the code could be applied.
   */
  | 'action'
  /** Requires a session *and* a verified address. */
  | 'protected'

/**
 * How much room `main` gives a route.
 *
 * `contained` is the default. `full` is the whole window — the workspace's panels
 * need a *bounded* height to scroll inside, and a flex column gives them one
 * without a `calc()` that hard-codes the header's height.
 *
 * Declared per route rather than decided inside a view, because breaking out of the
 * container from the inside means negative margins.
 */
export type RouteLayout = 'contained' | 'full'

declare module 'vue-router' {
  interface RouteMeta {
    access?: RouteAccess
    layout?: RouteLayout
  }
}

export const SIGN_IN_PATH = '/signin'
export const GATE_PATH = '/verify-email'

export interface AuthSnapshot {
  isSignedIn: boolean
  isVerified: boolean
}

/**
 * Where a navigation should end up, or `null` to let it through. Pure, so the whole
 * three-state matrix is testable without a router.
 */
export function resolveNavigation(
  access: RouteAccess,
  auth: AuthSnapshot,
  intendedPath: string,
): string | null {
  if (access === 'public' || access === 'action') return null

  if (!auth.isSignedIn) {
    // Only `protected` routes are worth returning to; the auth-flow pages and the
    // gate are means, not destinations.
    if (access === 'protected') {
      return `${SIGN_IN_PATH}?redirect=${encodeURIComponent(intendedPath)}`
    }
    return access === 'gate' ? SIGN_IN_PATH : null
  }

  if (!auth.isVerified) {
    // Signed in but unverified: everything funnels to the gate, including the
    // auth-flow pages — bouncing them to the dashboard would cost a second redirect.
    return access === 'gate' ? null : GATE_PATH
  }

  return access === 'protected' ? null : DEFAULT_REDIRECT
}

/**
 * The routes a user may be *returned to* after signing in — the allowlist
 * `safeRedirect` is handed, and narrower than "every route we registered".
 *
 * Both callers used to pass every registered path, one of which is `/auth/action`:
 * the single route exempt from this guard in every auth state, which applies a
 * Firebase action code straight off its query string. A crafted `?redirect=` to it
 * handed a user who had *just* typed their password a "choose a new password" form
 * bound to someone else's account.
 *
 * Keyed off `access` rather than a hand-written list, so a route added later is
 * classified once. The fail-open default matches the guard's own: a route with no
 * `access` is protected, and a protected route is a destination.
 */
export function destinationPaths(routes: readonly { path: string; meta: RouteMeta }[]): string[] {
  return routes
    .filter((route) => (route.meta.access ?? 'protected') === 'protected')
    .map((route) => route.path)
}

/**
 * Install the guard, awaiting the store's `ready` promise before deciding anything:
 * Firebase reports auth state asynchronously, so without that wait the first
 * navigation of every page load sees "signed out" and redirects.
 */
export function installAuthGuard(router: Router): void {
  const guard: NavigationGuardWithThis<undefined> = async (to) => {
    const store = useAuthStore()
    await store.ready

    const access: RouteAccess = to.meta.access ?? 'protected'
    const target = resolveNavigation(
      access,
      { isSignedIn: store.isSignedIn, isVerified: store.isVerified },
      to.fullPath,
    )

    if (target === null) return true

    // Hold the destination across the emailed link, which leaves the SPA and comes
    // back on /auth/action.
    if (access === 'protected' && !store.isSignedIn) {
      storeRedirect(to.fullPath)
    }

    return target
  }

  router.beforeEach(guard)
}
