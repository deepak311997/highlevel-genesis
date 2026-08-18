import { defineStore } from 'pinia'
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

import { ApiError } from '@/lib/api'
import { getFile } from '@/lib/filesApi'
import { hlProxy } from '@/lib/hlProxyApi'
import { assemblePreview, type PreviewFile } from '@/lib/previewDocument'
import { HL_CALL_LIMIT } from '@/lib/previewShim'
import { handlePreviewMessage, type PreviewFailure } from '@/lib/previewBridge'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The live preview: one assembled document, the nonce it was built under, and
 * whatever the running app has had to say for itself.
 *
 * **A store rather than the panel's own state.** The `lg` breakpoint swaps one
 * component tree for another, so anything held in `PreviewPanel` is destroyed by a
 * window resize; held here, a swap re-renders the same document instead of
 * refetching every file.
 *
 * It does **not** save the app from re-running: a new `<iframe>` executes its
 * `srcdoc` from scratch, so the generated app's `hl()` calls go out again on every
 * remount. What bounds that is `brokered` below, which is reset by a *build* rather
 * than a mount, so one document spends at most `HL_CALL_LIMIT` however often it is
 * remounted.
 *
 * **Not the workspace store either**: the preview has a different lifecycle — it
 * is rebuilt, and the project and transcript are not.
 *
 * **The file contents come from the routes that already exist**: the workspace
 * store's metadata for the paths, then `getFile` per path in parallel. A bundle
 * route would be a new contract, a new schema and a second way to read files, to
 * save nineteen round trips on a screen opened once per generation.
 *
 * **The credential never crosses into the frame.** `handleMessage` is the host half
 * of the broker: the sandboxed document posts a request, this store checks who sent
 * it and under which build, and makes the call itself — same origin, ID token, App
 * Check. The frame gets data, never a token.
 */

export type PreviewState = 'idle' | 'loading' | 'empty' | 'error' | 'ready'

/** Why there is nothing to show — two causes, and the panel says something different for each. */
export type PreviewEmptyReason = 'no_files' | 'no_entry_point'

/**
 * The two failure codes reconnecting actually fixes. Every other proxy code renders
 * its message and nothing more: offering a reconnect for a 404 on a contact would
 * send someone through an OAuth handshake to fix something it has no bearing on.
 */
const RECONNECT_CODES: readonly string[] = ['hl_reconnect_required', 'hl_not_connected']

/** The one filename that can be a document; nothing else is guessed at. */
const ENTRY_POINT = 'index.html'

export interface PreviewStore {
  state: Ref<PreviewState>
  emptyReason: Ref<PreviewEmptyReason | null>
  /** The assembled `srcdoc`, or null when there is nothing to run. */
  document: Ref<string | null>
  /** This build's nonce — the frame's identity, and the stale-document guard. */
  nonce: Ref<string | null>
  /** A failed read, in the server's own words. */
  error: Ref<string | null>
  /** Assembly warnings: a referenced file the project does not hold. */
  warnings: Ref<string[]>
  /**
   * The latest brokered HighLevel failure, and the latest uncaught error inside the
   * frame — **single values, not lists**. A render loop that fails fifty times would
   * otherwise grow an unbounded banner stack, and the fiftieth message says nothing
   * the first did not.
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
   * What this document has actually spent, counted on the **host's** side.
   *
   * The shim counts too, and under an honest generation the shim is the counter that
   * fires. But the shim runs *inside* the document it restrains — its source is an
   * inline `<script>`, and anything in the frame can post straight to the parent
   * without going through `hl()` at all — so a ceiling that exists only there bounds
   * nothing. What it protects is the user's own CRM account being throttled and
   * their function invocations being spent.
   *
   * Reset by a **build**, not by a mount, which is also what bounds the cost of the
   * panel being remounted.
   */
  let brokered = 0

  /**
   * Which build a read or a brokered call belongs to — the same device the other
   * stores use: every write that lands after an `await` has to be able to ask
   * whether the thing it was answering still exists. Here it also covers a rebuild.
   */
  let generation = 0

  function current(gen: number): boolean {
    return gen === generation
  }

  /**
   * Stale means "what is on screen is not what is stored" — and only a *ready*
   * preview can be stale. The `state === 'ready'` clause is load-bearing rather than
   * defensive: without it, the tick between `filesRevision` moving and the rebuild
   * it triggers would flash the hint that exists as the alternative to rebuilding.
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
   * The two empty causes are settled from the *paths* alone, before a single read is
   * issued. Guessing an entry point was rejected: a document assembled from whichever
   * file happened to be first is a preview of something the user never asked for.
   */
  async function build(): Promise<void> {
    const gen = ++generation
    const id = workspace.projectId
    if (id === null) return

    // Every banner and warning belongs to the document that raised it, so a rebuild
    // starts from a clean panel.
    warnings.value = []
    failure.value = null
    runtimeError.value = null
    error.value = null

    // A new document is a new budget.
    brokered = 0

    const paths = workspace.files.map((file) => file.path)

    /*
     * The list is what failed, so nothing is known about this project's files —
     * least of all that it has none. An empty list plus a list error is exactly the
     * case where the empty state would be a claim with no evidence behind it.
     */
    if (paths.length === 0 && workspace.filesError !== null) {
      settleError(workspace.filesError)
      return
    }
    if (paths.length === 0) {
      settleEmpty('no_files')
      return
    }
    if (!paths.includes(ENTRY_POINT)) {
      settleEmpty('no_entry_point')
      return
    }

    /*
     * Captured before the reads: a save that lands while this build is in flight has
     * produced bytes this document does not carry, so the panel should say so the
     * moment it appears.
     */
    const revision = workspace.filesRevision
    state.value = 'loading'
    document.value = null

    let files: PreviewFile[]
    try {
      // In parallel, and bounded by the server's own file cap — the list route
      // cannot return more than twenty paths.
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
      // Reachable even though the paths were checked above: the list and the reads
      // are two round trips, and the entry point can be deleted between them.
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

  function settleError(message: string): void {
    state.value = 'error'
    error.value = message
    emptyReason.value = null
    document.value = null
    nonce.value = null
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
   * The host half of the broker.
   *
   * The nonce is captured **at entry** and checked again on the way back, and both
   * checks earn their place: the first is the acceptance gate, so a request from the
   * previous document is dropped without a call; the second covers a rebuild that
   * happened while the proxy call was in flight, where a reply would be answered by
   * a stranger and a banner would sit over a document that never made the call.
   *
   * `hlProxy` is called unchanged: the path grammar and the proxy base have exactly
   * one implementation, and this is the moment the path argument becomes LLM output.
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
      proxy: (method, path, payload) => {
        if (brokered >= HL_CALL_LIMIT) {
          // An `ApiError` so it travels the path every other failure travels: the
          // frame gets a failure reply naming the limit, and the panel gets the
          // banner. 429 because that is what it is.
          return Promise.reject(
            new ApiError(
              `This preview reached its limit of ${String(HL_CALL_LIMIT)} HighLevel calls.`,
              429,
            ),
          )
        }
        brokered += 1
        return hlProxy(method, path, payload)
      },
      // `'*'` because an opaque origin has no name to target. What makes that safe
      // is that a reply carries a HighLevel response body or an error message, and
      // no credential — see `previewBridge.ts` on the `locationId` inside it.
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
   * The file list has three outcomes, and this store owes an answer to each.
   *
   * It is the store's question rather than the panel's because a breakpoint swap
   * remounts the panel and would ask again.
   *
   * **loaded** — build, once; the *pending* arm is what keeps `ensureBuilt`'s idle
   * guard honest, since every path into `loaded` passes through `pending` first.
   *
   * **failed** — the list is what failed, so the panel says so. Without this arm
   * `filesLoaded` stays false and the panel sits on its skeleton indefinitely, and a
   * Refresh pressed out of impatience reads the empty list at face value.
   *
   * **pending** — the list has been thrown away, so the document assembled from it
   * has to go too. Walking to the dashboard and back re-opens the *same* project id,
   * which the project watcher does not fire for.
   */
  watch(
    (): 'loaded' | 'failed' | 'pending' => {
      if (workspace.filesLoaded) return 'loaded'
      return workspace.filesError === null ? 'pending' : 'failed'
    },
    (outcome) => {
      if (outcome === 'loaded') void ensureBuilt()
      else if (outcome === 'failed')
        settleError(workspace.filesError ?? 'Could not read these files.')
      else reset()
    },
    { immediate: true },
  )

  /*
   * The demo: a finished generation refreshes the preview with no interaction.
   *
   * **The default `'pre'` flush, deliberately.** A `'pre'` callback runs before the
   * component update in the same flush and `build()` reaches `state = 'loading'`
   * before its first `await`, so no frame is rendered with `state` still `'ready'`
   * and `filesRevision` already ahead — the only combination `stale` is true for. A
   * `sync` callback would instead run *between* the two increments in
   * `applyGenerationFiles`, making this store's correctness depend on their order in
   * another file.
   */
  watch(
    () => workspace.generationsApplied,
    (applied, previous) => {
      // Only **forward**. The counter also goes back to zero when the workspace
      // clears its file state, and a reset is not a generation: rebuilding for one
      // would re-run the app's `hl()` calls for an event the user never caused.
      if (applied > previous) void build()
    },
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
