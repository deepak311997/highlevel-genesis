import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from 'firebase/auth'

const onAuthStateChanged = vi.hoisted(() => vi.fn())
const signInWithEmailAndPassword = vi.hoisted(() => vi.fn())
const signOut = vi.hoisted(() => vi.fn())

vi.mock('@/lib/firebase', () => ({ auth: { name: 'auth' } }))

vi.mock('firebase/auth', () => ({
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
}))

const { useAuthStore } = await import('./auth')

/** Hand the store a user, as Firebase would. */
function emit(user: Partial<User> | null): void {
  const listener = onAuthStateChanged.mock.calls.at(-1)?.[1] as (u: unknown) => void
  listener(user)
}

function fakeUser(overrides: Partial<User> = {}): Partial<User> {
  return {
    uid: 'alice',
    email: 'alice@example.test',
    displayName: null,
    emailVerified: true,
    reload: vi.fn(),
    getIdToken: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ready', () => {
  /**
   * The property the router depends on. If `ready` resolved before Firebase had
   * spoken, the guard would read "signed out" during the gap and bounce every
   * refresh of a protected route through the sign-in screen.
   */
  it('does not resolve before Firebase reports an auth state', async () => {
    const store = useAuthStore()
    let settled = false
    void store.ready.then(() => (settled = true))

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(store.initialised).toBe(false)
  })

  it('resolves once Firebase reports, including when nobody is signed in', async () => {
    const store = useAuthStore()

    emit(null)
    await store.ready

    expect(store.initialised).toBe(true)
    expect(store.isSignedIn).toBe(false)
  })
})

describe('session state', () => {
  it('tracks the signed-in user', () => {
    const store = useAuthStore()

    emit(fakeUser())

    expect(store.isSignedIn).toBe(true)
    expect(store.isVerified).toBe(true)
    expect(store.email).toBe('alice@example.test')
  })

  it('distinguishes a signed-in but unverified user', () => {
    const store = useAuthStore()

    emit(fakeUser({ emailVerified: false }))

    expect(store.isSignedIn).toBe(true)
    expect(store.isVerified).toBe(false)
  })

  // A second tab signing out is just another emission; nothing special.
  it('clears state when the session ends anywhere', () => {
    const store = useAuthStore()
    emit(fakeUser())

    emit(null)

    expect(store.isSignedIn).toBe(false)
    expect(store.email).toBeNull()
  })

  it('signs out through Firebase', async () => {
    const store = useAuthStore()
    signOut.mockResolvedValue(undefined)

    await store.signOutNow()

    expect(signOut).toHaveBeenCalledOnce()
  })

  it('signs in through Firebase', async () => {
    const store = useAuthStore()
    signInWithEmailAndPassword.mockResolvedValue({})

    await store.signIn('alice@example.test', 'A-Password-1')

    expect(signInWithEmailAndPassword).toHaveBeenCalledWith(
      expect.anything(),
      'alice@example.test',
      'A-Password-1',
    )
  })
})

describe('refreshVerification', () => {
  /**
   * The stale-claim trap. `emailVerified` travels as a claim inside the ID
   * token, and Firestore rules read the claim — reloading the user without
   * forcing a new token leaves every read denied on a freshly verified account.
   */
  it('reloads the user and forces a new ID token', async () => {
    const user = fakeUser({ emailVerified: true })
    const store = useAuthStore()
    emit(user)

    await store.refreshVerification()

    expect(user.reload).toHaveBeenCalledOnce()
    expect(user.getIdToken).toHaveBeenCalledWith(true)
  })

  it('reports whether the account is now verified', async () => {
    const store = useAuthStore()
    emit(fakeUser({ emailVerified: false }))

    await expect(store.refreshVerification()).resolves.toBe(false)
  })

  it('does nothing without a session', async () => {
    const store = useAuthStore()
    emit(null)

    await expect(store.refreshVerification()).resolves.toBe(false)
  })
})
