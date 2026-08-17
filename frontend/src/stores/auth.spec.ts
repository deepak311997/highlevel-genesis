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
const { useProfileStore } = await import('./profile')
const { useHlStore } = await import('./hl')
const { useProjectsStore } = await import('./projects')
const { useWorkspaceStore } = await import('./workspace')

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

  /*
   * Signing out is a route change, not a page load: Pinia survives it, and so
   * does everything the previous session fetched. Without this, the next person
   * to sign in on the same browser gets the dashboard rendered from the last
   * one's data — their address in the account card, their location in the
   * connection panel — until each refetch lands, which on a cold function is
   * seconds of one user's details on another user's screen.
   *
   * Cleared here rather than in each view, because the session ends in exactly
   * one place and a sign-out button added later must not have to remember.
   */
  it('empties the stores holding the previous session’s data', async () => {
    const store = useAuthStore()
    const profile = useProfileStore()
    const hl = useHlStore()
    signOut.mockResolvedValue(undefined)

    profile.profile = {
      email: 'alice@example.test',
      displayName: null,
      createdAt: '',
      updatedAt: '',
    }
    profile.loaded = true
    hl.status = { connected: false }

    await store.signOutNow()

    expect(profile.profile).toBeNull()
    expect(profile.loaded).toBe(false)
    expect(hl.status).toBeNull()
  })

  /* Every resource store joins this list; there is nowhere else it can be
   * forgotten, which is the whole reason sign-out owns the clearing. */
  it('empties the project list too', async () => {
    const store = useAuthStore()
    const projects = useProjectsStore()
    signOut.mockResolvedValue(undefined)

    projects.projects = [
      {
        id: 'proj-1',
        name: 'Contact dashboard',
        description: null,
        locationId: null,
        createdAt: '',
        updatedAt: '',
      },
    ]
    projects.loaded = true

    await store.signOutNow()

    expect(projects.projects).toEqual([])
    expect(projects.loaded).toBe(false)
  })

  /* And the workspace: a transcript is one account's conversation, and the draft
   * is one person's unsent words. Neither belongs to whoever signs in next. */
  it('empties the workspace too', async () => {
    const store = useAuthStore()
    const workspace = useWorkspaceStore()
    signOut.mockResolvedValue(undefined)

    workspace.projectId = 'proj-1'
    workspace.project = {
      id: 'proj-1',
      name: 'Contact dashboard',
      description: null,
      locationId: null,
      createdAt: '',
      updatedAt: '',
    }
    workspace.messages = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'build a contact dashboard',
        createdAt: '',
        truncated: false,
      },
    ]
    workspace.messagesLoaded = true
    workspace.draft = 'half a sentence'

    await store.signOutNow()

    expect(workspace.project).toBeNull()
    expect(workspace.projectId).toBeNull()
    expect(workspace.messages).toEqual([])
    expect(workspace.messagesLoaded).toBe(false)
    expect(workspace.draft).toBe('')
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
