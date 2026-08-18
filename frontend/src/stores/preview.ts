import { defineStore } from 'pinia'
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

import { getFile } from '@/lib/filesApi'
import { hlProxy } from '@/lib/hlProxyApi'
import { assemblePreview, type PreviewFile } from '@/lib/previewDocument'
import { handlePreviewMessage, type PreviewFailure } from '@/lib/previewBridge'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The live preview: one assembled document, the nonce it was built under, and
 * whatever the running app has had to say for itself.
 *
 * **A store rather than the panel's own state** (D11). The `lg` breakpoint swaps
 * one component tree for another, so anything held in `PreviewPanel` is destroyed
 * by a window resize — the same argument that put the composer's draft in a store
 * in Slice 4. Held here, a breakpoint swap re-renders the same document instead of
 * refetching every file and re-running the app's CRM calls.
 *
 * **Not the workspace store, either.** That one is already a thousand lines and
 * owns the project, the transcript, the files and the stream; the preview has a
 * different lifecycle — it is rebuilt, and they are not.
 *
 * **The file contents come from the routes that already exist** (D13): the
 * workspace store's metadata for the paths, then `getFile` per path in parallel.
 * A bundle route returning every file at once was rejected — it would be a new API
 * contract, a new schema and a second way to read files, to save nineteen round
 * trips on a screen a user opens once per generation. The torn-read window it
 * would close does not exist in practice: the only writer is this same browser,
 * and both rebuild triggers fire *after* the write completed.
 *
 * **The credential never crosses into the frame** (D2). `handleMessage` is the
 * host half of the broker: the sandboxed document posts a request, this store
 * checks who sent it and under which build, and then makes the call itself — same
 * origin, ID token, App Check — before posting the response body back. The frame
 * gets data, never a token.
 */

export type PreviewState = 'idle' | 'loading' | 'empty' | 'error' | 'ready'

/** Why there is nothing to show — two causes, and the panel says something different for each. */
export type PreviewEmptyReason = 'no_files' | 'no_entry_point'

/**
 * The two failure codes reconnecting actually fixes (D17).
 *
 * Every other proxy code renders its message and nothing more: offering a
 * reconnect for a 404 on a contact would send someone through an OAuth handshake
 * to fix something a handshake has no bearing on.
 */
const RECONNECT_CODES: readonly string[] = ['hl_reconnect_required', 'hl_not_connected']

/** The one filename that can be a document; nothing else is guessed at (AC-8). */
const ENTRY_POINT = 'index.html'

export interface PreviewStore {
  state: Ref<PreviewState>
  emptyReason: Ref<PreviewEmptyReason | null>
  /** The assembled `srcdoc`, or null when there is nothing to run. */
  document: Ref<string | null>
  /** This build's nonce — the frame's identity, and the stale-document guard (D3). */
  nonce: Ref<string | null>
  /** A failed read, in the server's own words. */
  error: Ref<string | null>
  /** Assembly warnings: a referenced file the project does not hold (AC-6). */
  warnings: Ref<string[]>
  /**
   * The latest brokered HighLevel failure, and the latest uncaught error inside
   * the frame — **single values, not lists**. A generated render loop that fails
   * fifty times would otherwise grow an unbounded banner stack, and the fiftieth
   * message says nothing the first did not.
   */
  failure: Ref<PreviewFailure | null>
  runtimeError: Ref<string | null>
  /** The workspace's `filesRevision` as of the current document. */
  builtRevision: Ref<number>
  stale: ComputedRef<boolean>
  reconnectable: ComputedRef<boolean>
  /** Read every file and assemble a new document under a fresh nonce. */
  build: () => Promise<void>
  /** Build once, for a panel that has just been handed a file list. */
  ensureBuilt: () => Promise<void>
  /** The host half of the broker — see the header. */
  handleMessage: (event: MessageEvent, frame: Window | null) => Promise<void>
  reset: () => void
}

export const usePreviewStore = defineStore('preview', (): PreviewStore => {
  const workspace = useWorkspaceStore()

  const state = ref<PreviewState>('idle')
  const emptyReason = ref<PreviewEmptyReason | null>(null)
  const document = ref<string | null>(null)
  const nonce = ref<string | null>(null)
  const error = ref<string | null>(null)
  const warnings = ref<string[]>([])
  const failure = ref<PreviewFailure | null>(null)
  const runtimeError = ref<string | null>(null)
  const builtRevision = ref(0)

  /**
   * Which build a read or a brokered call belongs to.
   *
   * The same device `workspace.ts` and `hl.ts` use, for the same reason: every
   * write that lands after an `await` has to be able to ask whether the thing it
   * was answering still exists. Here it also covers a rebuild — a document that
   * has been replaced must not have a banner raised over its successor.
   *
   * Not a `ref`: nothing renders it.
   */
  let generation = 0

  function current(gen: number): boolean {
    return gen === generation
  }

  /**
   * Stale means "what is on screen is not what is stored" — and only a *ready*
   * preview can be stale.
   *
   * The `state === 'ready'` clause is load-bearing rather than defensive: without
   * it, the tick between `filesRevision` moving and the rebuild it triggers would
   * flash the hint that exists precisely as the alternative to rebuilding.
   */
  const stale = computed(
    () => state.value === 'ready' && workspace.filesRevision > builtRevision.value,
  )

  const reconnectable = computed(
    () => failure.value !== null && RECONNECT_CODES.includes(failure.value.code ?? ''),
  )

  /**
   * Read every stored file and assemble one document.
   *
   * The two empty causes are settled from the *paths* alone, before a single read
   * is issued: a project with no files, and a project whose files include no
   * entry point. Guessing an entry point was rejected — a document assembled from
   * whichever file happened to be first is a preview of something the user never
   * asked for.
   */
  async function build(): Promise<void> {
    const gen = ++generation
    const id = workspace.projectId
    if (id === null) return

    // AC-37 — every banner and every warning belongs to the document that raised
    // it, so a rebuild starts from a clean panel rather than carrying the last
    // one's complaints over the new one.
    warnings.value = []
    failure.value = null
    runtimeError.value = null
    error.value = null

    const paths = workspace.files.map((file) => file.path)
    if (paths.length === 0) {
      settleEmpty('no_files')
      return
    }
    if (!paths.includes(ENTRY_POINT)) {
      settleEmpty('no_entry_point')
      return
    }

    /*
     * Captured before the reads rather than after them: a save that lands while
     * this build is in flight has produced bytes this document does not carry, so
     * the panel should say so the moment it appears.
     */
    const revision = workspace.filesRevision
    state.value = 'loading'
    document.value = null

    let files: PreviewFile[]
    try {
      // In parallel, and bounded by the server's own file cap — the list route
      // cannot return more than twenty paths, so there is no fan-out to limit
      // here that is not already limited there.
      files = await Promise.all(paths.map((path) => getFile(id, path)))
    } catch (err) {
      if (!current(gen)) return
      state.value = 'error'
      error.value = err instanceof Error ? err.message : 'Could not read these files.'
      return
    }

    if (!current(gen)) return

    const built = crypto.randomUUID()
    const assembly = assemblePreview(files, built)
    if (!assembly.ok) {
      // Reachable even though the paths were checked above: the list and the
      // reads are two round trips, and the entry point can be deleted between them.
      settleEmpty(assembly.reason)
      return
    }

    document.value = assembly.html
    warnings.value = assembly.warnings
    nonce.value = built
    builtRevision.value = revision
    emptyReason.value = null
    state.value = 'ready'
  }

  function settleEmpty(reason: PreviewEmptyReason): void {
    state.value = 'empty'
    emptyReason.value = reason
    document.value = null
    nonce.value = null
  }

  /** The first build, for a panel that has just been handed a file list. */
  async function ensureBuilt(): Promise<void> {
    if (state.value !== 'idle') return
    await build()
  }

  /**
   * The host half of the broker (D2, D4).
   *
   * The nonce is captured **at entry** and checked again on the way back, and
   * both checks earn their place. The first is the acceptance gate: a request
   * from the previous document carries the previous nonce, so it is dropped
   * without a call and without a reply. The second covers a rebuild that happened
   * while the proxy call was in flight — a reply posted into a replaced document
   * would be answered by a stranger, and a banner raised from it would sit over a
   * document that never made the call (AC-37).
   *
   * `hlProxy` is called unchanged (D4): the path grammar, the GET-payload-to-query
   * rule and the `/api/hl/proxy` base have exactly one implementation, and this is
   * the moment the path argument becomes LLM output — which is what that grammar
   * was written for.
   */
  async function handleMessage(event: MessageEvent, frame: Window | null): Promise<void> {
    const built = nonce.value
    if (built === null) return

    const live =
      <T>(fn: (value: T) => void) =>
      (value: T): void => {
        if (nonce.value === built) fn(value)
      }

    await handlePreviewMessage(event, {
      nonce: built,
      frame,
      proxy: (method, path, payload) => hlProxy(method, path, payload),
      // `'*'` because an opaque origin has no name to target (D3, R6). What makes
      // that safe is D2: a reply carries a HighLevel response body or an error
      // message, and never a token, a uid or a location id.
      post: live((message: unknown) => {
        frame?.postMessage(message, '*')
      }),
      onFailure: live((value: PreviewFailure) => {
        failure.value = value
      }),
      onRuntimeError: live((message: string) => {
        runtimeError.value = message
      }),
    })
  }

  function reset(): void {
    generation += 1
    state.value = 'idle'
    emptyReason.value = null
    document.value = null
    nonce.value = null
    error.value = null
    warnings.value = []
    failure.value = null
    runtimeError.value = null
    builtRevision.value = 0
  }

  /* A different project is a different app; nothing about the last one survives. */
  watch(
    () => workspace.projectId,
    () => {
      reset()
    },
  )

  /*
   * The panel cannot ask for its own first build without knowing whether the file
   * list has arrived, and that is the store's question rather than the
   * component's — a breakpoint swap remounts the panel and would ask again.
   */
  watch(
    () => workspace.filesLoaded,
    (loaded) => {
      if (loaded) void ensureBuilt()
    },
    { immediate: true },
  )

  /*
   * The demo (F6.4): a finished generation refreshes the preview with no
   * interaction at all.
   *
   * **`flush: 'sync'` is load-bearing.** Both counters move in the same statement
   * (D12), so with the default `'pre'` flush there is a tick in which `state` is
   * still `'ready'` and `filesRevision` has already moved — and the stale hint
   * would flash on screen immediately before the rebuild it exists as the
   * alternative to.
   */
  watch(
    () => workspace.generationsApplied,
    () => {
      void build()
    },
    { flush: 'sync' },
  )

  return {
    state,
    emptyReason,
    document,
    nonce,
    error,
    warnings,
    failure,
    runtimeError,
    builtRevision,
    stale,
    reconnectable,
    build,
    ensureBuilt,
    handleMessage,
    reset,
  }
})
