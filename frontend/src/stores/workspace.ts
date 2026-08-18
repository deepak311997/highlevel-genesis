import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { ApiError } from '@/lib/api'
import { mergeFileTree, type FileRow } from '@/lib/files'
import { getFile, listFiles, saveFile as putFile, type FileMeta } from '@/lib/filesApi'
import { streamGeneration } from '@/lib/generateApi'
import { listMessages, sendMessage, MESSAGE_LIMIT, type Message } from '@/lib/messagesApi'
import { getProject, type Project } from '@/lib/projectsApi'
import { listSnapshots, restoreSnapshot as postRestore, type Snapshot } from '@/lib/snapshotsApi'

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
/**
 * One open file, as far as the editor is concerned (D14).
 *
 * Slice 6 held these five as five top-level refs, which meant **one** buffer:
 * clicking a second file threw away unsaved edits to the first, with no warning
 * and no way back. One entry per path is the whole fix, and `openTabs` is what
 * makes it visible.
 */
export interface FileBuffer {
  /** What the user has. */
  content: string
  /** What the server last said. Dirty is the two disagreeing. */
  saved: string
  loading: boolean
  error: string | null
  /** D15/D16 — a generation replaced this buffer, until the next edit or close. */
  replaced: boolean
}

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
  /** The **active tab**, or `null` when no tab is open (D14). */
  selectedPath: Ref<string | null>
  /** The open tabs, in the order they were opened. */
  openTabs: Ref<string[]>
  /**
   * One buffer per path that has been opened this session (D14).
   *
   * **Survives a tab close** (D12), which is what removes the confirm dialog from
   * this slice entirely: closing a tab cannot lose work, because reopening the
   * file restores the unsaved content and its dirty mark without a request. A
   * "discard your changes?" modal is a component, a focus trap, an e2e case and a
   * decision about what the default button is — all bought by a rule that costs
   * one line.
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
  /** D15/D16's notice, for the **active** tab: a generation replaced this buffer. */
  fileReplaced: ComputedRef<boolean>
  /** The last generation's `fileError`, kept apart from `generateError`. */
  generateFileError: Ref<string | null>
  /**
   * The project's version history — **metadata only** (D18).
   *
   * Newest first, as the list route answers. There is deliberately no `files`
   * and no `content` on a `Snapshot`: a version is up to 20 files of up to
   * 100 KB each, and opening a history sheet must not ship a megabyte of code
   * nobody has asked to restore.
   */
  snapshots: Ref<Snapshot[]>
  snapshotsLoading: Ref<boolean>
  /**
   * Whether a list request has completed, successfully or not — and the whole of
   * AC-27's condition (D21).
   *
   * A finished generation refetches the history **only if** this is true. It
   * gates the `done` refetch and nothing else: the sheet fetches on every open
   * (P5), because re-opening it after a generation must not show a stale list.
   */
  snapshotsLoaded: Ref<boolean>
  snapshotsError: Ref<string | null>
  /** The snapshot a restore is in flight for, or null. Disables every row's Restore. */
  restoringId: Ref<string | null>
  restoreError: Ref<string | null>
  atLimit: ComputedRef<boolean>
  canSend: ComputedRef<boolean>
  open: (projectId: string) => Promise<void>
  loadMessages: () => Promise<void>
  /** The file tree's Try again — this action and nothing else. */
  loadFiles: () => Promise<void>
  /** The history, on its own — what the sheet calls on open and on **Try again**. */
  loadSnapshots: () => Promise<void>
  /** Restore one version, and reconcile the tabs to what came back (AC-24, AC-25). */
  restoreSnapshot: (snapshotId: string) => Promise<void>
  /** Open a tab for a path if there is none, then make it active (D10). */
  selectFile: (path: string) => Promise<void>
  /** Close a tab, keeping its buffer (D12). */
  closeTab: (path: string) => void
  /** Write the active buffer — what the editor calls on a keystroke. */
  editContent: (text: string) => void
  /** Re-read the active tab: the editor's **Try again** on a failed read. */
  reloadFile: () => Promise<void>
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
   * Every write that lands after an `await` goes through this, on top of the
   * `current(gen)` guard: a buffer can be dropped mid-flight by a generation that
   * rewrote a closed file (D15), and a late response resurrecting it would put an
   * entry back that nothing on screen refers to — with `saved` set from a read
   * whose tab is gone.
   */
  function withBuffer(path: string, write: (buffer: FileBuffer) => void): void {
    const buffer = buffers.value[path]
    if (buffer === undefined) return
    write(buffer)
  }

  /**
   * Forget a buffer, so the next open reads the server's copy (D15).
   *
   * Rebuilt rather than `delete`d — `no-dynamic-delete` is on, and the whole-object
   * replacement `mergeFileTree`'s comment warns about is not a cost here: this runs
   * once per generation per closed file it rewrote, not once per chunk.
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
   * Dirty is **derived**, not maintained.
   *
   * A boolean would have to be set on every edit path and cleared on every load
   * and save path, and the first one anybody forgets either enables Save for an
   * unchanged file or, much worse, leaves it disabled over an edit. A comparison
   * cannot go stale, and it also makes typing a change and typing it back read as
   * clean — which is the truth.
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

  /*
   * The active tab's fields, kept under their Slice 6 names (D14).
   *
   * That is deliberate diff hygiene rather than nostalgia: `FileTree.vue` does not
   * change at all and half of `FileEditor.vue` does not either, so the review reads
   * the change to the buffer model rather than a rename spread over four files.
   */
  const fileLoading = computed(() => activeBuffer.value?.loading ?? false)
  const fileError = computed(() => activeBuffer.value?.error ?? null)
  const fileReplaced = computed(() => activeBuffer.value?.replaced ?? false)

  const streamingFiles = ref<Record<string, string>>({})
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
    return streamingFiles.value[path] ?? activeBuffer.value?.content ?? ''
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
    () =>
      draft.value.trim() !== '' &&
      !sending.value &&
      !generating.value &&
      // D18's interlock, both ways round. `restoreSnapshot` refuses to start
      // while a generation is open; this is the same rule from the other side,
      // because a generation committing during a restore leaves the restore
      // holding a file list one version out of date.
      restoringId.value === null &&
      !atLimit.value,
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
   * The version history — the sheet's open, its **Try again**, and what a
   * finished generation refetches (D21, AC-23).
   *
   * `loadFiles`'s shape one collection over, including the part that matters:
   * a failure leaves the list alone. An emptied history under a **Restore**
   * button would say "this project has no versions", which is a different claim
   * from "we could not reach the server".
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
   * has never read it (D10, D12).
   *
   * The two negatives are the point. Re-activating an open tab issues nothing,
   * because a refetch would silently discard the buffer, which is the exact bug
   * tabs exist to fix. Reopening a *closed* file issues nothing either, because
   * its buffer survived the close — so an unsaved edit comes back exactly as it
   * was typed, with no round trip to show it.
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

    // Buffered already — content, an unsaved edit, or a failed read whose Try
    // again is `reloadFile()`. Either way there is nothing to ask for.
    if (buffers.value[path] !== undefined) return

    ensureBuffer(path)
    await readInto(path, id, generation)
  }

  /**
   * Close a tab, **keeping its buffer** (D12).
   *
   * The buffer surviving is what makes this safe with no confirm dialog: reopening
   * the file restores the unsaved content and its dirty mark, without a request.
   * The *notice* does not survive, because closing the tab is the user acting on
   * it, which is one of D16's two triggers.
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
   * Clearing `replaced` here is D16's first trigger: the notice has to be
   * dismissible by *doing* something, or it sits over a file the user has since
   * re-edited and lies about it. Per tab, not global — an edit in one tab has
   * nothing to say about another's.
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
   * Every write is `withBuffer`'d as well as `current(gen)`-guarded: the buffer
   * can be dropped while this is in flight, and a late response must not put it
   * back. `replaced` is deliberately not touched — a fresh read leaves it as the
   * caller set it, which is what lets `applyGenerationFiles` announce a discard
   * that this function performed.
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
   * Re-read one open tab, and **announce** the discard when its buffer was dirty
   * (D16, D22).
   *
   * Shared verbatim by `applyGenerationFiles` and `applyRestoredFiles`, because
   * a surviving tab is the same problem in both: the bytes behind it have been
   * replaced by a write the user did not make, so the server's copy wins and the
   * discard is said out loud. The notice is origin-neutral — it does not care
   * which of the two replaced it.
   *
   * Returns whether the open this belonged to is still the one on screen. That
   * is the one thing a `void` helper could not carry back: the caller has its own
   * work to abandon after the `await`, not just this buffer's.
   */
  async function rereadTab(path: string, id: string, gen: number): Promise<boolean> {
    const buffer = buffers.value[path]
    // A tab a generation opened for itself has no buffer at all (P1), and an
    // unread buffer is not a dirty one.
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

    // Scoped to the active tab, and to nothing else (D26): a save touches this
    // buffer, this path in the list, and no other tab.
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
    if (written.length > 0) {
      await loadFiles()
      /*
       * A turn that stored files also recorded a version (D2, D21), so an **open**
       * sheet would otherwise go stale while the user watches the generation
       * finish behind it. `snapshotsLoaded` is the whole of AC-27's condition: a
       * user who never opens the sheet must not pay for this request on every
       * turn, and a list nobody has looked at has nothing to keep current.
       */
      if (snapshotsLoaded.value) await loadSnapshots()
    }
    if (!current(gen)) return

    const id = projectId.value
    if (id === null) return

    /*
     * **Every open tab** the generation rewrote, not just the active one (D15).
     *
     * A generation that rewrites three files while two are open has to refresh
     * both, or the tab the user is not looking at holds bytes the server has
     * since replaced — and **Save** from it would put them back. The count is
     * bounded by what is on screen, which is what makes fanning out affordable.
     *
     * A dirty buffer is discarded and the discard is **announced** (D16): the
     * window is narrow, because the editor is read-only while a stream is open
     * (D9), so this is an edit typed before the send. Silence is the one outcome
     * that is not acceptable; a merge UI is a slice of its own.
     *
     * Sequential rather than `Promise.all`, because there are at most a handful
     * of open tabs and one order is easier to reason about — and to assert —
     * than a race between reads that each write a different buffer.
     */
    for (const path of openTabs.value) {
      if (!written.includes(path)) continue
      if (!(await rereadTab(path, id, gen))) return
    }

    /*
     * A file that is **buffered but closed** has its entry dropped rather than
     * re-read (D15). Re-reading every buffer ever opened would make the request
     * count grow with the session for tabs nobody is looking at; dropping it
     * keeps the answer correct, because the next open fetches the server's copy.
     */
    for (const path of written) {
      if (openTabs.value.includes(path)) continue
      if (buffers.value[path] !== undefined) dropBuffer(path)
    }

    closeAutoSelected(written)
  }

  /**
   * Hand back the tab this generation opened for itself, unless the turn stored
   * the file behind it (P1). Two shapes, and the second is the dangerous one:
   *
   * - a path that streamed but was never stored — a refused op set, or an
   *   unterminated block — which leaves a filename with no file behind it;
   * - a path the project **already holds**, whose bytes were never read,
   *   because `file_start` opens a tab and does not fetch. Left open it shows
   *   an empty editor over a file with content, its keystrokes go nowhere —
   *   `editContent` has no buffer to write to — and the byte count reads 0.
   *
   * Both close the tab, which is where the panel was before the generation
   * borrowed one, and no request is issued (AC-24).
   *
   * Called from **two** places, because a generation has two ways to end. `done`
   * passes the files it wrote; the `finally` passes nothing, because a turn that
   * never reached `done` — interrupted, refused before the first byte, dropped —
   * stored nothing by construction. `done` runs first and leaves `autoSelected`
   * null, so the second call is a no-op rather than a double close.
   *
   * A tab the **user** opened is never touched, dirty included: closing it would
   * discard an edit for a reason they cannot see and the server never asked for.
   * `selectFile` clears `autoSelected` when the user clicks that very tab, which
   * is them adopting it.
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
   * back (AC-24, D12).
   *
   * The response *is* the refetch. The server has just written the documents and
   * answers from what it stored, so `files` is applied directly rather than
   * bought with a second `GET …/files` asking the same server the same question
   * one round trip later. Slice 6's D20 does not transfer: there is no streamed
   * copy here that could disagree with the stored bytes. The *history* is
   * refetched, because the safety snapshot (D9) means it genuinely changed.
   *
   * `restoringId` is held for the whole of that — the response, the history and
   * the tab reconciliation — because a workspace that half-shows a restored
   * version is not a workspace with its Restore buttons live again.
   */
  async function restoreSnapshot(snapshotId: string): Promise<void> {
    const id = projectId.value
    /*
     * AC-26. The sheet disables both of these, and the store re-checks them
     * because nothing guarantees the call came from the button.
     *
     * `generating` is the expensive one: a restore's batch and a generation's
     * are two writers for one set of documents, and whichever commits second
     * silently wins. A second *restore* is the same race against itself — the
     * later reply may be the earlier request, and it would reconcile the tabs to
     * a version that is no longer the project's.
     */
    if (id === null || generating.value || restoringId.value !== null) return

    const gen = generation
    restoringId.value = snapshotId
    restoreError.value = null
    try {
      const result = await postRestore(id, snapshotId)
      if (!current(gen)) return
      /*
       * All three, not just the list. `loadFiles` is the tree's other writer and
       * it sets every one of them, which is what `FileTree.vue` renders on — so
       * a project whose first `GET /files` failed would otherwise keep showing
       * **Try again** over a tree the restore has just rewritten.
       */
      files.value = result.files
      filesLoaded.value = true
      filesError.value = null
      await loadSnapshots()
      if (!current(gen)) return
      /*
       * D10 — `changed: false` is the project already *being* this version.
       * Nothing was written, so nothing on screen is stale, and re-reading the
       * tabs would discard an unsaved edit for a change that did not happen.
       */
      if (result.changed) await applyRestoredFiles(result.files, gen)
    } catch (err) {
      if (!current(gen)) return
      // The batch is all-or-nothing, so a failure wrote nothing: the files, the
      // tabs and every buffer are left exactly as they were. Discarding an edit
      // *because* the restore failed would lose work for a change that never
      // happened.
      restoreError.value = err instanceof Error ? err.message : 'Could not restore that version.'
    } finally {
      if (current(gen)) restoringId.value = null
    }
  }

  /**
   * What a restore does to the tabs (AC-25) — `applyGenerationFiles`'s job with
   * one case a generation cannot produce.
   *
   * A generation only ever writes; a restore also **deletes** (D7), so a tab can
   * be left pointing at a path the project no longer holds. That editor would
   * show bytes the server has disowned, and **Save** from it would put a deleted
   * file back — so the tab goes, which is also what puts the panel on a file that
   * still exists.
   */
  async function applyRestoredFiles(restored: FileMeta[], gen: number): Promise<void> {
    const id = projectId.value
    if (id === null) return

    const paths = new Set(restored.map((file) => file.path))

    /*
     * Over a **copy**: `closeTab` rewrites `openTabs.value`, and walking a list
     * that is being rebuilt underneath skips the entry after every removal.
     *
     * Sequential rather than `Promise.all`, exactly as `applyGenerationFiles` is
     * and for the same reason — at most a handful of tabs, and one order is
     * easier to reason about, and to assert, than a race between reads that each
     * write a different buffer.
     */
    for (const path of [...openTabs.value]) {
      if (!paths.has(path)) {
        closeTab(path)
        continue
      }
      if (!(await rereadTab(path, id, gen))) return
    }

    /*
     * P6. `applyGenerationFiles` drops the closed buffers a generation *rewrote*;
     * a restore potentially rewrites or deletes every file, and the response
     * carries no per-path record of what moved — so the equivalent set is **all
     * of them**, the closed tabs just deleted included. The next open fetches the
     * server's copy, which is the same guarantee reached the same way, and no
     * request is issued for a tab nobody has open.
     *
     * One rebuild rather than a `dropBuffer` per path: this is a whole-map filter
     * already, and doing it per entry would rebuild the object once per file.
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
  }

  /**
   * Every snapshot field back to its initial value — shared by `open` and
   * `reset`, exactly as `clearFileState` is (AC-28).
   *
   * Its own function, sitting beside `clearFileState` and called from the same
   * two places, so a seventh field cannot be added to one of the two callers and
   * forgotten in the other. A history belongs to one project and one account: a
   * list left behind by the project before this one would offer a **Restore**
   * that writes one project's files over another's.
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
          if (openTabs.value.length === 0) {
            openTab(event.path)
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
        // A turn that never reached `done` stored nothing, so the tab it opened
        // for itself goes back — see `closeAutoSelected`.
        closeAutoSelected([])
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
     *
     * `restoringId` is D18's interlock in the direction it was not written for.
     * A restore in flight is a second writer for the same file documents, and
     * the one that commits second silently wins — but the damage here is on the
     * client: the restore's response is a file list read *before* the
     * generation, so applying it drops the file the generation just wrote out of
     * the tree and closes the tab opened for it, while the file sits on the
     * server. The restore settles in a moment; the send is not lost, only held.
     */
    if (id === null || content === '' || generating.value || restoringId.value !== null) return

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
    retryGeneration: runGeneration,
    reset,
  }
})
