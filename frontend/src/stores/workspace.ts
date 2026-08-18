import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { ApiError } from '@/lib/api'
import { mergeFileTree, type FileRow } from '@/lib/files'
import { getFile, listFiles, saveFile as putFile, type FileMeta } from '@/lib/filesApi'
import { streamGeneration, type GenerateTurn } from '@/lib/generateApi'
import { listMessages, MESSAGE_LIMIT, type Message } from '@/lib/messagesApi'
import { getProject, type Project } from '@/lib/projectsApi'
import { listSnapshots, restoreSnapshot as postRestore, type Snapshot } from '@/lib/snapshotsApi'

/**
 * One project and its conversation, as far as the browser can see it.
 *
 * **One store, not two.** The project and its transcript share a lifecycle — same
 * id, loaded together, reset together — and two stores that must be reset in
 * lockstep is a bug with a countdown on it.
 *
 * **The draft lives here rather than in the composer.** The `lg` breakpoint swaps
 * one component tree for another, so anything held in a composer is eaten by a
 * window resize: invisible in review and infuriating in use.
 *
 * **Appending the sent message is not a hole in the liveness rule.** A transcript
 * cannot be reordered — it only appends, and the message the server just returned
 * is by construction its newest member, so appending *is* the server's order.
 * Refetching would re-read the whole history on every turn to re-read something
 * that cannot have changed.
 *
 * The project is fetched by this store rather than read from the projects store: a
 * deep link or a reload arrives with an empty one, and a store populated only when
 * you came from the dashboard is worse than one that never is, because only one of
 * those paths gets tested.
 */
/**
 * One open file, as far as the editor is concerned.
 *
 * Holding these as top-level refs meant **one** buffer: clicking a second file
 * threw away unsaved edits to the first, with no warning and no way back.
 */
export interface FileBuffer {
  /** What the user has. */
  content: string
  /** What the server last said. Dirty is the two disagreeing. */
  saved: string
  loading: boolean
  error: string | null
  /** A generation replaced this buffer, until the next edit or close. */
  replaced: boolean
}

/**
 * What a restore did — the four answers `restoreSnapshot` can give.
 *
 * Returning `void` is what made a no-op restore silent: the request went out, the
 * server answered `changed: false`, nothing moved, and the caller could not tell
 * that apart from a restore that rewrote every file.
 *
 * Four rather than a boolean, because the caller's decision is not "did it work"
 * but which of these is worth telling the user about. `'skipped'` covers the two
 * silent cases: a restore the sheet had already disabled, and one whose project or
 * session went away before it landed.
 */
export type RestoreOutcome = 'restored' | 'unchanged' | 'skipped' | 'failed'

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
   * **A plain `ref<string>` re-assigned per token.** The accumulation trap is an
   * array of objects pushed to thousands of times, which makes every render walk
   * the whole list; a string re-assignment is one reactive write per token. The
   * tokens become a `Message` exactly once, at the terminal event.
   */
  streamingText: Ref<string>
  /** Kept apart from `sendError`: one renders under the composer, one above it. */
  generateError: Ref<string | null>
  /**
   * The project's files — **metadata only**. The list route carries no `content`,
   * so opening a workspace does not ship 20 × 100 KB of code nobody has clicked
   * on; a file's bytes arrive when it is selected.
   */
  files: Ref<FileMeta[]>
  filesLoading: Ref<boolean>
  /** Whether a list request has completed, successfully or not. */
  filesLoaded: Ref<boolean>
  filesError: Ref<string | null>
  /** The **active tab**, or `null` when no tab is open. */
  selectedPath: Ref<string | null>
  /** The open tabs, in the order they were opened. */
  openTabs: Ref<string[]>
  /**
   * One buffer per path opened this session, and it **survives a tab close** —
   * which is what removes the confirm dialog entirely: closing a tab cannot lose
   * work, because reopening the file restores the unsaved content and its dirty
   * mark without a request.
   */
  buffers: Ref<Record<string, FileBuffer>>
  /** The paths the tab strip marks as having unsaved edits. */
  dirtyPaths: ComputedRef<string[]>
  /** The **active** buffer's content against what the server last said. */
  fileDirty: ComputedRef<boolean>
  fileLoading: ComputedRef<boolean>
  fileError: ComputedRef<string | null>
  saving: Ref<boolean>
  /** Kept apart from `fileError`: one renders beside Save, one instead of the editor. */
  saveError: Ref<string | null>
  /**
   * The bytes of the current generation, per path — **watched, not stored**.
   *
   * A mutated `Record` rather than a re-assigned object: a chunk arrives per frame,
   * and replacing the whole object each time would invalidate every computed
   * reading any file's buffer instead of just the one that changed.
   */
  streamingFiles: Ref<Record<string, string>>
  /** The tree the panel renders: stored ∪ streaming, streaming marked. */
  fileTree: ComputedRef<FileRow[]>
  /** What the editor shows — the streaming buffer while one exists, else the file. */
  editorContent: ComputedRef<string>
  /** The notice for the **active** tab: a generation replaced this buffer. */
  fileReplaced: ComputedRef<boolean>
  /** The last generation's `fileError`, kept apart from `generateError`. */
  generateFileError: Ref<string | null>
  /**
   * The project's version history — **metadata only**, newest first. A version is
   * up to 20 files of up to 100 KB each, and opening a history sheet must not ship
   * a megabyte of code nobody has asked to restore.
   */
  snapshots: Ref<Snapshot[]>
  snapshotsLoading: Ref<boolean>
  /**
   * Whether a list request has completed, successfully or not.
   *
   * A finished generation refetches the history **only if** this is true. The sheet
   * fetches on every open regardless, because re-opening it after a generation must
   * not show a stale list.
   */
  snapshotsLoaded: Ref<boolean>
  snapshotsError: Ref<string | null>
  /** The snapshot a restore is in flight for, or null. Disables every row's Restore. */
  restoringId: Ref<string | null>
  restoreError: Ref<string | null>
  /**
   * The two signals the preview panel watches — **one question each**.
   *
   * `generationsApplied` counts the generations that actually stored something, and
   * the preview rebuilds by itself when it moves. `filesRevision` counts every
   * change to the stored file set — that same event *and* a successful manual save
   * — and when it moves past what the preview last built the panel offers a refresh
   * hint rather than rebuilding.
   *
   * A save deliberately does not move `generationsApplied`, and that asymmetry is
   * the point: every rebuild re-runs the generated app's HighLevel calls against a
   * 100-request/10-second account budget, so auto-rebuilding on save would spend
   * the user's CRM allowance on each batch of keystrokes they commit.
   *
   * Two counters rather than one flag, because a flag has to be *interpreted* —
   * "changed by what, and does that one rebuild?" — at every reader.
   */
  generationsApplied: Ref<number>
  filesRevision: Ref<number>
  atLimit: ComputedRef<boolean>
  canSend: ComputedRef<boolean>
  open: (projectId: string) => Promise<void>
  loadMessages: () => Promise<void>
  /** The file tree's Try again — this action and nothing else. */
  loadFiles: () => Promise<void>
  /** The history, on its own — what the sheet calls on open and on **Try again**. */
  loadSnapshots: () => Promise<void>
  /**
   * Restore one version, reconcile the tabs to what came back, and report what it
   * did.
   */
  restoreSnapshot: (snapshotId: string) => Promise<RestoreOutcome>
  /** Open a tab for a path if there is none, then make it active. */
  selectFile: (path: string) => Promise<void>
  /** Close a tab, keeping its buffer. */
  closeTab: (path: string) => void
  /** Write the active buffer — what the editor calls on a keystroke. */
  editContent: (text: string) => void
  /** Re-read the active tab: the editor's **Try again** on a failed read. */
  reloadFile: () => Promise<void>
  saveFile: () => Promise<void>
  send: () => Promise<void>
  /** Re-open the stream for the same transcript — no new user message. */
  retryGeneration: () => Promise<void>
  /** Forget everything fetched for the session that just ended. */
  reset: () => void
}

/**
 * The id a prompt wears between hitting send and the server saying what it stored.
 *
 * A real Firestore id is 20 characters of base62, so this cannot collide with one
 * — and it is compared by equality rather than by prefix.
 */
const PENDING_ID = 'pending-user-message'

function pendingUserMessage(content: string): Message {
  return {
    id: PENDING_ID,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    truncated: false,
    error: null,
  }
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

  const snapshots = ref<Snapshot[]>([])
  const snapshotsLoading = ref(false)
  const snapshotsLoaded = ref(false)
  const snapshotsError = ref<string | null>(null)
  const restoringId = ref<string | null>(null)
  const restoreError = ref<string | null>(null)

  const selectedPath = ref<string | null>(null)
  const openTabs = ref<string[]>([])
  const buffers = ref<Record<string, FileBuffer>>({})
  const saving = ref(false)
  const saveError = ref<string | null>(null)

  function emptyBuffer(): FileBuffer {
    return { content: '', saved: '', loading: false, error: null, replaced: false }
  }

  /** The buffer for a path, created on first use. */
  function ensureBuffer(path: string): FileBuffer {
    const existing = buffers.value[path]
    if (existing !== undefined) return existing
    const created = emptyBuffer()
    buffers.value[path] = created
    return created
  }

  /**
   * Write a buffer **only if it is still there**.
   *
   * Every write that lands after an `await` goes through this: a buffer can be
   * dropped mid-flight by a generation that rewrote a closed file, and a late
   * response resurrecting it would put back an entry nothing on screen refers to.
   */
  function withBuffer(path: string, write: (buffer: FileBuffer) => void): void {
    const buffer = buffers.value[path]
    if (buffer === undefined) return
    write(buffer)
  }

  /**
   * Forget a buffer, so the next open reads the server's copy. Rebuilt rather than
   * `delete`d — `no-dynamic-delete` is on, and this runs once per generation per
   * closed file it rewrote rather than once per chunk.
   */
  function dropBuffer(path: string): void {
    buffers.value = Object.fromEntries(
      Object.entries(buffers.value).filter(([key]) => key !== path),
    )
  }

  /** The active tab's buffer, or `null` — which is also "no tab" and "not read yet". */
  const activeBuffer = computed<FileBuffer | null>(() => {
    const path = selectedPath.value
    if (path === null) return null
    return buffers.value[path] ?? null
  })

  /**
   * Dirty is **derived**, not maintained. A boolean would have to be set on every
   * edit path and cleared on every load and save path, and the first one anybody
   * forgets either enables Save for an unchanged file or leaves it disabled over an
   * edit. It also makes typing a change and typing it back read as clean.
   */
  function isDirty(buffer: FileBuffer): boolean {
    return buffer.content !== buffer.saved
  }

  const fileDirty = computed(() => {
    const buffer = activeBuffer.value
    return buffer !== null && isDirty(buffer)
  })

  /** What the strip marks. Over `openTabs`, so a closed dirty buffer is not shown. */
  const dirtyPaths = computed(() =>
    openTabs.value.filter((path) => {
      const buffer = buffers.value[path]
      return buffer !== undefined && isDirty(buffer)
    }),
  )

  // The active tab's fields, kept under their pre-tabs names, so a review reads
  // the change to the buffer model rather than a rename spread over four files.
  const fileLoading = computed(() => activeBuffer.value?.loading ?? false)
  const fileError = computed(() => activeBuffer.value?.error ?? null)
  const fileReplaced = computed(() => activeBuffer.value?.replaced ?? false)

  const streamingFiles = ref<Record<string, string>>({})
  const generateFileError = ref<string | null>(null)
  const generationsApplied = ref(0)
  const filesRevision = ref(0)

  /**
   * The path **this generation** selected on the user's behalf, if any.
   *
   * `file_start` selects into an empty panel without fetching, because the bytes
   * are already arriving — so that selection has an empty `saved` until `done`
   * re-reads it, and if the turn's ops are refused there is no re-read. That would
   * leave an empty editor over a file that has content, with the first keystroke
   * making it dirty and **Save** offering to replace the real file.
   *
   * Remembering whose selection it was is what tells the two apart at `done`.
   */
  let autoSelected: string | null = null

  const fileTree = computed(() => mergeFileTree(files.value, Object.keys(streamingFiles.value)))

  /**
   * The streaming buffer wins while the file is being written: a new file has no
   * stored content to show, and one being rewritten has content that is about to be
   * replaced. The editor is read-only for exactly this window.
   */
  const editorContent = computed(() => {
    const path = selectedPath.value
    if (path === null) return ''
    return streamingFiles.value[path] ?? activeBuffer.value?.content ?? ''
  })

  /**
   * The in-flight generation's controller — **in the store, not the component**.
   * The `lg` breakpoint swaps one component tree for another, so a controller held
   * in the chat panel is dropped by a window resize while the stream it was meant
   * to cancel keeps writing.
   */
  let controller: AbortController | null = null

  function abortGeneration(): void {
    controller?.abort()
    controller = null
  }

  const atLimit = computed(() => messages.value.length >= MESSAGE_LIMIT)
  const canSend = computed(
    () =>
      draft.value.trim() !== '' &&
      !sending.value &&
      !generating.value &&
      // The interlock, both ways round: `restoreSnapshot` refuses to start while a
      // generation is open, and a generation committing during a restore would
      // leave the restore holding a file list one version out of date.
      restoringId.value === null &&
      !atLimit.value,
  )

  /**
   * A 404 is a different state from any other failure, so it gets its own flag:
   * "that project no longer exists" renders with a Back link where a 500 renders
   * with a Retry, and collapsing the two would offer a retry for something that
   * will never succeed. Narrowed on the class rather than reaching for a `status`
   * through a cast, which would also match any unrelated `Error` that had one.
   */
  function isMissing(err: unknown): boolean {
    return err instanceof ApiError && err.status === 404
  }

  /**
   * Which open a request belongs to.
   *
   * **Every write that lands after an `await` is guarded by this**, because the
   * store is a singleton the route outlives: opening a project, going back, and
   * opening another leaves the first one's requests in flight against the second
   * one's screen — putting one project's name over another's transcript, or
   * appending a send to the wrong conversation.
   *
   * A counter rather than a comparison against `projectId`, because leaving and
   * coming back makes the id equal again while the first response is still owed.
   * `reset()` bumps it too, so a request in flight when the session ends cannot
   * repopulate the store afterwards.
   */
  let generation = 0

  function current(gen: number): boolean {
    return gen === generation
  }

  /**
   * Open a project: the project first, its transcript only if that resolves.
   *
   * **Sequential on purpose.** In parallel, a deleted project produces two 404s and
   * the view has to decide which it is rendering, and a request goes out for a
   * transcript that cannot exist. The cost is one extra round trip on the happy
   * path.
   */
  async function open(id: string): Promise<void> {
    /*
     * The draft and the send error are the two things a *different* project clears
     * and a re-open of the same one keeps: `open` is also the workspace's Retry, and
     * throwing away what the user typed is no part of retrying a project fetch.
     */
    if (projectId.value !== id) {
      draft.value = ''
      sendError.value = null
    }

    const gen = ++generation

    /*
     * Any generation in flight is cancelled, whichever project it belonged to:
     * `open` re-reads the whole transcript, so a stream still appending into
     * `messages` is stale by construction — and would go on spending money.
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
    clearSnapshotState()

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
      // Only the request still on screen may say the loading is over: a stale one
      // clearing this leaves the view with no project and no failure to render.
      if (current(gen)) projectLoading.value = false
    }

    await loadMessages()
    /*
     * Unconditionally, and after the transcript rather than instead of it: a failed
     * transcript is the chat panel's error state, and the code panel has no business
     * being empty because of it.
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
      // The list is left alone: a failed refetch should not empty a transcript that
      // already has messages in it.
      messagesError.value = err instanceof Error ? err.message : 'Could not load this conversation.'
    } finally {
      if (current(gen)) messagesLoading.value = false
    }
  }

  /** The file tree, on its own — the code panel's **Try again**, and what a
   * finished generation refetches. */
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
      // The list is left alone. Emptying the tree would say "this project has no
      // code", which is a different claim from "we could not reach the server".
      filesError.value = err instanceof Error ? err.message : 'Could not load these files.'
    } finally {
      if (current(gen)) filesLoading.value = false
    }
  }

  /**
   * The version history — the sheet's open, its **Try again**, and what a finished
   * generation refetches. A failure leaves the list alone, for `loadFiles`' reason:
   * an emptied history under a **Restore** button would say "this project has no
   * versions".
   */
  async function loadSnapshots(): Promise<void> {
    const id = projectId.value
    if (id === null) return

    const gen = generation
    snapshotsLoading.value = true
    snapshotsError.value = null
    try {
      const fetched = await listSnapshots(id)
      if (!current(gen)) return
      snapshots.value = fetched
      snapshotsLoaded.value = true
    } catch (err) {
      if (!current(gen)) return
      snapshotsError.value = err instanceof Error ? err.message : 'Could not load this history.'
    } finally {
      if (current(gen)) snapshotsLoading.value = false
    }
  }

  /** Add a tab if there is not one already, keeping the order they were opened in. */
  function openTab(path: string): void {
    if (!openTabs.value.includes(path)) openTabs.value = [...openTabs.value, path]
  }

  /**
   * Open a tab for a path and make it active — fetching **only** if this session
   * has never read it.
   *
   * The two negatives are the point. Re-activating an open tab issues nothing,
   * because a refetch would silently discard the buffer — the exact bug tabs exist
   * to fix. Reopening a *closed* file issues nothing either, because its buffer
   * survived the close.
   */
  async function selectFile(path: string): Promise<void> {
    const id = projectId.value
    if (id === null) return

    openTab(path)
    selectedPath.value = path
    // A deliberate choice, so no generation may take this tab back.
    if (autoSelected === path) autoSelected = null
    // Belongs to the save that failed, not to the tab now in front of the user.
    saveError.value = null

    // Buffered already — content, an unsaved edit, or a failed read whose Try again
    // is `reloadFile()`. Either way there is nothing to ask for.
    if (buffers.value[path] !== undefined) return

    ensureBuffer(path)
    await readInto(path, id, generation)
  }

  /**
   * Close a tab, **keeping its buffer** — which is what makes this safe with no
   * confirm dialog: reopening restores the unsaved content and its dirty mark,
   * without a request. The *notice* does not survive, because closing the tab is
   * the user acting on it.
   *
   * The left neighbour, then the right, then nothing — the left because that is
   * where the eye already is when a tab disappears from under the cursor.
   */
  function closeTab(path: string): void {
    const index = openTabs.value.indexOf(path)
    if (index === -1) return

    openTabs.value = openTabs.value.filter((open) => open !== path)
    withBuffer(path, (buffer) => {
      buffer.replaced = false
    })

    if (autoSelected === path) autoSelected = null
    if (selectedPath.value !== path) return

    // After the splice, `index - 1` is still the left neighbour and `index` is
    // whatever moved up into its place.
    selectedPath.value = openTabs.value[index - 1] ?? openTabs.value[index] ?? null
    saveError.value = null
  }

  /**
   * The active buffer's content — what the editor calls on a keystroke.
   *
   * Clearing `replaced` here is what makes the notice dismissible by *doing*
   * something, rather than sitting over a file the user has since re-edited. Per
   * tab: an edit in one has nothing to say about another's.
   */
  function editContent(text: string): void {
    const path = selectedPath.value
    if (path === null) return
    withBuffer(path, (buffer) => {
      buffer.content = text
      buffer.replaced = false
    })
  }

  /** Re-read the active tab — the editor's **Try again** on a failed read (AC-13). */
  async function reloadFile(): Promise<void> {
    const id = projectId.value
    const path = selectedPath.value
    if (id === null || path === null) return

    ensureBuffer(path)
    await readInto(path, id, generation)
  }

  /**
   * Read one file into its buffer.
   *
   * Every write is `withBuffer`'d as well as guarded by the open counter: the
   * buffer can be dropped while this is in flight, and a late response must not put
   * it back. `replaced` is deliberately not touched, which is what lets
   * `applyGenerationFiles` announce a discard this function performed.
   */
  async function readInto(path: string, id: string, gen: number): Promise<void> {
    withBuffer(path, (buffer) => {
      buffer.loading = true
      buffer.error = null
    })
    try {
      const file = await getFile(id, path)
      if (!current(gen)) return
      withBuffer(path, (buffer) => {
        buffer.content = file.content
        buffer.saved = file.content
      })
    } catch (err) {
      if (!current(gen)) return
      const message = err instanceof Error ? err.message : 'Could not load that file.'
      withBuffer(path, (buffer) => {
        buffer.error = message
      })
    } finally {
      if (current(gen)) {
        withBuffer(path, (buffer) => {
          buffer.loading = false
        })
      }
    }
  }

  /**
   * Re-read one open tab, and **announce** the discard when its buffer was dirty.
   *
   * Shared verbatim by the generation and the restore paths, because a surviving
   * tab is the same problem in both: the bytes behind it were replaced by a write
   * the user did not make, so the server's copy wins and the discard is said out
   * loud. The notice does not care which of the two replaced it.
   *
   * Returns whether the open this belonged to is still on screen — the one thing a
   * `void` helper could not carry back, since the caller has its own work to
   * abandon after the `await`.
   */
  async function rereadTab(path: string, id: string, gen: number): Promise<boolean> {
    const buffer = buffers.value[path]
    // A tab a generation opened for itself has no buffer at all, and an unread
    // buffer is not a dirty one.
    const wasDirty = buffer !== undefined && isDirty(buffer)
    ensureBuffer(path)
    await readInto(path, id, gen)
    if (!current(gen)) return false
    withBuffer(path, (refreshed) => {
      refreshed.replaced = wasDirty
    })
    return true
  }

  /**
   * Save the buffer, and take **the server's answer** back.
   *
   * The response replaces the buffer rather than the buffer being assumed correct:
   * the server owns `size` and both timestamps and is free to store something other
   * than exactly what was sent. Trusting the local copy is how an editor ends up
   * showing a document that disagrees with the server until a reload.
   *
   * A failed save keeps the buffer and its dirty flag — clearing either would throw
   * away an edit *because* it could not be stored.
   */
  async function saveFile(): Promise<void> {
    const id = projectId.value
    const path = selectedPath.value
    /*
     * A second save while one is in flight would race its own response, and the
     * later reply — which may be the earlier request — would win.
     *
     * `generating` is the one that matters: a generation's batch and this `PUT` are
     * two writers for one document, and the failure is silent. The editor is
     * read-only while a stream is open, and this is the store re-checking the rule
     * the component renders, because a keyboard shortcut skips the button.
     */
    if (id === null || path === null || saving.value || generating.value) return

    // Scoped to the active tab and nothing else: a save touches this buffer, this
    // path in the list, and no other tab.
    const buffer = buffers.value[path]
    if (buffer === undefined) return

    const gen = generation
    saving.value = true
    saveError.value = null
    try {
      const file = await putFile(id, path, buffer.content)
      if (!current(gen)) return
      withBuffer(path, (saved) => {
        saved.content = file.content
        saved.saved = file.content
      })
      // The list's entry is now stale in `size` and `updatedAt`, and the response
      // is the server's own word for both — applied here rather than paid for with
      // a second `GET`.
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
      // The stored file set has changed, so the preview is stale — but only the
      // hint moves. A rebuild here would re-run the app's HighLevel calls on every
      // save; the user decides when to spend that.
      filesRevision.value += 1
    } catch (err) {
      if (!current(gen)) return
      saveError.value = err instanceof Error ? err.message : 'Could not save that file.'
    } finally {
      if (current(gen)) saving.value = false
    }
  }

  /**
   * What a finished generation does to the code panel.
   *
   * A non-empty `files` is the signal to go and ask, and it is load-bearing: the
   * server *repairs* content and computes `size` and both timestamps, so the bytes
   * the browser watched arrive are not necessarily the bytes that were stored. The
   * append-the-response argument does not transfer from messages — a message is
   * exactly what the server returned, a file is a transformed version of what
   * streamed.
   */
  async function applyGenerationFiles(written: string[], gen: number): Promise<void> {
    const wroteFiles = written.length > 0
    if (wroteFiles) {
      await loadFiles()
      /*
       * A turn that stored files also recorded a version, so an **open** sheet
       * would go stale while the user watches the generation finish behind it.
       * `snapshotsLoaded` is the whole condition: a user who never opens the sheet
       * must not pay for this request on every turn.
       */
      if (snapshotsLoaded.value) await loadSnapshots()
    }
    if (!current(gen)) return

    /*
     * Both signals, in one place, **after** the refetch and behind the guard above.
     * After, because `generationsApplied` rebuilds the preview unasked and the
     * preview builds out of `files` — moved earlier, the one screen whose job is to
     * show what this turn wrote would render the previous turn's file set.
     */
    if (wroteFiles) {
      filesRevision.value += 1
      generationsApplied.value += 1
    }

    const id = projectId.value
    if (id === null) return

    /*
     * **Every open tab** the generation rewrote, not just the active one: a
     * generation that rewrites three files while two are open has to refresh both,
     * or the tab the user is not looking at holds bytes the server has replaced —
     * and **Save** from it would put them back.
     *
     * A dirty buffer is discarded and the discard is **announced**. The window is
     * narrow, because the editor is read-only while a stream is open, so this is an
     * edit typed before the send; silence is the one unacceptable outcome.
     *
     * Sequential rather than `Promise.all`: there are at most a handful of open
     * tabs, and one order is easier to reason about than a race between reads that
     * each write a different buffer.
     */
    for (const path of openTabs.value) {
      if (!written.includes(path)) continue
      if (!(await rereadTab(path, id, gen))) return
    }

    /*
     * A file that is **buffered but closed** has its entry dropped rather than
     * re-read: re-reading every buffer ever opened would make the request count
     * grow with the session, and the next open fetches the server's copy anyway.
     */
    for (const path of written) {
      if (openTabs.value.includes(path)) continue
      if (buffers.value[path] !== undefined) dropBuffer(path)
    }

    closeAutoSelected(written)
  }

  /**
   * Hand back the tab this generation opened for itself, unless the turn stored the
   * file behind it. Two shapes, and the second is the dangerous one:
   *
   * - a path that streamed but was never stored — a refused op set, or an
   *   unterminated block — leaving a filename with no file behind it;
   * - a path the project **already holds**, whose bytes were never read, because
   *   `file_start` opens a tab and does not fetch. Left open it shows an empty
   *   editor over a file with content, and its keystrokes go nowhere.
   *
   * Called from **two** places, because a generation has two ways to end: `done`
   * passes the files it wrote, and the `finally` passes nothing, because a turn
   * that never reached `done` stored nothing by construction.
   *
   * A tab the **user** opened is never touched, dirty included — and `selectFile`
   * clears `autoSelected` when they click that very tab, which is them adopting it.
   */
  function closeAutoSelected(written: string[]): void {
    const opened = autoSelected
    autoSelected = null
    if (opened === null || written.includes(opened)) return

    closeTab(opened)
    dropBuffer(opened)
  }

  /**
   * Restore one version — **one request**, and the tabs reconciled to what came
   * back.
   *
   * The response *is* the refetch: the server has just written the documents and
   * answers from what it stored, so a second `GET …/files` would ask the same
   * server the same question one round trip later. The *history* is refetched,
   * because the safety snapshot means it genuinely changed.
   *
   * `restoringId` is held for the whole of that, because a workspace that
   * half-shows a restored version is not one with its Restore buttons live again.
   */
  async function restoreSnapshot(snapshotId: string): Promise<RestoreOutcome> {
    const id = projectId.value
    /*
     * The sheet disables both of these, and the store re-checks them because
     * nothing guarantees the call came from the button.
     *
     * `generating` is the expensive one: a restore's batch and a generation's are
     * two writers for one set of documents, and whichever commits second silently
     * wins. A second *restore* is the same race against itself.
     */
    if (id === null || generating.value || restoringId.value !== null) return 'skipped'

    const gen = generation
    restoringId.value = snapshotId
    restoreError.value = null
    try {
      const result = await postRestore(id, snapshotId)
      /*
       * Every stale-generation return reports `'skipped'`: the project or session
       * this restore belonged to is gone, so there is nobody it would be truthful
       * to tell.
       */
      if (!current(gen)) return 'skipped'
      /*
       * All three, not just the list: `loadFiles` is the tree's other writer and
       * sets every one of them, so a project whose first `GET /files` failed would
       * otherwise keep showing **Try again** over a tree the restore just rewrote.
       */
      files.value = result.files
      filesLoaded.value = true
      filesError.value = null
      await loadSnapshots()
      if (!current(gen)) return 'skipped'
      /*
       * `changed: false` is the project already *being* this version. Nothing was
       * written, so nothing on screen is stale, and re-reading the tabs would
       * discard an unsaved edit for a change that did not happen.
       */
      if (result.changed) {
        await applyRestoredFiles(result.files, gen)
        if (!current(gen)) return 'skipped'
        /*
         * The stored file set has changed — by more than any save ever does — so
         * the preview says so. Only the hint moves: a rebuild re-runs the restored
         * app's HighLevel calls against the account's request budget, and a
         * restore is a deliberate act whose result the user may want to read first.
         */
        filesRevision.value += 1
      }
      return result.changed ? 'restored' : 'unchanged'
    } catch (err) {
      if (!current(gen)) return 'skipped'
      // The batch is all-or-nothing, so a failure wrote nothing: the files, the
      // tabs and every buffer are left exactly as they were.
      restoreError.value = err instanceof Error ? err.message : 'Could not restore that version.'
      return 'failed'
    } finally {
      if (current(gen)) restoringId.value = null
    }
  }

  /**
   * What a restore does to the tabs — `applyGenerationFiles`'s job with one case a
   * generation cannot produce.
   *
   * A generation only ever writes; a restore also **deletes**, so a tab can be left
   * pointing at a path the project no longer holds. That editor would show bytes
   * the server has disowned, and **Save** from it would put a deleted file back.
   */
  async function applyRestoredFiles(restored: FileMeta[], gen: number): Promise<void> {
    const id = projectId.value
    if (id === null) return

    const paths = new Set(restored.map((file) => file.path))

    /*
     * Over a **copy**: `closeTab` rewrites `openTabs.value`, and walking a list
     * being rebuilt underneath skips the entry after every removal. Sequential for
     * `applyGenerationFiles`' reason.
     */
    for (const path of [...openTabs.value]) {
      if (!paths.has(path)) {
        closeTab(path)
        continue
      }
      if (!(await rereadTab(path, id, gen))) return
    }

    /*
     * A generation drops the closed buffers it *rewrote*; a restore potentially
     * rewrites or deletes every file and the response carries no per-path record,
     * so the equivalent set is **all of them**. The next open fetches the server's
     * copy, and no request is issued for a tab nobody has open.
     *
     * One rebuild rather than a `dropBuffer` per path, which would rebuild the
     * object once per file.
     */
    buffers.value = Object.fromEntries(
      Object.entries(buffers.value).filter(([path]) => openTabs.value.includes(path)),
    )
  }

  /** Every file field back to its initial value — shared by `open` and `reset`. */
  function clearFileState(): void {
    files.value = []
    filesLoading.value = false
    filesLoaded.value = false
    filesError.value = null
    selectedPath.value = null
    openTabs.value = []
    buffers.value = {}
    autoSelected = null
    saving.value = false
    saveError.value = null
    streamingFiles.value = {}
    generateFileError.value = null
    generationsApplied.value = 0
    filesRevision.value = 0
  }

  /**
   * Every snapshot field back to its initial value — its own function beside
   * `clearFileState` and called from the same two places, so a seventh field cannot
   * be added to one caller and forgotten in the other. A list left behind by the
   * previous project would offer a **Restore** that writes one project's files over
   * another's.
   */
  function clearSnapshotState(): void {
    snapshots.value = []
    snapshotsLoading.value = false
    snapshotsLoaded.value = false
    snapshotsError.value = null
    restoringId.value = null
    restoreError.value = null
  }

  /**
   * Open `POST /generate` and consume it to its terminal event.
   *
   * Shared by `send()` and by the chat panel's **Retry**: the endpoint's only input
   * is the transcript, so retrying is literally the same request again.
   *
   * The three states it owns are cleared up front and restored in `finally`, both
   * guarded, so a stream belonging to a project the user has since left cannot
   * re-enable the composer of the one they are looking at.
   */
  async function runGeneration(turn: GenerateTurn): Promise<void> {
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
    // Whatever the last generation selected for itself is the last generation's
    // business; this one has borrowed nothing yet.
    autoSelected = null

    try {
      for await (const event of streamGeneration(id, turn, ours.signal)) {
        if (!current(gen)) return

        /*
         * The prompt as stored. The bubble was drawn the moment the user hit send,
         * so this replaces that placeholder with the document — which is what makes
         * its id and timestamp real rather than guessed.
         */
        if (event.type === 'user') {
          messages.value = [...messages.value.filter((m) => m.id !== PENDING_ID), event.message]
          continue
        }

        if (event.type === 'token') {
          // Re-assigned, not pushed to: one reactive write per token.
          streamingText.value += event.text
          continue
        }

        if (event.type === 'file_start') {
          streamingFiles.value[event.path] = ''
          /*
           * The first streamed file opens itself, but only into an empty panel:
           * moving a user off the file they were reading, mid-reply, is the screen
           * being taken away from them.
           *
           * Recorded as this generation's own selection, so a turn that stores
           * nothing can put the panel back.
           */
          if (openTabs.value.length === 0) {
            openTab(event.path)
            selectedPath.value = event.path
            autoSelected = event.path
          }
          continue
        }

        if (event.type === 'file_chunk') {
          /*
           * Keyed by the frame's own path, so interleaved files cannot bleed into
           * each other and a client that missed a `file_start` still routes
           * correctly. Mutated in place: replacing the whole record per chunk would
           * invalidate every computed reading any file's buffer.
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
         * `null` when nothing had been produced. Appending the server's copy rather
         * than the client's accumulated text makes the interrupted case the same
         * rendering path as the successful one.
         *
         * Reached by exhaustion, so the compiler keeps this branch honest if a
         * seventh event is ever added.
         */
        if (event.message !== null) messages.value = [...messages.value, event.message]
        generateError.value = event.error
        return
      }
    } catch (err) {
      if (!current(gen)) return
      // A refusal decided before the server flushed its headers, or a dropped
      // connection: both reach the same state as a mid-stream `error` event.
      const reason = err instanceof Error ? err.message : 'Could not generate a reply. Try again.'

      /*
       * **Rolled back only when the server said no.**
       *
       * A *status* means the server answered and refused — a 409 at the cap, a
       * 400, a 404 — and the prompt is written after those checks, so nothing was
       * stored: the bubble comes back out, the words go back in the composer, and
       * the reason renders there. Offering Retry for a project at its message cap
       * would be offering to fail again.
       *
       * A connection failure is an `ApiError` too, carrying status 0, and it is
       * emphatically not that: the request may have reached the server and the
       * prompt may be sitting in Firestore. So the bubble stays, Retry is offered,
       * and the transcript reconciles itself on the way back in.
       */
      const pending = messages.value.find((message) => message.id === PENDING_ID)
      const refused = err instanceof ApiError && err.status > 0
      if (pending === undefined || !refused) {
        generateError.value = reason
      } else {
        messages.value = messages.value.filter((message) => message.id !== PENDING_ID)
        // Only if the user has not started typing the next one.
        if (draft.value === '') draft.value = pending.content
        sendError.value = reason
      }
    } finally {
      if (current(gen)) {
        streamingText.value = ''
        /*
         * Dropped whichever way the generation ended. What streamed was never the
         * stored bytes, and a stream that failed stored nothing at all, so keeping
         * the buffers would leave the tree marking files as written by nothing.
         *
         * After the `done` branch's refetch rather than before it, so the tree does
         * not flash empty for the length of the list request.
         */
        streamingFiles.value = {}
        generating.value = false
        // A turn that never reached `done` stored nothing, so the tab it opened for
        // itself goes back — see `closeAutoSelected`.
        closeAutoSelected([])
      }
      if (controller === ours) controller = null
    }
  }

  /**
   * Send the draft and generate the reply — **one request**.
   *
   * `/generate` writes the prompt before it opens the stream, so the user's prompt
   * is durable before the expensive, failure-prone half begins: a generation that
   * dies before producing a byte still leaves a transcript the user recognises and
   * a Retry that works.
   */
  async function send(): Promise<void> {
    const id = projectId.value
    const content = draft.value.trim()
    /*
     * The composer disables submit for all three of these, but the store is the
     * boundary a keyboard shortcut cannot go around.
     *
     * `generating` is the expensive one: a second `send()` during an open stream
     * opens a **second paid generation**, and the abort of the first then lands on
     * the second one's state.
     *
     * `restoringId` is the restore interlock in the direction it was not written
     * for: the restore's response is a file list read *before* the generation, so
     * applying it drops the file the generation just wrote out of the tree while it
     * sits on the server.
     */
    if (id === null || content === '' || generating.value || restoringId.value !== null) return

    /*
     * **One request.** The prompt and the reply are the same call, so a turn cannot
     * half-happen: there is no window between "stored" and "asked for an answer"
     * for a dead tab to fall into.
     *
     * The bubble is drawn immediately under a placeholder id, because making
     * someone wait on a round trip to see their own words is a lag they did not
     * cause. The stream's first frame replaces it with the stored document.
     */
    messages.value = [...messages.value, pendingUserMessage(content)]
    // Cleared with the append, so the composer is empty the instant the bubble
    // appears; the failure path puts it back if nothing was stored.
    draft.value = ''

    sending.value = true
    sendError.value = null
    try {
      await runGeneration({ content })
    } finally {
      sending.value = false
    }
  }

  function reset(): void {
    // Bumped first: a request in flight when the session ends must not repopulate a
    // store that has just been emptied.
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
    clearSnapshotState()
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
    openTabs,
    buffers,
    dirtyPaths,
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
    snapshots,
    snapshotsLoading,
    snapshotsLoaded,
    snapshotsError,
    restoringId,
    restoreError,
    generationsApplied,
    filesRevision,
    atLimit,
    canSend,
    open,
    loadMessages,
    loadFiles,
    loadSnapshots,
    restoreSnapshot,
    selectFile,
    closeTab,
    editContent,
    reloadFile,
    saveFile,
    send,
    retryGeneration: () => runGeneration({ retry: true }),
    reset,
  }
})
