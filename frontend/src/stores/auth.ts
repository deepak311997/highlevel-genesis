import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { auth, db } from '@/lib/firebase'

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
export const USERS_COLLECTION = 'users'

export interface AuthStore {
  user: Ref<User | null>
  initialised: Ref<boolean>
  ready: Promise<void>
  isSignedIn: ComputedRef<boolean>
  isVerified: ComputedRef<boolean>
  email: ComputedRef<string | null>
  signIn: (email: string, password: string) => Promise<void>
  signOutNow: () => Promise<void>
  refreshVerification: () => Promise<boolean>
  ensureProfile: () => Promise<void>
}

export const useAuthStore = defineStore('auth', (): AuthStore => {
  const user = ref<User | null>(null)
  const initialised = ref(false)

  let settle: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    settle = resolve
  })

  onAuthStateChanged(auth, (next) => {
    user.value = next
    if (!initialised.value) {
      initialised.value = true
      settle()
    }
  })

  const isSignedIn = computed(() => user.value !== null)
  const isVerified = computed(() => user.value?.emailVerified === true)
  const email = computed(() => user.value?.email ?? null)

  async function signIn(address: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(auth, address, password)
  }

  async function signOutNow(): Promise<void> {
    await signOut(auth)
  }

  /**
   * Re-read the account and force a fresh ID token.
   *
   * Both halves are required. `reload()` updates this User object, but
   * `emailVerified` also travels as a *claim inside the ID token*, and that
   * token does not refresh on its own — Firestore rules read the claim, so
   * without `getIdToken(true)` a just-verified user reaches the dashboard and
   * then has every read denied by a stale claim.
   */
  async function refreshVerification(): Promise<boolean> {
    const current = user.value
    if (current === null) return false

    await current.reload()
    await current.getIdToken(true)
    return current.emailVerified
  }

  /**
   * Create or touch `users/{uid}`.
   *
   * Idempotent and run at the start of every verified session, so a sign-up
   * interrupted before the document was written heals itself on the next visit
   * rather than leaving an account with no profile.
   *
   * Never runs while unverified: the rules require the `email_verified` claim
   * on create, so an early call could only ever be denied.
   *
   * Failure is swallowed. This document is a convenience, not a precondition
   * for having a session — refusing to let someone in because a profile write
   * failed would trade a real capability for a cosmetic one.
   */
  async function ensureProfile(): Promise<void> {
    const current = user.value
    if (current?.emailVerified !== true) return

    const ref = doc(db, USERS_COLLECTION, current.uid)
    try {
      const snapshot = await getDoc(ref)
      if (snapshot.exists()) {
        // Only the two mutable fields; the rules reject anything touching
        // `email` or `createdAt`.
        await updateDoc(ref, { updatedAt: serverTimestamp() })
      } else {
        await setDoc(ref, {
          email: current.email ?? '',
          displayName: current.displayName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      }
    } catch {
      // Intentionally silent — see above.
    }
  }

  return {
    user,
    initialised,
    ready,
    isSignedIn,
    isVerified,
    email,
    signIn,
    signOutNow,
    refreshVerification,
    ensureProfile,
  }
})
