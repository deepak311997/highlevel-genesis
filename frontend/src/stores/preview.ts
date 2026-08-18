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
 * **A store rather than the panel's own state** (D11). The `lg` breakpoint swaps
 * one component tree for another, so anything held in `PreviewPanel` is destroyed
 * by a window resize — the same argument that put the composer's draft in a store
 * in Slice 4. Held here, a breakpoint swap re-renders the same document instead of
 * refetching every file.
 *
 * It does **not** save the app from re-running. A new `<iframe>` element executes
 * its `srcdoc` from scratch, so the generated app's `hl()` calls go out again on
 * every remount — a breakpoint crossing, and on the narrow layout every switch
 * away from the Preview tab and back, since `Tabs` unmounts hidden content by
 * default. What bounds that is `brokered` below: it is reset by a *build*, not by
 * a mount, so one document spends at most `HL_CALL_LIMIT` however many times it
 * is remounted. Keeping the frame alive across the swap is a layout change —
 * Slice 4's two component trees, and Monaco's habit of measuring zero inside a
 * hidden container — and is recorded in this slice's review rather than done
 * here.
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
   * What this document has actually spent, counted on the host's side of the
   * boundary (D15).
   *
   * The shim counts too, and under an honest generation the shim is the counter
   * that fires — it rejects locally, so the call never leaves the frame. But the
   * shim runs *inside* the document it restrains: its source is an inline
   * `<script>`, so the nonce is there to be read, and anything running in the
   * frame can post straight to the parent without going through `hl()` at all. A
   * ceiling that exists only there bounds nothing. What it is protecting is the
   * user's own CRM account being throttled (`HIGHLEVEL_PLATFORM.md` §5) and their
   * function invocations being spent, so the decision of how much to spend is not
   * the frame's to make.
   *
   * Reset by a **build**, not by a mount — which is also what bounds the cost of
   * the panel being remounted (a breakpoint crossing, or a tab switch on the
   * narrow layout): the same document re-runs, but it re-runs against the budget
   * it has already spent, so one document costs at most this many calls in total.
   *
   * Not a `ref`: nothing renders it.
   */
  let brokered = 0

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

    // A new document is a new budget.
    brokered = 0

    const paths = workspace.files.map((file) => file.path)

    /*
     * The list is what failed, so nothing at all is known about this project's
     * files — least of all that it has none. `loadFiles` leaves the previous list
     * alone when it fails, so an empty list plus a list error is exactly the case
     * where the empty state would be a claim with no evidence behind it, made
     * about a project that may well hold twenty files.
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
      proxy: (method, path, payload) => {
        if (brokered >= HL_CALL_LIMIT) {
          // An `ApiError` so it travels the path every other failure travels:
          // the frame gets a failure reply naming the limit, and the panel gets
          // the banner. 429 because that is what it is — too many requests.
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
      // `'*'` because an opaque origin has no name to target (D3, R6). What makes
      // that safe is D2: a reply carries a HighLevel response body or an error
      // message, and no credential and nothing identifying the Genesis account.
      // The body does carry HighLevel's own `locationId` — see `previewBridge.ts`
      // for why that is a tenant identifier rather than a credential.
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
   * remounts the panel and would ask again, and because two of the three answers
   * are states the panel only renders.
   *
   * **loaded** — build, once. `ensureBuilt`'s idle guard is what makes "once"
   * true, and the *pending* arm is what keeps that guard honest: every path into
   * `loaded` passes through `pending` first, so the state it finds is `idle`.
   *
   * **failed** — the list is the thing that failed, so the panel says so. Without
   * this arm nothing moved at all: `filesLoaded` stays `false` on a failed load,
   * so the panel sat on its loading skeleton indefinitely, and a Refresh pressed
   * out of impatience read the empty list at face value and announced that the
   * project has no app yet.
   *
   * **pending** — the list has been thrown away, so the document assembled from
   * it has to go too. `workspace.open` clears the file state and refetches it,
   * and `WorkspaceView` calls `open` with `immediate: true` on every mount — so
   * walking to the dashboard and back re-opens the *same* project id, which the
   * project watcher above does not fire for, because nothing about the project
   * changed. Without this arm the panel was stranded on whatever state the empty
   * interval left behind, until someone pressed Refresh.
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
   * The demo (F6.4): a finished generation refreshes the preview with no
   * interaction at all.
   *
   * **The default `'pre'` flush, deliberately.** This ran `sync` on the argument
   * that the stale hint would otherwise flash between `filesRevision` moving and
   * the rebuild it triggers. It would not, and `sync` bought that non-problem at
   * a real price. It would not, because a `'pre'` callback runs before the
   * component update in the same flush, and `build()` reaches `state = 'loading'`
   * before its first `await` — so no frame is ever rendered with `state` still
   * `'ready'` and `filesRevision` already ahead, which is the only combination
   * `stale` is true for. The price was that a `sync` callback runs *between* the
   * two increments in `applyGenerationFiles`, so this store's correctness
   * depended on `filesRevision` being written before `generationsApplied` in a
   * function in another 1,100-line file, with nothing on either side saying so.
   */
  watch(
    () => workspace.generationsApplied,
    (applied, previous) => {
      // Only **forward**. The counter also goes back to zero when the workspace
      // clears its file state, and a reset is not a generation: rebuilding for
      // one would re-run the app's `hl()` calls against the account's rate-limit
      // budget (R5) for an event the user never caused.
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
