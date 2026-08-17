import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { listMessages, sendMessage, MESSAGE_LIMIT, type Message } from '@/lib/messagesApi'
import { getProject, type Project } from '@/lib/projectsApi'

/**
 * One project and its conversation, as far as the browser can see it.
 *
 * **One store, not two** (D24). The project and its transcript share a lifecycle:
 * same `projectId`, loaded together, reset together. Two stores that must be reset
 * in lockstep is a bug with a countdown on it.
 *
 * **The draft lives here rather than in the composer** (D17, R8), and that is the
 * reason this store holds a piece of form state at all. The `lg` breakpoint swaps
 * one component tree for another — the resizable panels above it, tabs below — so
 * anything held in a composer is eaten by a window resize. That is invisible in
 * review and infuriating in use, and the pattern is set here before Slice 5 has
 * streaming state to lose to the same swap.
 *
 * **Appending the sent pair is not a hole in the liveness rule** (D12). Slice 3's
 * projects store refetches after every mutation because that list is ordered by
 * `updatedAt` on the server, so a local splice would have to re-derive server
 * ordering and would eventually get it wrong. A transcript cannot be reordered: it
 * only ever appends, and the two messages the server just returned are by
 * construction its two newest members — so appending *is* the server's order
 * rather than an approximation of it. What is rendered is the server's own
 * response body, and nothing here is `onSnapshot`. Refetching instead would re-read
 * the whole history on every turn, unboundedly, to re-read something that cannot
 * have changed.
 *
 * The project is fetched by this store rather than read from the projects store
 * (D26): a deep link, a reload or a bookmark arrives with an empty store, and a
 * store populated only when you came from the dashboard is worse than one that
 * never is, because only one of those two paths gets tested.
 */
export interface WorkspaceStore {
  projectId: Ref<string | null>
  project: Ref<Project | null>
  projectLoading: Ref<boolean>
  /** The 404, kept apart from `projectError`: one screen has a Back link, the other a Retry. */
  projectMissing: Ref<boolean>
  projectError: Ref<string | null>
  messages: Ref<Message[]>
  messagesLoading: Ref<boolean>
  /** Whether a transcript request has completed, successfully or not. */
  messagesLoaded: Ref<boolean>
  messagesError: Ref<string | null>
  draft: Ref<string>
  sending: Ref<boolean>
  sendError: Ref<string | null>
  atLimit: ComputedRef<boolean>
  canSend: ComputedRef<boolean>
  open: (projectId: string) => Promise<void>
  loadMessages: () => Promise<void>
  send: () => Promise<void>
  /** Forget everything fetched for the session that just ended. */
  reset: () => void
}

export const useWorkspaceStore = defineStore('workspace', (): WorkspaceStore => {
  const projectId = ref<string | null>(null)
  const project = ref<Project | null>(null)
  const projectLoading = ref(false)
  const projectMissing = ref(false)
  const projectError = ref<string | null>(null)

  const messages = ref<Message[]>([])
  const messagesLoading = ref(false)
  const messagesLoaded = ref(false)
  const messagesError = ref<string | null>(null)

  const draft = ref('')
  const sending = ref(false)
  const sendError = ref<string | null>(null)

  const atLimit = computed(() => messages.value.length >= MESSAGE_LIMIT)
  const canSend = computed(() => draft.value.trim() !== '' && !sending.value && !atLimit.value)

  /**
   * A 404 is a different state from any other failure, so it gets its own flag.
   *
   * `ApiError` carries the status, which is what lets "that project no longer
   * exists" render with a Back link while a 500 renders with a Retry. Collapsing
   * the two would offer a retry for something that will never succeed.
   */
  function isMissing(err: unknown): boolean {
    return err instanceof Error && (err as { status?: number }).status === 404
  }

  /**
   * Open a project: the project first, its transcript only if that resolves.
   *
   * **Sequential on purpose** (D25). Fetched in parallel, a deleted project
   * produces two 404s and the view has to decide which of them it is rendering;
   * fetched in sequence there is one answer, and no request is issued for a
   * transcript that cannot exist. The cost is one extra round trip to the same
   * region on the happy path, which is the cheaper of the two prices.
   */
  async function open(id: string): Promise<void> {
    // Everything belonging to whatever was open before, cleared up front — a
    // second project must not render the first one's transcript while it loads.
    projectId.value = id
    project.value = null
    projectMissing.value = false
    projectError.value = null
    messages.value = []
    messagesLoaded.value = false
    messagesError.value = null
    projectLoading.value = true

    try {
      project.value = await getProject(id)
    } catch (err) {
      if (isMissing(err)) {
        projectMissing.value = true
      } else {
        projectError.value = err instanceof Error ? err.message : 'Could not load this project.'
      }
      return
    } finally {
      projectLoading.value = false
    }

    await loadMessages()
  }

  /** The transcript, on its own — this is what the chat panel's Retry calls. */
  async function loadMessages(): Promise<void> {
    const id = projectId.value
    if (id === null) return

    messagesLoading.value = true
    messagesError.value = null
    try {
      messages.value = await listMessages(id)
      messagesLoaded.value = true
    } catch (err) {
      // The list is left alone: a failed refetch should not empty a transcript
      // that already has messages in it.
      messagesError.value = err instanceof Error ? err.message : 'Could not load this conversation.'
    } finally {
      messagesLoading.value = false
    }
  }

  /**
   * Send the draft, and append the turn the server wrote.
   *
   * On failure **nothing is appended and the draft is kept** (AC-34): a user who
   * has written a page of prose must not lose it to a 500, and re-submitting has
   * to be able to send the same text again.
   */
  async function send(): Promise<void> {
    const id = projectId.value
    const content = draft.value.trim()
    // The composer disables submit for both of these, but the store is the
    // boundary a keyboard shortcut cannot go around.
    if (id === null || content === '') return

    sending.value = true
    sendError.value = null
    try {
      const pair = await sendMessage(id, content)
      messages.value = [...messages.value, ...pair]
      // Cleared only on success, and only after the append, so a failure leaves
      // the textarea exactly as the user left it.
      draft.value = ''
    } catch (err) {
      sendError.value = err instanceof Error ? err.message : 'Could not send that message.'
    } finally {
      sending.value = false
    }
  }

  function reset(): void {
    projectId.value = null
    project.value = null
    projectLoading.value = false
    projectMissing.value = false
    projectError.value = null
    messages.value = []
    messagesLoading.value = false
    messagesLoaded.value = false
    messagesError.value = null
    draft.value = ''
    sending.value = false
    sendError.value = null
  }

  return {
    projectId,
    project,
    projectLoading,
    projectMissing,
    projectError,
    messages,
    messagesLoading,
    messagesLoaded,
    messagesError,
    draft,
    sending,
    sendError,
    atLimit,
    canSend,
    open,
    loadMessages,
    send,
    reset,
  }
})
