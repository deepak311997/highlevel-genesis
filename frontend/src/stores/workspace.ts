import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { ApiError } from '@/lib/api'
import { streamGeneration } from '@/lib/generateApi'
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
 * **Appending the sent message is not a hole in the liveness rule** (D12). Slice
 * 3's projects store refetches after every mutation because that list is ordered
 * by `updatedAt` on the server, so a local splice would have to re-derive server
 * ordering and would eventually get it wrong. A transcript cannot be reordered: it
 * only ever appends, and the message the server just returned is by construction
 * its newest member — so appending *is* the server's order rather than an
 * approximation of it. What is rendered is the server's own response body, and
 * nothing here is `onSnapshot`. Refetching instead would re-read the whole history
 * on every turn, unboundedly, to re-read something that cannot have changed.
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
  /** Whether a generation stream is open. The composer keys off this. */
  generating: Ref<boolean>
  /**
   * The reply as it arrives, rendered as one placeholder bubble.
   *
   * **A plain `ref<string>` re-assigned per token** (D31). The accumulation trap
   * `typescript-vue.md` warns about is an array of objects pushed to thousands of
   * times, which makes every render walk the whole list; a string re-assignment
   * is one reactive write per token and one text node update. The tokens become a
   * `Message` exactly once, at the terminal event.
   */
  streamingText: Ref<string>
  /** Kept apart from `sendError`: one renders under the composer, one above it. */
  generateError: Ref<string | null>
  atLimit: ComputedRef<boolean>
  canSend: ComputedRef<boolean>
  open: (projectId: string) => Promise<void>
  loadMessages: () => Promise<void>
  send: () => Promise<void>
  /** Re-open the stream for the same transcript — no new user message (D26). */
  retryGeneration: () => Promise<void>
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

  const generating = ref(false)
  const streamingText = ref('')
  const generateError = ref<string | null>(null)

  /**
   * The in-flight generation's controller — **in the store, not the component**
   * (D31, and Slice 4's D17 for its reason).
   *
   * The `lg` breakpoint swaps one component tree for another, so a controller
   * held in the chat panel is dropped by a window resize while the stream it was
   * meant to cancel keeps writing. Not a `ref`: nothing renders it.
   */
  let controller: AbortController | null = null

  function abortGeneration(): void {
    controller?.abort()
    controller = null
  }

  const atLimit = computed(() => messages.value.length >= MESSAGE_LIMIT)
  const canSend = computed(
    () => draft.value.trim() !== '' && !sending.value && !generating.value && !atLimit.value,
  )

  /**
   * A 404 is a different state from any other failure, so it gets its own flag.
   *
   * `ApiError` is the only thing `apiClient.request` rejects with, and it carries
   * the status — which is what lets "that project no longer exists" render with a
   * Back link while a 500 renders with a Retry. Collapsing the two would offer a
   * retry for something that will never succeed. Narrowed on the class rather than
   * reaching for a `status` property through a cast: the type exists to carry this,
   * and a cast would also match any unrelated `Error` that happened to have one.
   */
  function isMissing(err: unknown): boolean {
    return err instanceof ApiError && err.status === 404
  }

  /**
   * Which open a request belongs to.
   *
   * **Every write that lands after an `await` is guarded by this**, because the store
   * is a singleton the route outlives: opening a project, going back, and opening
   * another leaves the first one's requests in flight against the second one's
   * screen. A response for a project that is no longer open is not merely stale, it
   * is wrong — it would put one project's name over another's transcript, blank the
   * view by clearing a loading flag belonging to the newer request, or append a send
   * to the wrong conversation.
   *
   * A counter rather than a comparison against `projectId`, because leaving a project
   * and coming back to it makes the id equal again while the first request's response
   * is still owed — and appending that turn a second time to a transcript that has
   * since been refetched puts a duplicate in the list. `reset()` bumps it too, so a
   * request in flight when the session ends cannot repopulate the store afterwards.
   *
   * Not a `ref`: nothing renders it, and making it reactive would invalidate every
   * computed that reads the store on each navigation for no gain.
   */
  let generation = 0

  function current(gen: number): boolean {
    return gen === generation
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
    /*
     * The draft and the send error are the two things a *different* project clears
     * and a re-open of the same one keeps. `open` is also what the workspace's Retry
     * button calls (AC-22), and throwing away what the user has typed is no part of
     * retrying a failed project fetch — but a draft written for one conversation, or
     * an error raised by it, has no business appearing under another's composer.
     */
    if (projectId.value !== id) {
      draft.value = ''
      sendError.value = null
    }

    const gen = ++generation

    /*
     * Any generation in flight is cancelled, whichever project it belonged to
     * (AC-37). `open` re-reads the whole transcript from the server, so a stream
     * still appending into `messages` is stale by construction — and a stream
     * left running would go on spending money for a screen nobody is looking at.
     */
    abortGeneration()

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
    generating.value = false
    streamingText.value = ''
    generateError.value = null

    try {
      const fetched = await getProject(id)
      if (!current(gen)) return
      project.value = fetched
    } catch (err) {
      if (!current(gen)) return
      if (isMissing(err)) {
        projectMissing.value = true
      } else {
        projectError.value = err instanceof Error ? err.message : 'Could not load this project.'
      }
      return
    } finally {
      // Only the request still on screen may say the loading is over. A stale one
      // clearing this leaves the view with no project and no failure to render.
      if (current(gen)) projectLoading.value = false
    }

    await loadMessages()
  }

  /** The transcript, on its own — this is what the chat panel's Retry calls. */
  async function loadMessages(): Promise<void> {
    const id = projectId.value
    if (id === null) return

    const gen = generation
    messagesLoading.value = true
    messagesError.value = null
    try {
      const fetched = await listMessages(id)
      if (!current(gen)) return
      messages.value = fetched
      messagesLoaded.value = true
    } catch (err) {
      if (!current(gen)) return
      // The list is left alone: a failed refetch should not empty a transcript
      // that already has messages in it.
      messagesError.value = err instanceof Error ? err.message : 'Could not load this conversation.'
    } finally {
      if (current(gen)) messagesLoading.value = false
    }
  }

  /**
   * Open `POST /generate` and consume it to its terminal event.
   *
   * Shared by `send()` and by the chat panel's **Retry**, which is the whole of
   * D26: the endpoint's only input is the transcript (D2), so retrying is
   * literally the same request again — no new user message, no special case.
   *
   * The three states it owns are cleared up front and restored in `finally`,
   * both guarded by `current(gen)`, so a stream belonging to a project the user
   * has since left cannot re-enable the composer of the one they are looking at.
   */
  async function runGeneration(): Promise<void> {
    const id = projectId.value
    if (id === null) return

    const gen = generation
    abortGeneration()
    // Held locally as well as in the store, so `finally` can tell "my own
    // controller" from "one a newer generation installed while I was awaiting".
    const ours = new AbortController()
    controller = ours

    generating.value = true
    streamingText.value = ''
    generateError.value = null

    try {
      for await (const event of streamGeneration(id, ours.signal)) {
        if (!current(gen)) return

        if (event.type === 'token') {
          // Re-assigned, not pushed to (D31). One reactive write per token.
          streamingText.value += event.text
          continue
        }

        if (event.type === 'done') {
          messages.value = [...messages.value, event.message]
          return
        }

        /*
         * An `error` carries the message the server actually **persisted**, or
         * `null` when nothing had been produced (D9). Appending the server's copy
         * rather than the client's accumulated text is what makes the interrupted
         * case the same rendering path as the successful one — and what stops an
         * id-less bubble that disagrees with the server on the next load.
         */
        if (event.type === 'error') {
          if (event.message !== null) messages.value = [...messages.value, event.message]
          generateError.value = event.error
          return
        }
      }
    } catch (err) {
      if (!current(gen)) return
      /*
       * A refusal decided before the server flushed its headers, or a dropped
       * connection. Both reach the same state as a mid-stream `error` event, so
       * the panel has one error to render and one Retry to offer.
       */
      generateError.value =
        err instanceof Error ? err.message : 'Could not generate a reply. Try again.'
    } finally {
      if (current(gen)) {
        streamingText.value = ''
        generating.value = false
      }
      if (controller === ours) controller = null
    }
  }

  /**
   * Send the draft, then generate a reply — two requests, in that order (D3).
   *
   * The message write comes first and the stream only opens if it succeeded, so
   * the user's prompt is durable before the expensive, failure-prone half
   * begins. That is the whole of F8.2: a generation that dies before producing a
   * byte still leaves a transcript the user recognises and a Retry that works.
   *
   * On a failed write **nothing is appended, the draft is kept, and no stream is
   * opened** (AC-33): a user who has written a page of prose must not lose it to
   * a 500, and generating a reply to a prompt that was never stored would attach
   * an answer to nothing.
   */
  async function send(): Promise<void> {
    const id = projectId.value
    const content = draft.value.trim()
    /*
     * The composer disables submit for all three of these, but the store is the
     * boundary a keyboard shortcut cannot go around — so it re-checks the same
     * three reasons `canSend` names rather than two of them.
     *
     * `generating` is the expensive one (D27). A second `send()` during an open
     * stream posts a message and opens a **second paid generation**, and
     * `runGeneration`'s abort of the first then lands on the second one's state:
     * `generating` cleared and an error raised for a request that is still
     * running. The draft is left alone, so the guard costs the user nothing.
     */
    if (id === null || content === '' || generating.value) return

    const gen = generation
    sending.value = true
    sendError.value = null
    try {
      const message = await sendMessage(id, content)
      // The turn belongs to the project it was sent to. If the route has moved on it
      // is already stored and will be read back on the way in — appending it here
      // would put one conversation's messages inside another's.
      if (!current(gen)) return
      messages.value = [...messages.value, message]
      // Cleared only on success, and only after the append, so a failure leaves
      // the textarea exactly as the user left it.
      draft.value = ''
    } catch (err) {
      if (!current(gen)) return
      sendError.value = err instanceof Error ? err.message : 'Could not send that message.'
      // No stream: there is nothing stored to generate from (AC-33).
      return
    } finally {
      /*
       * Unconditionally, unlike the loading flags above: there is only ever one send
       * in flight — `canSend` is false while this is true — so nothing newer owns
       * this flag, and leaving it set would disable the composer of whatever project
       * the user landed on until a reload.
       */
      sending.value = false
    }

    await runGeneration()
  }

  function reset(): void {
    // Bumped first: a request in flight when the session ends must not repopulate a
    // store that has just been emptied, which is the whole point of emptying it.
    generation += 1
    abortGeneration()
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
    generating.value = false
    streamingText.value = ''
    generateError.value = null
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
    generating,
    streamingText,
    generateError,
    atLimit,
    canSend,
    open,
    loadMessages,
    send,
    retryGeneration: runGeneration,
    reset,
  }
})
