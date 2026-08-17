import { defineStore } from 'pinia'
import { ref, type Ref } from 'vue'

import {
  createProject,
  deleteProject,
  listProjects,
  patchProject,
  type CreateProjectInput,
  type PatchProjectInput,
  type Project,
} from '@/lib/projectsApi'

/**
 * The user's projects, as far as the browser can see it.
 *
 * **Liveness is a refetch, not a subscription.** `users/{uid}/projects` is
 * denied to every client, so this state comes from an endpoint; and even if it
 * did not, splicing a mutation's returned project into the local array would
 * mean re-deriving the server's `updatedAt` ordering client-side, which
 * eventually gets it wrong. Each mutation therefore awaits its call and then
 * awaits `load()` — two round trips, deliberately (D14, `CLAUDE.md`).
 *
 * **A failed mutation rethrows and never sets `error`.** `error` belongs to the
 * list request and is what the card renders; a failed create belongs inside the
 * dialog that issued it. Setting both would put one message in two places, one
 * of which the user cannot dismiss.
 */
export interface ProjectsStore {
  projects: Ref<Project[]>
  loading: Ref<boolean>
  /** Whether a list request has completed, successfully or not. */
  loaded: Ref<boolean>
  /** True while a mutation is in flight — what disables the dialogs' buttons. */
  busy: Ref<boolean>
  error: Ref<string | null>
  load: () => Promise<void>
  create: (input: CreateProjectInput) => Promise<void>
  rename: (id: string, input: PatchProjectInput) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Forget everything fetched for the session that just ended. */
  reset: () => void
}

export const useProjectsStore = defineStore('projects', (): ProjectsStore => {
  const projects = ref<Project[]>([])
  /** True only while the *first* request is in flight, so a refetch does not blank the card. */
  const loading = ref(false)
  /**
   * "Fetched, and there is nothing" is a different state from "not fetched
   * yet", and the card renders them differently — an empty state versus a
   * skeleton. An empty array alone cannot tell them apart.
   */
  const loaded = ref(false)
  const busy = ref(false)
  const error = ref<string | null>(null)

  async function load(): Promise<void> {
    if (!loaded.value) loading.value = true
    error.value = null
    try {
      projects.value = await listProjects()
      loaded.value = true
    } catch (err) {
      // The list is left alone: a failed refetch should not empty a card that
      // already has rows in it.
      error.value = err instanceof Error ? err.message : 'Could not load your projects.'
    } finally {
      loading.value = false
    }
  }

  /**
   * Run a mutation, then refetch. Rethrows on failure without touching `error`,
   * so the dialog that issued the call is the one that renders the message.
   */
  async function mutate(action: () => Promise<unknown>): Promise<void> {
    busy.value = true
    try {
      await action()
      await load()
    } finally {
      busy.value = false
    }
  }

  function create(input: CreateProjectInput): Promise<void> {
    return mutate(() => createProject(input))
  }

  function rename(id: string, input: PatchProjectInput): Promise<void> {
    return mutate(() => patchProject(id, input))
  }

  function remove(id: string): Promise<void> {
    return mutate(() => deleteProject(id))
  }

  function reset(): void {
    projects.value = []
    loading.value = false
    loaded.value = false
    busy.value = false
    error.value = null
  }

  return { projects, loading, loaded, busy, error, load, create, rename, remove, reset }
})
