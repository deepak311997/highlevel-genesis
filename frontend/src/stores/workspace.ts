import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { ApiError } from '@/lib/api'
import { mergeFileTree, type FileRow } from '@/lib/files'
import { getFile, listFiles, saveFile as putFile, type FileMeta } from '@/lib/filesApi'
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
  /**
   * The project's files — **metadata only** (D19).
   *
   * The list route carries no `content`, so opening a workspace does not ship
   * 20 × 100 KB of code nobody has clicked on. A file's bytes arrive when it is
   * selected, and nowhere else.
   */
  files: Ref<FileMeta[]>
  filesLoading: Ref<boolean>
  /** Whether a list request has completed, successfully or not. */
  filesLoaded: Ref<boolean>
  filesError: Ref<string | null>
  /** The file open in the editor, or `null` when nothing is selected. */
  selectedPath: Ref<string | null>
  /** The editor's buffer — what the user has. Two-way bound by `FileEditor`. */
  fileContent: Ref<string>
  /** What the server last said this file was. `fileDirty` is the two disagreeing. */
  savedContent: Ref<string>
  fileDirty: ComputedRef<boolean>
  fileLoading: Ref<boolean>
  fileError: Ref<string | null>
  saving: Ref<boolean>
  /** Kept apart from `fileError`: one renders beside Save, one instead of the editor. */
  saveError: Ref<string | null>
  /**
   * The bytes of the current generation, per path — **watched, not stored** (D20).
   *
   * A mutated `Record` rather than a re-assigned object: a chunk arrives per
   * frame, and replacing the whole object on each one would invalidate every
   * computed reading any file's buffer instead of just the one that changed.
   * Emptied at the end of every generation, whichever way it ended.
   */
  streamingFiles: Ref<Record<string, string>>
  /** The tree the panel renders: stored ∪ streaming, streaming marked. */
  fileTree: ComputedRef<FileRow[]>
  /** What the editor shows — the streaming buffer while one exists, else the file. */
  editorContent: ComputedRef<string>
  /** D22's notice: an unsaved edit was discarded by a generation that rewrote it. */
  fileReplaced: Ref<boolean>
  /** The last generation's `fileError`, kept apart from `generateError`. */
  generateFileError: Ref<string | null>
  atLimit: ComputedRef<boolean>
  canSend: ComputedRef<boolean>
  open: (projectId: string) => Promise<void>
  loadMessages: () => Promise<void>
  /** The file tree's Try again — this action and nothing else. */
  loadFiles: () => Promise<void>
  selectFile: (path: string) => Promise<void>
  saveFile: () => Promise<void>
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

  const files = ref<FileMeta[]>([])
  const filesLoading = ref(false)
  const filesLoaded = ref(false)
  const filesError = ref<string | null>(null)

  const selectedPath = ref<string | null>(null)
  const fileContent = ref('')
  const savedContent = ref('')
  const fileLoading = ref(false)
  const fileError = ref<string | null>(null)
  const saving = ref(false)
  const saveError = ref<string | null>(null)

  /**
   * Dirty is **derived**, not maintained.
   *
   * A boolean would have to be set on every edit path and cleared on every load
   * and save path, and the first one anybody forgets either enables Save for an
   * unchanged file or, much worse, leaves it disabled over an edit. A comparison
   * cannot go stale, and it also makes typing a change and typing it back read as
   * clean — which is the truth.
   */
  const fileDirty = computed(() => fileContent.value !== savedContent.value)

  const streamingFiles = ref<Record<string, string>>({})
  const fileReplaced = ref(false)
  const generateFileError = ref<string | null>(null)

  /**
   * The path **this generation** selected on the user's behalf, if any.
   *
   * `file_start` selects into an empty panel; it does not fetch, because the
   * bytes are already arriving. So a selection made that way has an empty
   * `savedContent` until `done` re-reads it — and if the turn's ops are refused
   * there is no re-read, which would leave an empty textarea over a file that
   * has content, with the first keystroke making it dirty and **Save** offering
   * to replace the real file with what was typed.
   *
   * Remembering whose selection it was is what tells the two apart at `done`:
   * the generation's own goes back to nothing, and the user's is never touched.
   * Not a `ref`: nothing renders it.
   */
  let autoSelected: string | null = null

  const fileTree = computed(() => mergeFileTree(files.value, Object.keys(streamingFiles.value)))

  /**
   * The streaming buffer wins while the file is being written.
   *
   * A file being written for the first time has no stored content to show, and
   * one being rewritten has content that is about to be replaced — either way the
   * bytes arriving are the truthful thing to render. The textarea is `disabled`
   * for exactly this window (D21), so nothing here can be edited out from under
   * the stream.
   */
  const editorContent = computed(() => {
    const path = selectedPath.value
    if (path === null) return ''
    return streamingFiles.value[path] ?? fileContent.value
  })

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
    clearFileState()

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
    /*
     * Unconditionally, and after the transcript rather than instead of it: a
     * failed transcript is the chat panel's error state, and the code panel has
     * no business being empty because of it. Sequential for the same reason the
     * project comes first — two requests racing to set two panels' loading flags
     * make the order they finish in visible in the UI for no gain.
     */
    await loadFiles()
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
   * The file tree, on its own — the code panel's **Try again**, and what a
   * finished generation refetches (D20).
   */
  async function loadFiles(): Promise<void> {
    const id = projectId.value
    if (id === null) return

    const gen = generation
    filesLoading.value = true
    filesError.value = null
    try {
      const fetched = await listFiles(id)
      if (!current(gen)) return
      files.value = fetched
      filesLoaded.value = true
    } catch (err) {
      if (!current(gen)) return
      // The list is left alone. A failed refetch emptying the tree would say
      // "this project has no code", which is a different claim from "we could
      // not reach the server" and a much worse one to make wrongly.
      filesError.value = err instanceof Error ? err.message : 'Could not load these files.'
    } finally {
      if (current(gen)) filesLoading.value = false
    }
  }

  /**
   * Open a file in the editor: the selection first, then its bytes.
   *
   * The buffer is cleared before the request goes out. Left in place, the
   * previous file's code would render under the new filename for the length of a
   * round trip — one file's contents labelled as another's, which is a worse
   * screen than an empty one.
   */
  async function selectFile(path: string): Promise<void> {
    const id = projectId.value
    if (id === null) return

    const gen = generation
    selectedPath.value = path
    // A deliberate choice, so no generation may take it back.
    autoSelected = null
    fileContent.value = ''
    savedContent.value = ''
    fileError.value = null
    saveError.value = null
    // The notice belongs to the file it was raised for, and D22 promised it stays
    // "until the user selects another file" — this is that sentence.
    fileReplaced.value = false
    fileLoading.value = true
    try {
      const file = await getFile(id, path)
      if (!current(gen)) return
      fileContent.value = file.content
      savedContent.value = file.content
    } catch (err) {
      if (!current(gen)) return
      fileError.value = err instanceof Error ? err.message : 'Could not load that file.'
    } finally {
      if (current(gen)) fileLoading.value = false
    }
  }

  /**
   * Save the buffer, and take **the server's answer** back (D20).
   *
   * The response replaces the buffer rather than the buffer being assumed
   * correct: the server owns `size` and both timestamps and is free to store
   * something other than exactly what was sent. Trusting the local copy is how
   * an editor ends up showing a document that disagrees with the server until a
   * reload — silently, which is the failure mode this slice's risk register
   * names twice.
   *
   * A failed save keeps the buffer and its dirty flag. Clearing either would
   * throw away an edit *because* it could not be stored, which is the one
   * outcome a save must never have.
   */
  async function saveFile(): Promise<void> {
    const id = projectId.value
    const path = selectedPath.value
    /*
     * A second save while one is in flight would race its own response, and the
     * later reply — which may be the earlier request — would win.
     *
     * `generating` is the one that matters (D21, R4). A generation's batch and
     * this `PUT` are two writers for one document, and the failure is silent:
     * the user types, the batch commits, the refetch replaces the buffer, and
     * the edit is gone with nothing to blame. The editor is read-only for the
     * seconds a stream is open, and this is the store re-checking the same rule
     * the component renders — a keyboard shortcut does not go through the button.
     */
    if (id === null || path === null || saving.value || generating.value) return

    const gen = generation
    saving.value = true
    saveError.value = null
    try {
      const file = await putFile(id, path, fileContent.value)
      if (!current(gen)) return
      fileContent.value = file.content
      savedContent.value = file.content
      // The list's entry for this file is now stale in `size` and `updatedAt`,
      // and the response is the server's own word for both — so it is applied
      // here rather than paid for with a second `GET`.
      files.value = files.value.map((entry) =>
        entry.path === file.path
          ? {
              path: file.path,
              size: file.size,
              createdAt: file.createdAt,
              updatedAt: file.updatedAt,
            }
          : entry,
      )
    } catch (err) {
      if (!current(gen)) return
      saveError.value = err instanceof Error ? err.message : 'Could not save that file.'
    } finally {
      if (current(gen)) saving.value = false
    }
  }

  /**
   * What a finished generation does to the code panel (D20).
   *
   * A non-empty `files` is the signal to go and ask, and it is load-bearing
   * rather than dogmatic: the server *repairs* content and computes `size` and
   * both timestamps, so the bytes the browser watched arrive are not necessarily
   * the bytes that were stored. Slice 4's append-the-response argument does not
   * transfer — a message is exactly what the server returned, a file is a
   * transformed version of what streamed.
   *
   * An empty `files` issues no request at all: nothing was written, so there is
   * no answer that could have changed.
   */
  async function applyGenerationFiles(written: string[], gen: number): Promise<void> {
    if (written.length > 0) await loadFiles()
    if (!current(gen)) return

    const path = selectedPath.value
    if (path === null) return

    if (written.includes(path)) {
      /*
       * The open file was rewritten, so its buffer is stale whatever state it
       * was in. A dirty one is discarded — the window is narrow, because the
       * panel is read-only while a stream is open (D21), so this is an edit
       * typed before the send — and the discard is **announced** (D22). Silence
       * is the one outcome that is not acceptable; a merge UI is a slice of its
       * own.
       */
      const wasDirty = fileDirty.value
      const id = projectId.value
      if (id === null) return
      await reReadSelected(id, path, gen)
      if (current(gen)) fileReplaced.value = wasDirty
      return
    }

    /*
     * The selection this generation made for itself, on a turn that stored
     * nothing. Two shapes, and the second is the dangerous one:
     *
     * - a path that streamed but was never stored — a refused op set, or an
     *   unterminated block — which leaves a filename with no file behind it;
     * - a path the project **already holds**, whose buffer was never read,
     *   because `file_start` selects and does not fetch. Left selected it shows
     *   an empty textarea over a file with content, and the first keystroke
     *   makes it dirty enough for **Save** to offer to replace that file with
     *   what was typed.
     *
     * Both go back to no selection, which is where the panel was before the
     * generation borrowed it — and no request is issued (AC-40).
     *
     * A selection the **user** made is never touched here, dirty included:
     * re-reading or dropping it would discard an edit for a reason they cannot
     * see and the server never asked for.
     */
    if (autoSelected === path || !files.value.some((entry) => entry.path === path)) {
      selectedPath.value = null
      autoSelected = null
      fileContent.value = ''
      savedContent.value = ''
    }
  }

  /** The re-read of an open file, without `selectFile`'s clear-and-select. */
  async function reReadSelected(id: string, path: string, gen: number): Promise<void> {
    fileLoading.value = true
    fileError.value = null
    try {
      const file = await getFile(id, path)
      if (!current(gen)) return
      fileContent.value = file.content
      savedContent.value = file.content
    } catch (err) {
      if (!current(gen)) return
      fileError.value = err instanceof Error ? err.message : 'Could not load that file.'
    } finally {
      if (current(gen)) fileLoading.value = false
    }
  }

  /** Every file field back to its initial value — shared by `open` and `reset`. */
  function clearFileState(): void {
    files.value = []
    filesLoading.value = false
    filesLoaded.value = false
    filesError.value = null
    selectedPath.value = null
    autoSelected = null
    fileContent.value = ''
    savedContent.value = ''
    fileLoading.value = false
    fileError.value = null
    saving.value = false
    saveError.value = null
    streamingFiles.value = {}
    fileReplaced.value = false
    generateFileError.value = null
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
    streamingFiles.value = {}
    generateFileError.value = null
    fileReplaced.value = false
    // Whatever the last generation selected for itself is the last generation's
    // business; this one has borrowed nothing yet.
    autoSelected = null

    try {
      for await (const event of streamGeneration(id, ours.signal)) {
        if (!current(gen)) return

        if (event.type === 'token') {
          // Re-assigned, not pushed to (D31). One reactive write per token.
          streamingText.value += event.text
          continue
        }

        if (event.type === 'file_start') {
          streamingFiles.value[event.path] = ''
          /*
           * The first streamed file opens itself — but only into an empty panel.
           * Moving a user off the file they were reading, mid-reply, is the
           * screen being taken away from them.
           *
           * Recorded as this generation's own selection, so a turn that ends up
           * storing nothing can put the panel back rather than leaving an
           * unread buffer under a real filename.
           */
          if (selectedPath.value === null) {
            selectedPath.value = event.path
            autoSelected = event.path
          }
          continue
        }

        if (event.type === 'file_chunk') {
          /*
           * Keyed by the frame's own path (D5), so interleaved files cannot
           * bleed into each other and a client that missed a `file_start` still
           * routes correctly. Mutated in place: replacing the whole record per
           * chunk would invalidate every computed reading any file's buffer.
           */
          streamingFiles.value[event.path] = (streamingFiles.value[event.path] ?? '') + event.text
          continue
        }

        // `file_end` closes nothing here: the row stays marked until the whole
        // generation resolves, because until `done` says so the file is watched
        // rather than stored.
        if (event.type === 'file_end') continue

        if (event.type === 'done') {
          messages.value = [...messages.value, event.message]
          generateFileError.value = event.fileError
          await applyGenerationFiles(event.files, gen)
          return
        }

        /*
         * An `error` carries the message the server actually **persisted**, or
         * `null` when nothing had been produced (D9). Appending the server's copy
         * rather than the client's accumulated text is what makes the interrupted
         * case the same rendering path as the successful one — and what stops an
         * id-less bubble that disagrees with the server on the next load.
         *
         * Reached by exhaustion — every other member of the union is handled
         * above — so the compiler is what keeps this branch honest if a seventh
         * event is ever added.
         */
        if (event.message !== null) messages.value = [...messages.value, event.message]
        generateError.value = event.error
        return
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
        /*
         * Dropped whichever way the generation ended — done, error, abort or a
         * thrown request. What streamed was never the stored bytes (D20), and a
         * stream that failed stored nothing at all, so keeping the buffers would
         * leave the tree marking files as being written by nothing.
         *
         * After the `done` branch's refetch rather than before it, so the tree
         * does not flash empty for the length of the list request.
         */
        streamingFiles.value = {}
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
    clearFileState()
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
    files,
    filesLoading,
    filesLoaded,
    filesError,
    selectedPath,
    fileContent,
    savedContent,
    fileDirty,
    fileLoading,
    fileError,
    saving,
    saveError,
    streamingFiles,
    fileTree,
    editorContent,
    fileReplaced,
    generateFileError,
    atLimit,
    canSend,
    open,
    loadMessages,
    loadFiles,
    selectFile,
    saveFile,
    send,
    retryGeneration: runGeneration,
    reset,
  }
})
