import { describe, expect, it, vi } from 'vitest'

import {
  createSessionExpiredHook,
  expiredSignInPath,
  type SessionExpiryDeps,
} from './sessionExpiry'

/**
 * What happens when the session turns out to be dead (AC-10).
 *
 * The hook is handed its four dependencies rather than reaching for the router
 * and the auth store itself (D10) — which is what lets the whole behaviour be
 * asserted here, with no Pinia instance and no router.
 */

interface Stubs {
  deps: SessionExpiryDeps
  order: string[]
  signOut: ReturnType<typeof vi.fn>
  replace: ReturnType<typeof vi.fn>
  currentPath: ReturnType<typeof vi.fn>
}

function stubs(isSignedIn = true, path = '/projects/abc'): Stubs {
  const order: string[] = []
  const currentPath = vi.fn(() => {
    order.push('currentPath')
    return path
  })
  const signOut = vi.fn(() => {
    order.push('signOut')
    return Promise.resolve()
  })
  const replace = vi.fn(() => {
    order.push('replace')
    return Promise.resolve()
  })

  return {
    deps: { isSignedIn: () => isSignedIn, currentPath, signOut, replace },
    order,
    signOut,
    replace,
    currentPath,
  }
}

describe('expiredSignInPath', () => {
  it('carries the path they were on, and says why they are here', () => {
    expect(expiredSignInPath('/projects/abc')).toBe(
      '/signin?redirect=%2Fprojects%2Fabc&reason=session_expired',
    )
  })

  it('encodes a path carrying a query of its own', () => {
    expect(expiredSignInPath('/projects/abc?tab=files')).toBe(
      '/signin?redirect=%2Fprojects%2Fabc%3Ftab%3Dfiles&reason=session_expired',
    )
  })
})

describe('createSessionExpiredHook', () => {
  it('signs out and lands on sign-in carrying the path they were on', async () => {
    const { deps, signOut, replace } = stubs()

    createSessionExpiredHook(deps)()
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalled()
    })

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith(
      '/signin?redirect=%2Fprojects%2Fabc&reason=session_expired',
    )
  })

  /*
   * Order matters: signing out first lets the auth guard fire its own
   * navigation, which moves the current route to `/signin` before anyone reads
   * it — and the user comes back to the sign-in page rather than their project.
   */
  it('reads the path before signing out', async () => {
    const { deps, order, replace } = stubs()

    createSessionExpiredHook(deps)()
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalled()
    })

    expect(order.indexOf('currentPath')).toBeLessThan(order.indexOf('signOut'))
  })

  /* E7. A 401 that arrives after the user already signed out is not news, and
   * bouncing them off whatever page they walked to would be. */
  it('does nothing when nobody is signed in', async () => {
    const { deps, signOut, replace, currentPath } = stubs(false)

    createSessionExpiredHook(deps)()
    await Promise.resolve()

    expect(currentPath).not.toHaveBeenCalled()
    expect(signOut).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  /*
   * The caller is `noteApiError`, inside a `catch` in a fetch wrapper, and it has nothing to
   * await — so a hook that returned a promise would be one nobody handles.
   */
  it('returns nothing, so no caller has a promise to drop', () => {
    const { deps } = stubs()
    const hook: () => unknown = createSessionExpiredHook(deps)

    expect(hook()).toBeUndefined()
  })
})
