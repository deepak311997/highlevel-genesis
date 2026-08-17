import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { auth } from '@/lib/firebase'
import { useHlStore } from '@/stores/hl'
import { useProfileStore } from '@/stores/profile'
import { useProjectsStore } from '@/stores/projects'

/**
 * Session state, and the one thing the router cannot work without: a promise
 * that resolves once Firebase has said whether anybody is signed in.
 *
 * `onAuthStateChanged` fires asynchronously after page load, so for the first
 * few frames "signed out" and "not known yet" look identical. A guard that
 * cannot tell them apart bounces every refresh of a protected route to the
 * sign-in screen and then back — which is the flash the `ready` promise exists
 * to remove.
 */
export interface AuthStore {
  user: Ref<User | null>
  initialised: Ref<boolean>
  ready: Promise<void>
  isSignedIn: ComputedRef<boolean>
  isVerified: ComputedRef<boolean>
  email: ComputedRef<string | null>
  verificationSent: Ref<boolean>
  markVerificationSent: () => void
  signIn: (email: string, password: string) => Promise<void>
  signOutNow: () => Promise<void>
  refreshVerification: () => Promise<boolean>
}

export const useAuthStore = defineStore('auth', (): AuthStore => {
  const user = ref<User | null>(null)
  const initialised = ref(false)

  /**
   * Whether the gate has already sent a verification email this session.
   *
   * Lives here rather than in the component so a remount — a route change, a
   * bounce through the guard — does not send a second email. Reset whenever the
   * session changes, so signing in as someone else sends theirs.
   */
  const verificationSent = ref(false)

  let settle: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    settle = resolve
  })

  onAuthStateChanged(auth, (next) => {
    if (next?.uid !== user.value?.uid) verificationSent.value = false
    user.value = next
    if (!initialised.value) {
      initialised.value = true
      settle()
    }
  })

  const isSignedIn = computed(() => user.value !== null)
  const isVerified = computed(() => user.value?.emailVerified === true)
  const email = computed(() => user.value?.email ?? null)

  function markVerificationSent(): void {
    verificationSent.value = true
  }

  async function signIn(address: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(auth, address, password)
  }

  /**
   * End the session, and empty what the session filled.
   *
   * Signing out is a route change, not a page load, so Pinia survives it along
   * with everything the previous user fetched. The next person to sign in on the
   * same browser would otherwise get a dashboard rendered from the last one's
   * data — their address in the account card, their CRM location in the
   * connection panel — until each refetch lands.
   *
   * This is lifecycle, not data access: the auth store still knows nothing about
   * how a profile or a connection is loaded, only that both belong to a session
   * that has just ended. Doing it here rather than in each view is what stops
   * the next sign-out button, and the next resource store, from having to
   * remember. A store added later joins this list; there is nowhere else it can
   * be forgotten.
   */
  async function signOutNow(): Promise<void> {
    await signOut(auth)
    useProfileStore().reset()
    useHlStore().reset()
    useProjectsStore().reset()
  }

  /**
   * Re-read the account and force a fresh ID token.
   *
   * Both halves are required. `reload()` updates this User object, but
   * `emailVerified` also travels as a *claim inside the ID token*, and that
   * token does not refresh on its own — every API route reads the claim through
   * `withVerifiedUser`, so without `getIdToken(true)` a just-verified user
   * reaches the dashboard and then has every request answered 403 by a stale
   * claim.
   */
  async function refreshVerification(): Promise<boolean> {
    const current = user.value
    if (current === null) return false

    await current.reload()
    await current.getIdToken(true)
    return current.emailVerified
  }

  return {
    user,
    initialised,
    ready,
    isSignedIn,
    isVerified,
    email,
    verificationSent,
    markVerificationSent,
    signIn,
    signOutNow,
    refreshVerification,
  }
})
