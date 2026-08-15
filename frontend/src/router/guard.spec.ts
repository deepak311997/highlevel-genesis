import { describe, expect, it } from 'vitest'

import { GATE_PATH, resolveNavigation, SIGN_IN_PATH, type RouteAccess } from './guard'

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
