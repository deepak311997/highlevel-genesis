import { describe, expect, it } from 'vitest'

import {
  destinationPaths,
  GATE_PATH,
  resolveNavigation,
  SIGN_IN_PATH,
  type RouteAccess,
} from './guard'

const SIGNED_OUT = { isSignedIn: false, isVerified: false }
const UNVERIFIED = { isSignedIn: true, isVerified: false }
const VERIFIED = { isSignedIn: true, isVerified: true }

/**
 * The three-state matrix. Two states were not enough: "signed in" and "allowed
 * in" are different questions once verification gates the app, and collapsing
 * them is what lets an unverified session reach the dashboard.
 */
describe('resolveNavigation — signed out', () => {
  it.each<[RouteAccess, string | null]>([
    ['public', null],
    ['auth-flow', null],
    ['action', null],
  ])('lets a signed-out visitor reach a %s route', (access, expected) => {
    expect(resolveNavigation(access, SIGNED_OUT, '/whatever')).toBe(expected)
  })

  it('sends a signed-out visitor from a protected route to sign in, remembering where', () => {
    expect(resolveNavigation('protected', SIGNED_OUT, '/dashboard')).toBe(
      `${SIGN_IN_PATH}?redirect=%2Fdashboard`,
    )
  })

  it('encodes the remembered path, so a query string cannot inject a parameter', () => {
    const target = resolveNavigation('protected', SIGNED_OUT, '/projects/a?tab=1&x=2')

    expect(target).toBe(`${SIGN_IN_PATH}?redirect=%2Fprojects%2Fa%3Ftab%3D1%26x%3D2`)
    expect(target?.match(/redirect=/g)).toHaveLength(1)
  })

  it('sends a signed-out visitor away from the gate — there is nothing to verify', () => {
    expect(resolveNavigation('gate', SIGNED_OUT, GATE_PATH)).toBe(SIGN_IN_PATH)
  })
})

describe('resolveNavigation — signed in but unverified', () => {
  /**
   * D27, and the reason `action` is its own class. Whoever follows a
   * verification link *is* signed in and unverified. Redirect them to the gate
   * and the code is never applied, so they can never leave the gate — a closed
   * loop with no way out.
   */
  it('lets an unverified user reach the action handler', () => {
    expect(resolveNavigation('action', UNVERIFIED, '/auth/action?mode=verifyEmail')).toBeNull()
  })

  it('lets an unverified user sit on the gate', () => {
    expect(resolveNavigation('gate', UNVERIFIED, GATE_PATH)).toBeNull()
  })

  it.each<RouteAccess>(['protected', 'auth-flow'])(
    'holds an unverified user at the gate from a %s route',
    (access) => {
      expect(resolveNavigation(access, UNVERIFIED, '/dashboard')).toBe(GATE_PATH)
    },
  )

  it('still allows public routes', () => {
    expect(resolveNavigation('public', UNVERIFIED, '/anything-public')).toBeNull()
  })
})

describe('resolveNavigation — verified', () => {
  it('lets a verified user into protected routes', () => {
    expect(resolveNavigation('protected', VERIFIED, '/dashboard')).toBeNull()
  })

  it.each<RouteAccess>(['auth-flow', 'gate'])(
    'sends a verified user away from a %s route',
    (access) => {
      expect(resolveNavigation(access, VERIFIED, '/signin')).toBe('/dashboard')
    },
  )

  it('leaves public and action routes alone', () => {
    expect(resolveNavigation('public', VERIFIED, '/anything-public')).toBeNull()
    expect(resolveNavigation('action', VERIFIED, '/auth/action')).toBeNull()
  })
})

describe('the matrix as a whole', () => {
  /**
   * Every combination resolves to something. A missing case would surface as a
   * navigation that silently does nothing, which is far harder to notice than a
   * wrong redirect.
   */
  it('decides every state and access pair', () => {
    const states = [SIGNED_OUT, UNVERIFIED, VERIFIED]
    const accesses: RouteAccess[] = ['public', 'auth-flow', 'gate', 'action', 'protected']

    for (const state of states) {
      for (const access of accesses) {
        const result = resolveNavigation(access, state, '/dashboard')
        expect(result === null || typeof result === 'string').toBe(true)
      }
    }
  })

  it('never sends anyone to the route they are already being turned away from', () => {
    expect(resolveNavigation('gate', VERIFIED, GATE_PATH)).not.toBe(GATE_PATH)
    expect(resolveNavigation('auth-flow', UNVERIFIED, SIGN_IN_PATH)).not.toBe(SIGN_IN_PATH)
  })
})

/*
 * AC-43. A user can be away at HighLevel for minutes; if the session lapses
 * while they are gone, the callback must not strand them. Classing the route
 * `protected` means the guard round-trips them through sign-in and returns
 * them here, so the outcome survives.
 */
describe('/hl/callback', () => {
  it('sends a signed-out visitor to sign in, and back again afterwards', () => {
    const target = resolveNavigation(
      'protected',
      { isSignedIn: false, isVerified: false },
      '/hl/callback?status=connected',
    )

    expect(target).toBe(`/signin?redirect=${encodeURIComponent('/hl/callback?status=connected')}`)
  })

  it('holds an unverified visitor at the gate', () => {
    expect(
      resolveNavigation('protected', { isSignedIn: true, isVerified: false }, '/hl/callback'),
    ).toBe(GATE_PATH)
  })

  it('lets a verified visitor through', () => {
    expect(
      resolveNavigation('protected', { isSignedIn: true, isVerified: true }, '/hl/callback'),
    ).toBeNull()
  })
})

/**
 * Which routes a user may be *returned to* — the allowlist `safeRedirect` is
 * handed, and a narrower thing than "every route we registered".
 *
 * `resolveNavigation` already says it, one way: only a `protected` route is
 * worth returning to, because the auth-flow pages and the gate are means, not
 * destinations. Both callers of `safeRedirect` were passing
 * `router.getRoutes().map((r) => r.path)` instead, so every registered route
 * was a legal `?redirect=` target — and one of them is `/auth/action`, the
 * single route exempt from the guard in every auth state, which executes a
 * Firebase action code straight off its query string.
 *
 * That made `/signin?redirect=%2Fauth%2Faction%3Fmode%3DresetPassword%26oobCode%3D<the
 * attacker's own reset code>` a working attack: the victim signs in with their
 * real password and is handed a "choose a new password" form bound to the
 * attacker's code. A password typed twice in thirty seconds is the common case,
 * and `confirmPasswordReset` then sets the *attacker's* account to the
 * *victim's* password. The `verifyEmail` variant is the quiet one — it gets an
 * attacker's address verified by the victim's click.
 */
describe('destinationPaths', () => {
  const ROUTES = [
    { path: '/', meta: { access: 'protected' } },
    { path: '/signup', meta: { access: 'auth-flow' } },
    { path: '/signin', meta: { access: 'auth-flow' } },
    { path: '/forgot-password', meta: { access: 'auth-flow' } },
    { path: '/auth/action', meta: { access: 'action' } },
    { path: '/verify-email', meta: { access: 'gate' } },
    { path: '/hl/callback', meta: { access: 'protected' } },
    { path: '/dashboard', meta: { access: 'protected' } },
    { path: '/projects/:projectId', meta: { access: 'protected' } },
    { path: '/:pathMatch(.*)*', meta: { access: 'protected' } },
  ] satisfies { path: string; meta: { access: RouteAccess } }[]

  it('refuses the routes that are means rather than destinations', () => {
    const paths = destinationPaths(ROUTES)

    expect(paths).not.toContain('/auth/action')
    expect(paths).not.toContain('/signin')
    expect(paths).not.toContain('/signup')
    expect(paths).not.toContain('/forgot-password')
    expect(paths).not.toContain('/verify-email')
  })

  /*
   * `/hl/callback` is `protected` on purpose (Slice 2): a session that lapsed
   * while the user was away at HighLevel round-trips through sign-in and comes
   * back to the outcome. Keying off `access` rather than a hand-written list is
   * what keeps that working without anyone having to remember it.
   */
  it('keeps every route a user could be sent back to', () => {
    expect(destinationPaths(ROUTES)).toEqual([
      '/',
      '/hl/callback',
      '/dashboard',
      '/projects/:projectId',
      '/:pathMatch(.*)*',
    ])
  })

  /* Same default the guard applies, so the two cannot disagree about a route
   * whose author forgot to classify it. */
  it('treats an unclassified route the way the guard does', () => {
    expect(destinationPaths([{ path: '/new-thing', meta: {} }])).toEqual(['/new-thing'])
  })
})
