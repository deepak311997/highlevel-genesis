# Slice 10 — Live preview · Technical plan

**PRD:** `02-prd.md` (approved, treated as the contract) · **Branch:** `slice/10-live-preview`
· **Date:** 2026-08-18 · **Mode:** full

## Approach

Four pure modules and one store, wired into a rewritten `PreviewPanel`, with **no server
change at all** (D19). `previewDocument.ts` turns the stored files into one self-contained
HTML string: it finds `index.html`, rewrites each `<link rel=stylesheet>` / `<script src>`
that names a *stored* flat filename into a one-line loader call, and prepends the CSP meta
and one shim `<script>` to `<head>`. `previewShim.ts` is that script — a string constant
built by `buildShim(nonce, assets)`, carrying the files as an escaped JSON literal and
defining `hl()`, the reply handler, the 50-call budget, the 30-second timeout and the error
channel. `previewBridge.ts` is the host half: a pure acceptance gate (`event.source`, tag,
version, nonce, shape) plus a broker that forwards an accepted request to an injected proxy
and posts the reply. `stores/preview.ts` holds the document, the nonce and the banners
across a breakpoint swap (D11), injects the real `hlProxy` into the bridge, and owns the two
rebuild rules. `PreviewPanel.vue` renders the four states, the one iframe, the controls and
the banners, and forwards `message` events to the store.

Alternatives considered, one line each. **Sandpack / WebContainers** — a bundler and a
runtime for three flat files; settled against before the slice began (D1). **A token in the
frame** — hands a bearer credential to LLM-written code and still fails App Check (D2). **A
`<base>` tag or `blob:` URLs for assets** — there is no URL to point a base at, and an
opaque origin cannot fetch a blob from another origin (D6). **`.toString()` on a real
function instead of a string constant** — esbuild's `keepNames` wraps it in `__name(...)`,
which is undefined inside the frame and only breaks in a production build (D8). **A bundle
route returning every file at once** — a new API contract to save nineteen round trips on a
screen opened once per generation (D13).

## Two contradictions in the PRD, resolved here

**AC-1 vs AC-7.** AC-1 says the shim `<script>` is "the first element of `<head>`"; AC-7 says
the CSP `<meta>` is "ahead of the shim". A `<meta>` is an element, so both cannot be literally
true. The only reading that satisfies each one's *purpose* — a CSP meta governs only what
follows it, and the shim must precede everything the model wrote — is:

> `<head>` opens with exactly two injected elements, in this order: the CSP `<meta>`, then the
> shim `<script>`. Everything the model wrote follows. AC-1 is asserted as "the shim is the
> first **script** in `<head>`, preceded only by the CSP meta".

**D8 vs D7.** D8 names the builder `buildShim(nonce)`; D7 requires the shim to carry
`JSON.stringify(files)`. The signature is therefore `buildShim(nonce, assets)` — D8's point is
that the *shim is a string*, not that it takes one argument, and D7's payload has to live
inside the same `<script>` for AC-1 to hold with one injected script rather than two.

Both are recorded here rather than worked around silently.

## Measured, not assumed

Probed in this repo's own jsdom before planning against it:

| Claim | Result |
|---|---|
| `iframe.contentWindow` on a `sandbox`ed `srcdoc` frame in jsdom | **present** (an object) — so AC-28 and AC-38 need no `defineProperty` hack |
| `crypto.randomUUID()` in jsdom | **present** — the nonce source |
| A `document.createElement('script')` inserted into jsdom **executes** | **no** — jsdom does not run scripts here |
| Stored file path grammar (`functions/src/files/schema.ts:98`) | `^[a-z0-9][a-z0-9._-]*$` + one of `css html js json md` — flat, lowercase, no slash |

The third is why AC-2 and AC-3 are asserted as *string* properties of the assembled document
(the matrix's own wording) and the loader's real execution is proven only at L5. The build
stage should not spend time trying to execute the loader under jsdom.

The fourth is what makes "a bare filename" precise: a reference is a candidate for rewriting
**iff** it matches that grammar (after stripping at most one leading `./`). Everything else —
`https://…`, `//…`, `/foo.js`, `a/b.js`, `x.js?v=1`, `#top` — is left byte-identical, which is
AC-5. A candidate the project does not hold is dropped and named, which is AC-6.

## File map

| File | New/Edit | What changes |
|---|---|---|
| `frontend/src/lib/api.ts` | Edit | `ApiError` gains `code` and `detail`; `messageForResponse` → `errorForResponse(res): Promise<ApiError>` |
| `frontend/src/lib/api.spec.ts` | Edit | `errorForResponse` cases (AC-22) |
| `frontend/src/lib/apiClient.ts` | Edit | `throw await errorForResponse(res)` |
| `frontend/src/lib/authApi.ts` | Edit | same |
| `frontend/src/lib/generateApi.ts` | Edit | same |
| `frontend/src/lib/previewBridge.ts` | **New** | Protocol constants and types; `readPreviewMessage`; `handlePreviewMessage` |
| `frontend/src/lib/previewBridge.spec.ts` | **New** | AC-17, AC-18 |
| `frontend/src/lib/previewShim.ts` | **New** | `encodeAssets`, `buildShim`, `HL_CALL_LIMIT`, `HL_TIMEOUT_MS` |
| `frontend/src/lib/previewShim.spec.ts` | **New** | AC-9 … AC-16, evaluated with `new Function` |
| `frontend/src/lib/previewDocument.ts` | **New** | `assemblePreview(files, nonce): AssemblyResult` |
| `frontend/src/lib/previewDocument.spec.ts` | **New** | AC-1 … AC-8 |
| `frontend/src/stores/preview.ts` | **New** | The preview's lifecycle, the broker wiring, the two rebuild rules |
| `frontend/src/stores/preview.spec.ts` | **New** | AC-19, AC-20, AC-21 + the build lifecycle |
| `frontend/src/stores/workspace.ts` | Edit | `generationsApplied`, `filesRevision` |
| `frontend/src/stores/workspace.spec.ts` | Edit | AC-23, AC-24 |
| `frontend/src/components/workspace/PreviewPanel.vue` | **Rewrite** | The real panel: states, iframe, controls, banners |
| `frontend/src/components/workspace/PreviewPanel.spec.ts` | **New** | AC-25 … AC-38 |
| `tests/e2e/helpers.ts` | Edit | Extract `connectHighLevel(page)` from `highlevel.spec.ts` |
| `tests/e2e/highlevel.spec.ts` | Edit | Use the extracted helper (no assertion changes) |
| `tests/e2e/preview.spec.ts` | **New** | AC-39 |

**Untouched, deliberately:** `functions/`, `firestore.rules`, `tests/rules/`,
`tests/integration/`, `frontend/src/lib/hlProxyApi.ts`, `frontend/package.json`,
`frontend/src/lib/deps.spec.ts`, `.env.example`. D19 is the reason and the definition of done
measures it.

## Task list

Ordered so every task leaves the suite green and nothing depends on a later one to compile.

---

### T1 — `ApiError` carries `code` and `detail` → AC-22

- **Red:** `frontend/src/lib/api.spec.ts` — `describe('errorForResponse')`:
  - `'carries the code and detail from the error envelope'` — a 409 body of
    `{ error: 'Your HighLevel connection expired.', code: 'hl_reconnect_required', detail: 'token revoked' }`
    produces an `ApiError` with all four fields.
  - `'falls back to a message a person can act on'` — a body with no `error`.
  - `'keeps the 429 message'` — status 429 still yields `Too many attempts. Try again in a few minutes.`
  - `'leaves code and detail undefined when the body carries neither'`.
  - `'survives a non-JSON body'` — the HTML-fallback case, no throw.
- **Green:** `frontend/src/lib/api.ts`.

  ```ts
  export class ApiError extends Error {
    readonly code: string | undefined
    readonly detail: string | undefined
    constructor(message: string, readonly status: number, code?: string, detail?: string) {
      super(message)
      this.name = 'ApiError'
      this.code = code
      this.detail = detail
    }
  }
  export async function errorForResponse(res: Response): Promise<ApiError>
  ```

  `code`/`detail` are declared `string | undefined` rather than `?:` so
  `exactOptionalPropertyTypes` has nothing to object to at the constructor. `errorForResponse`
  reads the body **once** (inside the existing `try`), then: message is the 429 sentence when
  the status is 429, else `body.error` when it is a non-empty string, else the existing
  fallback; `code` and `detail` are lifted only when they are strings. `messageForResponse`
  is **deleted** — every caller moves in the same commit.
- **Refactor:** replace all three call sites with `throw await errorForResponse(res)`
  (`apiClient.ts:61`, `authApi.ts:36`, `generateApi.ts:165`) and re-point their doc comments.
  The four existing `Too many attempts` assertions in `apiClient.spec.ts`,
  `generateApi.spec.ts`, `hlApi.spec.ts` and `authApi.spec.ts` must stay green untouched —
  that is the proof the change is additive.

**Estimate:** 1 h.

---

### T2 — `previewBridge.ts`: the acceptance gate and the broker → AC-17, AC-18

- **Red:** `frontend/src/lib/previewBridge.spec.ts`
  - `'ignores a request carrying the previous build's nonce'` (AC-17) — well-formed message,
    nonce `n-1` against a context holding `n`: `proxy` not called, `post` not called.
  - `'ignores a message whose source is not the frame'` — `event.source` is some other window.
  - `it.each` over four malformed shapes (AC-18): missing `id`; `kind: 'console'`; `method: 'DELETE'`;
    `path: 42`. Each: `proxy` not called, `post` not called. Plus `genesis: 'preview-host'`
    (the host's own tag echoed back) and `v: 2`.
  - `'forwards an accepted request and posts the reply'` — the happy path against a stub proxy.
  - `'posts a failure reply and reports the failure when the proxy rejects'` — an `ApiError`
    with `code` reaches both `post` and `onFailure`.
  - `'routes an error report to onRuntimeError and calls nothing else'`.
- **Green:** `frontend/src/lib/previewBridge.ts`

  ```ts
  export const PREVIEW_V = 1
  export const FRAME_TAG = 'preview'          // frame → host
  export const HOST_TAG = 'preview-host'      // host → frame
  export type PreviewMethod = 'GET' | 'POST' | 'PUT'

  export type PreviewMessage =
    | { kind: 'hl'; id: string; method: PreviewMethod; path: string; payload?: unknown }
    | { kind: 'error'; message: string }

  export interface PreviewFailure { message: string; status: number; code: string | null }

  export interface BridgeContext {
    nonce: string
    frame: Window | null
    proxy: (method: PreviewMethod, path: string, payload?: unknown) => Promise<unknown>
    post: (message: unknown) => void
    onFailure: (failure: PreviewFailure) => void
    onRuntimeError: (message: string) => void
  }

  export function readPreviewMessage(data: unknown, nonce: string): PreviewMessage | null
  export async function handlePreviewMessage(event: MessageEvent, ctx: BridgeContext): Promise<void>
  ```

  A discriminated union rather than optional-field soup, per
  `.claude/skills/feature-review/references/typescript-vue.md`. `handlePreviewMessage`
  returns immediately unless `ctx.frame !== null && event.source === ctx.frame`, then parses,
  then dispatches. On a rejected proxy call it builds
  `{ message, status, code }` from `ApiError` (`code` via `err.code ?? null`), posts
  `{ genesis: HOST_TAG, v: 1, nonce, id, ok: false, error: { message, status, ...(code && {code}) } }`
  — conditional spread, mirroring `functions/src/lib/errors.ts:71` — and calls `onFailure`.
  D17: the host reports **every** brokered failure, caught by the app or not.
- **Refactor:** pull the two reply builders (`successReply`, `failureReply`) out as named
  functions so the spec can name the shape once.

**Estimate:** 2 h.

---

### T3 — the shim's request path → AC-9, AC-10, AC-11, AC-12

- **Red:** `frontend/src/lib/previewShim.spec.ts`. A helper that evaluates the shim over stubs:

  ```ts
  function run(nonce = 'n1', assets: PreviewAsset[] = []) {
    const listeners: Record<string, ((e: unknown) => void)[]> = {}
    const posted: unknown[] = []
    const win = {
      addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn) },
      // read through globalThis at call time, so vi.useFakeTimers() applies (T4)
      setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => { globalThis.clearTimeout(id) },
    } as Record<string, unknown>
    const parent = { postMessage: (m: unknown) => posted.push(m) }
    new Function('window', 'document', 'parent', buildShim(nonce, assets))(win, document, parent)
    const fire = (type: string, event: unknown) => { for (const fn of listeners[type] ?? []) fn(event) }
    return { win, posted, fire }
  }
  ```

  Cases: AC-9 — `hl('POST', '/contacts/search', { pageLimit: 20 })` posts **exactly one**
  message with `genesis: 'preview'`, `v: 1`, the nonce, a non-empty `id`, `kind: 'hl'`, and the
  three arguments, and the returned promise is still pending (asserted with
  `Promise.race([p, Promise.resolve('pending')])`). AC-10 — firing a success reply for that
  `id`/nonce resolves with `data` **identity-compared** (`toBe`, not `toEqual`). AC-11 —
  a failure reply rejects with an `Error` carrying `message`, `status`, `code`. AC-12 — a
  reply with an unknown `id`, and one with a different `nonce`, each leave the promise pending.
- **Green:** `frontend/src/lib/previewShim.ts` — `encodeAssets`, `buildShim` and the shim
  source (appendix below). `encodeAssets` gets its own two cases here: the round-trip through
  `JSON.parse` is byte-identical, and the literal contains no `<` at all.
- **Refactor:** assert the invariant that makes D7 work as one line:
  `expect(buildShim('n', [])).not.toContain('<')` — the shim source is written without a
  single `<` character, so it can never terminate its own `<script>` element.

**Estimate:** 3 h.

---

### T4 — the shim's budget, timeout and error channel → AC-13, AC-14, AC-15, AC-16

- **Red:** same spec file.
  - AC-13 — 50 calls, then a 51st: rejects with a message containing `50`, posts **no**
    further `kind: 'hl'` message, and posts exactly one `kind: 'error'`.
  - AC-14 — `vi.useFakeTimers()`, one call, `vi.advanceTimersByTime(30_000)` → rejects.
    (The stub's `setTimeout` reads `globalThis.setTimeout` at call time, which is why the
    fake timers reach it.)
  - AC-15 — `fire('error', { message: 'boom' })` and
    `fire('unhandledrejection', { reason: new Error('nope') })` each post exactly one
    `kind: 'error'` carrying the text.
  - AC-16 — `fire('securitypolicyviolation', { violatedDirective: 'connect-src' })` posts a
    `kind: 'error'` naming `connect-src`.
- **Green:** the corresponding branches of the shim source.
- **Refactor:** the two limit constants become exported named constants
  (`HL_CALL_LIMIT = 50`, `HL_TIMEOUT_MS = 30_000`) interpolated into the source, so the
  message and the test read the same number.

**Estimate:** 2 h.

---

### T5 — `previewDocument.ts`: entry point, doctype, CSP, shim → AC-1, AC-7, AC-8

- **Red:** `frontend/src/lib/previewDocument.spec.ts`
  - AC-8 — files with no `index.html` → `{ ok: false, reason: 'no_entry_point' }`, and no
    document is produced. A second case: an empty file list, same answer.
  - AC-1 — the output starts with `<!doctype html>` (also when the source has none), and in
    `<head>` the injected `<script>` is the first script, preceded only by the CSP meta.
  - AC-7 — the exact string
    `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">` is present and
    its index is **less than** the shim script's index.
  - A source with no `<head>` (bare `<html><body>`) still gets both injected.
- **Green:**

  ```ts
  export interface PreviewFile { path: string; content: string }
  export type AssemblyResult =
    | { ok: true; html: string; warnings: string[] }
    | { ok: false; reason: 'no_entry_point' }
  export function assemblePreview(files: readonly PreviewFile[], nonce: string): AssemblyResult
  ```

  Insertion point: after `<head...>` if one exists, else after `<html...>`, else at the very
  front. The doctype is prepended when the source (after leading whitespace) does not already
  begin with `<!doctype` case-insensitively. Note in the header comment that a generated
  `<meta charset>` stays inside the first 1024 bytes even with both injections ahead of it.
- **Refactor:** name the two injected strings as module constants so AC-7's literal has one home.

**Estimate:** 2 h.

---

### T6 — reference rewriting → AC-2, AC-3, AC-4, AC-5, AC-6

- **Red:** same spec file.
  - AC-2 — `<link rel="stylesheet" href="styles.css">` with a stored `styles.css`: no `<link`
    survives, a loader call sits at that position, and the CSS is the asset at that index with
    `kind: 'css'`.
  - AC-3 — `<script src="app.js"></script>` with a stored `app.js`: replaced in place by a
    loader call naming that index, `kind: 'js'`, and the two assets are in document order.
  - AC-4 — a stored `app.js` containing the literal text `</script>` and a stored `styles.css`
    containing `</style>`: both are recovered **byte-identical** by extracting the assets
    literal from the document and `JSON.parse`ing it, and the document contains no `</script`
    other than the ones the source itself wrote.
  - AC-5 — `https://cdn.test/x.css`, `//cdn.test/x.js`, `/root.js`, `a/b.js`, `x.js?v=1`: each
    element appears in the output **byte-identical** to the input, and produces no warning.
  - AC-6 — `<script src="missing.js"></script>` with no stored `missing.js`: the element is
    gone from the output and `warnings` contains one entry naming `missing.js`.
  - `./styles.css` resolves to the stored `styles.css` (one leading `./` is stripped). Noted
    as **beyond the AC**: it can only turn a silently-broken reference into a working or a
    warned one.
  - A `<link rel="icon" href="favicon.png">` is left alone — only `rel` containing
    `stylesheet` is rewritten.
- **Green:** the scanner. Two regexes over the tag only, so everything outside a rewritten tag
  is untouched:

  ```ts
  const LINK = /<link\b[^>]*>/gi
  const SCRIPT = /<script\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>\s*<\/script\s*>/gi
  const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i')
  const BARE = /^[a-z0-9][a-z0-9._-]*$/   // the stored-path grammar, mirrored
  ```

  A regex rather than `DOMParser`: the parser normalises markup, which would break AC-5's
  "byte-identical" and AC-4's round-trip, and would put a second HTML parser between the
  model's output and the browser's.
- **Refactor:** one `rewriteReference(tag, url, kind)` used by both scanners, so the
  absolute / bare / missing decision exists once.

**Estimate:** 3 h.

---

### T7 — the workspace store's two signals → AC-23, AC-24

- **Red:** `frontend/src/stores/workspace.spec.ts`
  - AC-23 — a generation reaching `done` with `files: ['index.html']` increments
    `generationsApplied` **after** the `GET .../files` refetch (asserted by ordering: the
    counter is still 0 while the list request is unresolved, and 1 once it settles).
  - AC-23 — a `done` with `files: []`, an `error` event, and an abort each leave
    `generationsApplied` at 0.
  - AC-24 — a successful `saveFile()` increments `filesRevision` and leaves
    `generationsApplied` alone; a **failed** save moves neither.
  - Both are reset to 0 by `reset()` and by opening a different project.
- **Green:** `frontend/src/stores/workspace.ts`
  - two refs, added to `WorkspaceStore` and to the returned object;
  - in `applyGenerationFiles` (currently `workspace.ts:707`), replace
    `if (written.length > 0) await loadFiles()` with

    ```ts
    if (written.length > 0) {
      await loadFiles()
      if (!current(gen)) return
      filesRevision.value += 1
      generationsApplied.value += 1
    }
    ```

    — one place, both counters, after the refetch, behind the existing generation guard;
  - in `saveFile`, `filesRevision.value += 1` immediately after the `files.value = files.value.map(...)`
    update;
  - both zeroed in `clearFileState()`, which `open` and `reset` already share.
- **Refactor:** one doc comment above the pair explaining D12 — why two counters and not one
  flag, and that a save deliberately does not move `generationsApplied`.

**Estimate:** 1.5 h.

---

### T8 — `stores/preview.ts`: the build lifecycle

Underpins AC-25 … AC-29, AC-37 (all asserted at L2 in T10–T12); its own cases live in
`stores/preview.spec.ts`.

- **Red:** `frontend/src/stores/preview.spec.ts` — mocks `@/stores/workspace` with a
  `reactive` fake and `@/lib/filesApi`'s `getFile`; mocks `@/lib/firebase` and
  `@/lib/appCheck` the way `workspace.spec.ts` does.
  - no files → `state: 'empty'`, `emptyReason: 'no_files'`, no document;
  - files without `index.html` → `emptyReason: 'no_entry_point'`;
  - a build reads every listed path **in parallel** (`getFile` called once per path) and
    lands in `state: 'ready'` with a document and a nonce;
  - a rejected `getFile` → `state: 'error'` carrying the server's message; `build()` again
    recovers;
  - a second build produces a **different** nonce and a different document string;
  - `build()` clears `warnings`, `failure` and `runtimeError` before it starts (AC-37);
  - a build whose reads land after the project changed does not write state (the generation guard);
  - `generationsApplied` incrementing triggers a rebuild; `filesRevision` incrementing alone
    does not, and makes `stale` true.
- **Green:**

  ```ts
  export type PreviewState = 'idle' | 'loading' | 'empty' | 'error' | 'ready'
  export interface PreviewStore {
    state: Ref<PreviewState>
    emptyReason: Ref<'no_files' | 'no_entry_point' | null>
    document: Ref<string | null>
    nonce: Ref<string | null>
    error: Ref<string | null>
    warnings: Ref<string[]>
    failure: Ref<PreviewFailure | null>
    runtimeError: Ref<string | null>
    builtRevision: Ref<number>
    stale: ComputedRef<boolean>
    reconnectable: ComputedRef<boolean>
    build: () => Promise<void>
    ensureBuilt: () => Promise<void>
    handleMessage: (event: MessageEvent, frame: Window | null) => Promise<void>
    reset: () => void
  }
  ```

  The store calls `useWorkspaceStore()` in its setup and owns three watchers:

  ```ts
  watch(() => workspace.projectId, () => { reset() })
  watch(() => workspace.filesLoaded, (loaded) => { if (loaded) void ensureBuilt() }, { immediate: true })
  watch(() => workspace.generationsApplied, () => { void build() }, { flush: 'sync' })
  ```

  `flush: 'sync'` on the third is load-bearing: with the default `'pre'` flush there is a tick
  in which `state` is still `'ready'` and `filesRevision` has already moved, so the stale hint
  would flash before the rebuild it is meant to be an alternative to. `stale` requires
  `state === 'ready'` for the same reason. `nonce` comes from `crypto.randomUUID()` (measured
  present in jsdom). A `generation` counter guards every write after an `await`, the way
  `workspace.ts:369` and `hl.ts` both do. `failure` and `runtimeError` are **single latest**
  values rather than lists, so a generated render loop that fails fifty times cannot grow an
  unbounded banner stack (R3's neighbour).
- **Refactor:** a header comment carrying D11 (why not the workspace store, why not the
  component) and D13 (why no bundle route).

**Estimate:** 3 h.

---

### T9 — the store's broker wiring → AC-19, AC-20, AC-21

- **Red:** `stores/preview.spec.ts`, with `fetch` stubbed — the **real** `hlProxy`, because
  AC-20 asserts a network request is never made.
  - AC-19 — a well-formed request from the frame: `fetch` is called once with
    `/api/hl/proxy/contacts/search`, method `POST` and the payload as the body, and a success
    reply carrying the returned body is posted to the frame's `postMessage`.
  - AC-20 — `path: '/../../projects'`: a failure reply is posted and `fetch` is **never** called.
  - AC-21 — a 409 answer of
    `{ error: 'Your HighLevel connection expired.', code: 'hl_reconnect_required' }`: the
    failure reply's `error` carries `message`, `status: 409` and that `code`, and `failure`
    on the store carries the same — so `reconnectable` is true.
  - A reply is **not** posted when the nonce moved while the proxy call was in flight.
- **Green:** `handleMessage` builds a `BridgeContext` capturing the nonce at entry:

  ```ts
  async function handleMessage(event: MessageEvent, frame: Window | null): Promise<void> {
    const built = nonce.value
    if (built === null) return
    const live = <T,>(fn: (value: T) => void) => (value: T) => { if (nonce.value === built) fn(value) }
    await handlePreviewMessage(event, {
      nonce: built,
      frame,
      proxy: (method, path, payload) => hlProxy(method, path, payload),
      post: live((message) => { frame?.postMessage(message, '*') }),
      onFailure: live((value) => { failure.value = value }),
      onRuntimeError: live((message) => { runtimeError.value = message }),
    })
  }
  ```

  `targetOrigin: '*'` is D3 and R6: an opaque origin has no name, which is exactly why D2's
  rule that a reply never carries a credential is load-bearing.
- **Refactor:** name the `live` wrapper and comment why a post-await nonce check exists on top
  of the pre-await one (a rebuild mid-flight must not raise a banner over the new document —
  AC-37).

**Estimate:** 2 h.

---

### T10 — `PreviewPanel`: the four states and the iframe → AC-25, AC-26, AC-27, AC-28

- **Red:** `frontend/src/components/workspace/PreviewPanel.spec.ts`. Mocks
  `@/stores/workspace` (a `reactive` fake, `EditorPanel.spec.ts`'s pattern) and
  `@/lib/filesApi`; uses the **real** `@/stores/preview` with `createPinia()`, so the panel
  and its store are tested as the one surface the ACs describe.
  - AC-25 — while the reads are in flight: `preview-loading` visible, **no** `iframe`;
  - AC-26 — both empty causes: `preview-empty` naming what to do next, no `iframe`;
  - AC-27 — a rejected read: `preview-error` carrying the server's message, and a
    `preview-retry` control whose click calls `getFile` again;
  - AC-28 — ready: exactly one `iframe`, `sandbox` **exactly** `allow-scripts allow-forms`
    (asserted with `toBe`, and separately `not.toContain('allow-same-origin')`), `srcdoc`
    identical to `preview.document`.
- **Green:** `PreviewPanel.vue`. Header with the title and the controls; a `v-if` chain over
  `state`. The iframe:

  ```html
  <iframe
    ref="frame"
    :key="preview.nonce ?? ''"
    data-testid="preview-frame"
    title="App preview"
    sandbox="allow-scripts allow-forms"
    :srcdoc="preview.document ?? ''"
    class="h-full w-full border-0 bg-white"
  />
  ```

  `:key` on the nonce so a rebuild replaces the element rather than renavigating it — the
  previous document's `WindowProxy` is then gone as well as out-of-nonce, which is D3's
  stale-document race closed twice. `sandbox` is a **static** attribute, so nothing can
  compute it.
- **Refactor:** a header comment carrying D9 (why `allow-same-origin` is absent and what it
  would cost) and D2 in one sentence.

**Estimate:** 3 h.

---

### T11 — controls and rebuild triggers → AC-29, AC-30, AC-31, AC-32

- **Red:** same spec.
  - AC-29 — clicking `preview-refresh` re-reads every file and the nonce changes;
  - AC-30 — `workspace.generating` true → the control is `disabled`;
  - AC-31 — bumping the fake store's `generationsApplied` rebuilds with no interaction;
  - AC-32 — bumping `filesRevision` alone shows `preview-stale` reading
    **"Files changed — Refresh"** and does **not** refetch; clicking the hint's control rebuilds.
- **Green:** the header's `Refresh` button (`:disabled="workspace.generating"`,
  `@click="preview.build()"`) and the stale hint rendered on `preview.stale`. The triggers
  themselves already live in the store's watchers (T8) — which is why they are observable here.
- **Refactor:** the hint and the Refresh button share one `rebuild()` handler.

**Estimate:** 2 h.

---

### T12 — banners → AC-33, AC-34, AC-35, AC-36, AC-37, AC-38

- **Red:** same spec.
  - AC-33 — a brokered failure puts its message in `preview-failure`;
  - AC-34 — `it.each(['hl_reconnect_required', 'hl_not_connected'])` — the banner also renders
    a **Reconnect HighLevel** link whose `to` prop is `/dashboard`; a third code renders no link;
  - AC-35 — a `kind: 'error'` report from the frame renders `preview-runtime-error`;
  - AC-36 — an assembly warning renders `preview-warning` naming the missing file;
  - AC-37 — with all three on screen, a rebuild clears every one of them before the new
    `srcdoc` is set;
  - AC-38 — a `message` event whose `source` is `window` (not the frame's `contentWindow`) is
    ignored entirely: no banner, no `hlProxy` call, nothing posted.
- **Green:** `onMounted` installs `window.addEventListener('message', onMessage)` and
  `onBeforeUnmount` removes it; `onMessage` forwards to
  `void preview.handleMessage(event, frameEl.value?.contentWindow ?? null)`. Three
  hand-rolled `Alert`s under the header (D17), the reconnect one carrying a `RouterLink` to
  `/dashboard`. Stubbed the way `frontend/src/components/ProjectsCard.spec.ts:66` already
  does it — `mount(..., { global: { stubs: { RouterLink: RouterLinkStub } } })` with
  `RouterLinkStub` from `@vue/test-utils`, and the target read with
  `findComponent(RouterLinkStub).props('to')` rather than from an `href`.
- **Refactor:** note in the header that Slice 12 owns the styling of these three and should
  fold them into `sonner`/`skeleton` rather than leave two idioms (the PRD's inherited
  constraint).

**Estimate:** 3 h.

---

### T13 — the demo, end to end → AC-39

- **Red:** `tests/e2e/preview.spec.ts` — sign up and verify, connect the fake HighLevel
  location, create a project, send the plain prompt, wait for the generation to finish, then:
  - the preview refreshes **by itself** — no click — and `preview-frame` appears;
  - `page.frameLocator('[data-testid="preview-frame"]')` shows a fixture contact name
    (`/casey morgan/i`, from `tests/fixtures/highlevel/contacts-search.json`);
  - **and** `page.waitForResponse` sees a 2xx on `**/api/hl/proxy/contacts/search` — the
    host-visible evidence that a brokered call really went out;
  - no failure banner: `preview-failure` and `preview-runtime-error` are both hidden.

  **R1's fallback, decided now so the build stage does not invent one under pressure:** if
  Playwright genuinely cannot read inside the opaque-origin frame, drop *only* the
  `frameLocator` assertion, keep the `waitForResponse` and the no-banner assertions, and
  record the substitution in `04-build-log.md` **and** in the PR body. Do not weaken anything
  else, and do not make the assertion conditional at runtime.

  The fixture app calls `hl('POST', '/contacts/search', …)` and then
  `hl('GET', '/calendars/events', …)`; both are allowlisted and both are answered by the
  emulator-only fake (`functions/src/hl/fake.ts:458` and `:491`). Its top-level `try/catch`
  replaces the list with an error message if **either** fails, so a green run is evidence for
  both hops.
- **Green:** nothing new — this is the assembly of T1–T12. If it is red, the bug is in them.
- **Refactor:** extract `connectHighLevel(page)` into `tests/e2e/helpers.ts` from
  `tests/e2e/highlevel.spec.ts:36-56` (the Connect click through the location name) and use it from both. That file's own header states the
  rule: extract when a second suite needs it, because a second copy is where two specs start
  to disagree. `highlevel.spec.ts`'s assertions do not change.

**Estimate:** 3 h.

---

## AC coverage

Every acceptance criterion maps to at least one task. **No AC is unmapped.**

| Task | ACs |
|---|---|
| T1 | AC-22 |
| T2 | AC-17, AC-18 |
| T3 | AC-9, AC-10, AC-11, AC-12 |
| T4 | AC-13, AC-14, AC-15, AC-16 |
| T5 | AC-1, AC-7, AC-8 |
| T6 | AC-2, AC-3, AC-4, AC-5, AC-6 |
| T7 | AC-23, AC-24 |
| T8 | (lifecycle — surfaces AC-25…AC-29, AC-37, asserted in T10–T12) |
| T9 | AC-19, AC-20, AC-21 |
| T10 | AC-25, AC-26, AC-27, AC-28 |
| T11 | AC-29, AC-30, AC-31, AC-32 |
| T12 | AC-33, AC-34, AC-35, AC-36, AC-37, AC-38 |
| T13 | AC-39 |

T8 is the one task with no AC of its own. That is deliberate rather than a gap: it is the
store the panel's ACs are all asserted *through*, and shipping it inside T10 would make one
commit carry a store, a component and eleven criteria.

## Firestore rules changes

**None.** This slice adds no collection, no document shape and no field; `firestore.rules` is
not opened. The PRD's definition of done requires that to be *measured* rather than assumed
(D19), so the build stage records, in `04-build-log.md`, the output of both of these on
`main` and on the branch, and that the two agree:

```sh
git diff --stat main -- firestore.rules functions/src   # must be empty
npm run test:rules 2>&1 | tail -5                        # case count unchanged
npm run test:integration 2>&1 | tail -5                  # case count unchanged
```

The existing L3 denial tests for `users/{uid}/projects/{projectId}/files` are what already
prove the frontend cannot reach these documents except through the API; nothing here weakens
that, because nothing here touches Firestore at all.

## Dependencies

**None.** No package is added to `frontend/package.json`, which is D1 and is already asserted
by `frontend/src/lib/deps.spec.ts` — its `EXPECTED` list is the whole allowed dependency set,
so a stray install fails that suite rather than passing review. `frontend/src/lib/no-cdn.spec.ts`
and `no-firestore.spec.ts` likewise stay green untouched; the new modules import neither a CDN
URL nor `firebase/firestore`.

## Manual verification

On emulators, from a clean checkout:

1. `npm run dev`, sign up, verify, and connect the sandbox HighLevel location from the dashboard.
2. Create a project and open it. **The preview panel shows the empty state** naming the chat
   box, and renders no iframe.
3. Send *"build a contact dashboard"*. Watch the files stream into the editor.
4. When the reply finishes, **the preview refreshes by itself** and lists the five fixture
   contacts. No banner is on the panel. *(This is the demo.)*
5. Open `app.js` in Monaco, change a string, **Save**. The preview shows
   **Files changed — Refresh** and does *not* rebuild. Press it; the app reloads with the edit.
6. Send a second prompt and, while it is streaming, confirm **Refresh** is disabled.
7. Resize the window across the `lg` breakpoint. The preview re-renders the same document and
   issues **no** new file reads (check the network tab).
8. Edit `app.js` to `fetch('https://example.com')` and Save, then Refresh: the panel shows a
   runtime-error banner naming the blocked directive rather than failing silently.
9. Edit `app.js` to `hl('GET', '/../../projects')` and Refresh: a failure banner, and no
   request to anything but `/api/hl/proxy`.
10. **With real credentials against the real sandbox account** (the unautomatable check the
    PRD requires): generate a contact dashboard, confirm real contacts render, then disconnect
    HighLevel from the dashboard and Refresh — confirm the banner appears **and** offers
    **Reconnect HighLevel**. Paste the result into the PR.
11. **Production-build check (D8's rejected alternative is what this guards):**
    `npm run build && npm --prefix frontend run preview`, then confirm the shim string is
    emitted intact in the bundle — `grep -c 'genesis-preview\|preview-host' frontend/dist/assets/*.js`
    finds it, and it contains no `__name(` wrapper.

## Estimate

| Task | Estimate |
|---|---|
| T1 — `ApiError` gains `code`/`detail` | 1 h |
| T2 — `previewBridge` | 2 h |
| T3 — shim: request path | 3 h |
| T4 — shim: budget, timeout, errors | 2 h |
| T5 — assembler: entry, doctype, CSP, shim | 2 h |
| T6 — assembler: reference rewriting | 3 h |
| T7 — workspace signals | 1.5 h |
| T8 — preview store lifecycle | 3 h |
| T9 — preview store broker | 2 h |
| T10 — panel states and iframe | 3 h |
| T11 — controls and triggers | 2 h |
| T12 — banners | 3 h |
| T13 — e2e | 3 h |
| **Total** | **~30.5 h (≈ 4 days)** |

Nothing is over half a day. The four at 3 h — T3, T6, T10, T12 — are the ones to watch, and
each is at the top of its estimate for the same reason: a lot of small assertions over one
surface. This is the large PR R9 names; the split it suggests is not taken, because the first
half cannot be demoed.

---

## Appendix — the shim source, as intended

Handed over literally because D8 makes it a string that nothing typechecks (R2), and the
evaluation tests in T3/T4 are what stand in for the compiler. **Written with no `<` character
anywhere**, so it can never terminate the `<script>` element that carries it.

```js
;(function () {
  var NONCE = <nonce literal>
  var ASSETS = <assets literal — JSON with every "<" written as <>
  var LIMIT = <HL_CALL_LIMIT>
  var TIMEOUT = <HL_TIMEOUT_MS>
  var pending = {}
  var seq = 0
  var used = 0

  function post(message) {
    parent.postMessage(message, '*')
  }

  function report(message) {
    post({ genesis: 'preview', v: 1, nonce: NONCE, kind: 'error', message: String(message) })
  }

  window.hl = function (method, path, payload) {
    if (used >= LIMIT) {
      var over = 'This preview reached its limit of ' + LIMIT + ' HighLevel calls.'
      report(over)
      return Promise.reject(new Error(over))
    }
    used += 1
    seq += 1
    var id = 'c' + seq
    return new Promise(function (resolve, reject) {
      var timer = window.setTimeout(function () {
        delete pending[id]
        reject(new Error('HighLevel did not answer within 30 seconds.'))
      }, TIMEOUT)
      pending[id] = { resolve: resolve, reject: reject, timer: timer }
      var message = {
        genesis: 'preview', v: 1, nonce: NONCE, id: id,
        kind: 'hl', method: method, path: path,
      }
      if (payload !== undefined) message.payload = payload
      post(message)
    })
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.genesis !== 'preview-host' || data.v !== 1 || data.nonce !== NONCE) return
    var entry = pending[data.id]
    if (!entry) return
    delete pending[data.id]
    window.clearTimeout(entry.timer)
    if (data.ok) {
      entry.resolve(data.data)
      return
    }
    var info = data.error || {}
    var err = new Error(info.message || 'That HighLevel call failed.')
    err.status = info.status || 0
    if (info.code) err.code = info.code
    entry.reject(err)
  })

  window.addEventListener('error', function (event) {
    report(event.message || 'The preview raised an error.')
  })

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason
    report((reason && reason.message) || String(reason))
  })

  window.addEventListener('securitypolicyviolation', function (event) {
    report('The preview was blocked by its content security policy: ' + event.violatedDirective + '.')
  })

  window.__genesisAsset = function (index) {
    var asset = ASSETS[index]
    if (!asset) return
    var node = document.createElement(asset.kind === 'css' ? 'style' : 'script')
    node.textContent = asset.content
    var self = document.currentScript
    if (self && self.parentNode) self.parentNode.replaceChild(node, self)
    else document.head.appendChild(node)
  }
})()
```

`err.status` and `err.code` are assigned onto a plain `Error` because that is exactly the
contract Slice 9's system prompt teaches generated code (`err.code === 'hl_reconnect_required'`),
and this shim is the second of the two places that contract is implemented. The PRD's
inherited constraint stands: neither may change without the other, and `hl(` is the seam.

The replaced tag the assembler emits at each rewritten position is one line and carries no
content of its own:

```html
<script>window.__genesisAsset(0)</script>
```
