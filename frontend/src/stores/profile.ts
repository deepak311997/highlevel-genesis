import { defineStore } from 'pinia'
import { ref, type Ref } from 'vue'

import { ensureProfile, getProfile, type Profile } from '@/lib/profileApi'

/**
 * The user's profile, as far as the browser can see it.
 *
 * Separate from the auth store on purpose: that one owns the Firebase session,
 * this one owns a resource fetched over HTTP. The split is what lets
 * `stores/auth.ts` have no data-access code in it at all, and it is the shape
 * the next resource store copies.
 *
 * Not a live subscription. `users/{uid}` is denied to every client, so this
 * state comes from an endpoint — a snapshot, refreshed after a mutation, rather
 * than something that updates itself.
 */
export interface ProfileStore {
  profile: Ref<Profile | null>
  loading: Ref<boolean>
  /** Whether a request has completed, successfully or not. */
  loaded: Ref<boolean>
  error: Ref<string | null>
  ensure: () => Promise<void>
  load: () => Promise<void>
  /** Forget everything fetched for the session that just ended. */
  reset: () => void
}

export const useProfileStore = defineStore('profile', (): ProfileStore => {
  const profile = ref<Profile | null>(null)
  /** True only while the *first* request is in flight, so a refetch does not blank the card. */
  const loading = ref(false)
  /**
   * "Fetched, and there is nothing" is a different state from "not fetched yet",
   * and the card renders them differently — an empty state versus a skeleton.
   * `profile === null` alone cannot tell them apart.
   */
  const loaded = ref(false)
  const error = ref<string | null>(null)

  async function run(fetcher: () => Promise<Profile | null>): Promise<void> {
    if (!loaded.value) loading.value = true
    error.value = null
    try {
      profile.value = await fetcher()
      loaded.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Could not load your profile.'
    } finally {
      loading.value = false
    }
  }

  /**
   * Create the profile if it is absent, touch it if it is not — run once per
   * verified session, from the three places that used to call
   * `authStore.ensureProfile()`.
   */
  function ensure(): Promise<void> {
    return run(ensureProfile)
  }

  /**
   * The read half of the contract.
   *
   * Nothing in this slice calls it: the dashboard ensures rather than reads, so
   * that one mount does not put two competing requests into one store. It exists
   * because it is the half the next resource store copies, and because it is the
   * only producer of the `loaded && profile === null` state the account card's
   * empty state renders.
   */
  function load(): Promise<void> {
    return run(getProfile)
  }

  /**
   * Everything here belongs to one signed-in user, and signing out is a route
   * change rather than a page load — so without this the next person to sign in
   * on the same browser sees the last one's address in the account card until
   * their own ensure lands. `loaded` matters as much as `profile`: left true, it
   * suppresses the loading state that would otherwise hide the stale value.
   */
  function reset(): void {
    profile.value = null
    loading.value = false
    loaded.value = false
    error.value = null
  }

  return { profile, loading, loaded, error, ensure, load, reset }
})
