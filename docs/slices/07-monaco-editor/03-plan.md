# Slice 07 — Monaco editor · Technical plan

**PRD:** `02-prd.md` (approved) · **Branch:** `slice/07-monaco-editor` · **Mode:** fast ·
**Date:** 2026-08-18

## Approach

Four pure modules carry every decision that can be decided without a browser — the language
map, the append-vs-replace edit, the project-scoped model registry, and the local-monaco
setup — and one component, `CodeEditor.vue`, is the only place that touches the editor
instance. The store's single file buffer becomes a map keyed by path with `openTabs` beside
it, and everything `FileEditor.vue` renders keeps its name, so the diff reads as "the buffer
model changed" rather than as a rename spread over four files. Models are **ours**, not the
wrapper's: the `path`/`value`/`language` props are left unbound, so the wrapper's own watcher
— which calls `setValue` per change and keys models in monaco's *global* registry — never
runs, and streaming reaches the document as `model.applyEdits` over the tail.

Alternatives considered:

- **Bind the wrapper's `value` prop** and let it drive the document — rejected: its watcher is
  literally `editor.setValue(newValue)` per chunk (verified in `lib/es/index.js`), which is
  D8/R1's hazard by construction.
- **Bind the wrapper's `path` prop** and let it own models — rejected: `createModelUri` is
  `monaco.Uri.parse(path)` into monaco's global registry, so two projects with an `index.html`
  share one model and one undo stack (R5).
- **reka-ui `Tabs` for the strip** — rejected: a closable tab needs a `<button>` inside
  `TabsTrigger`'s `<button>`, and there is no per-tab `TabsContent` because all tabs share one
  editor (D13).
- **Extract `useProjectFiles` from the store in this slice** — rejected by D22; the file half is
  being rewritten, and moving it at the same time produces the diff shape a review misses things
  in.
- **Mount real Monaco at L2** — rejected by D23: jsdom has no layout and no canvas metrics, so
  such a test proves the mock works.

## Verified against the real packages

Everything below was read out of the published tarballs, not out of documentation. It is
recorded because four plan decisions turn on it.

| Claim | Where it was verified |
|---|---|
| `monaco-editor@0.52.2` has **no `exports` map** and the classic `esm/vs/...` layout | `package/package.json` — `typings: ./esm/vs/editor/editor.api.d.ts`, no `exports` key |
| The wrapper's `.d.ts` imports `monaco-editor/esm/vs/editor/editor.api` | `@guolao/vue-monaco-editor@1.6.0` `lib/index.d.ts` line 5 |
| `loader.config({ monaco })` short-circuits `init()` with **no network** | `@monaco-editor/loader@1.6.1` `lib/es/loader/index.js` — `if (state.monaco) { state.resolve(state.monaco); return … }`, before `injectScripts` |
| `init()` also accepts `window.monaco` | same file — `if (window.monaco && window.monaco.editor) { … }` |
| The wrapper emits `mount(editor, monaco)` and `update:value(value)` | `emits: [...]` and `useEditor()` in `lib/es/index.js` |
| The wrapper's `path`/`value` watcher calls `setValue` and `setModel` | `lib/es/index.js`, the `watch([() => props.path, () => props.value, …])` block |
| The wrapper's `onUnmounted` disposes `editorRef.value.getModel()` | `lib/es/index.js` — **this is why T11 detaches the model before unmount** |
| The wrapper renders `#default` while loading and `#failure` on load failure | its `render()` |
| `edcore.main.js` is `editor.all.js` + standalone contributions + `export * from './editor.api.js'` | `esm/vs/editor/edcore.main.js` |
| **`edcore.main` ships no `.d.ts`** — only `editor.api.d.ts` does | tarball listing; this is why T1 adds an ambient declaration |
| `basic-languages/{html,css,javascript,markdown}/*.contribution.d.ts` **do** exist | tarball listing — so those four are plain typed side-effect imports |
| `esm/vs/editor/editor.worker.js` exists; `MonacoEnvironment` is declared globally | tarball listing; `editor.api.d.ts` line 12, `declare global { let MonacoEnvironment: Environment \| undefined }` |
| `readOnlyMessage?: IMarkdownString`, `getEditors()`, `getModels()`, `createModel(value, language?, uri?)`, `getModel(uri)`, `setTheme`, `ITextModel.applyEdits`, `getFullModelRange`, `getLineCount`, `IStandaloneCodeEditor.{saveViewState,restoreViewState,setModel,getModel,revealLine}` | `esm/vs/editor/editor.api.d.ts` |
| monaco ships **no** `basic-languages/json` | tarball listing — D4 confirmed |

## Plan-level decisions

Four calls the PRD did not foresee. Each is a consequence of what the packages actually do.

| # | Question | Decision | Rationale |
|---|---|---|---|
| **P1** | **AC-24 says a `done` with empty `files` changes no buffer — but D11 lets a generation open a tab, and Slice 6's `autoSelected` rule then has to take it back.** | `file_start` **opens a tab without creating a buffer**. `editorContent` already prefers `streamingFiles`, so the arriving bytes render with no buffer entry to speak of. At `done`, a tab the generation opened for a path that was *not* written is closed and forgotten; a path that *was* written is re-read like any other open tab. | This is what makes AC-24 literally true — an empty `files` touches `buffers` not at all — while still discharging the Slice 6 hazard its AC-40 tests name: an auto-selected tab whose bytes were refused would otherwise show an empty editor over a file that has content, with **Save** offering to overwrite it. The only thing the refusal path changes is the tab list, which is the thing the generation created. |
| **P2** | **AC-27 needs the resolved theme, and `useTheme()` is per-call state**, so a second call in `CodeEditor` would never hear `ThemeToggle`'s change (different `preference` ref, no storage event in the same tab). | A new `frontend/src/composables/useDarkClass.ts`: a `MutationObserver` on `document.documentElement`'s `class` attribute, reporting whether `dark` is set. | The `dark` class is already the single source of truth — `applyTheme()` writes it and the pre-paint script in `index.html` writes it before Vue exists — so reading it is reading the answer rather than recomputing it. The alternative, making `useTheme` a module singleton, changes a Slice 4 file whose spec deliberately builds a fresh instance per case and would need a test-only reset export. D17 is unaffected: the editor still follows the theme through the wrapper's `theme` prop. |
| **P3** | **How does the e2e read the editor's text?** `fill()`/`toHaveValue()` are gone (D24) and Monaco virtualises its lines, so DOM scraping is neither exact nor stable. | `monacoSetup.ts` assigns `window.monaco = monaco`, and `editorText()` evaluates `monaco.editor.getEditors()[0].getModel().getValue()`. Writing still goes through the real widget: focus, select-all, `keyboard.insertText`. | This is **parity, not a test hook**: the loader's CDN path sets `window.monaco` as a matter of course, and `init()` explicitly looks for it — the local path was the odd one out. It also gives `files.spec.ts` an *exact* read, so D24's "assertions unchanged" survives, where `.view-lines` innerText would have forced the trailing newline out of the fixture. `insertText` rather than `type()` because it inserts as one input event, so auto-closing brackets cannot rewrite what the test typed. |
| **P4** | **`setValue` vs `applyEdits` for the `replace` branch.** | **Neither branch calls `setValue`.** Both go through `model.applyEdits` — an append is a zero-width range at the end, a replace is `getFullModelRange()`. | AC-10's negative then becomes trivially provable: the fake model records **no `setValue` call at all**, ever, rather than "none for this file during this window". `applyEdits` also leaves the cursor and scroll alone where `setValue` resets both, and it bypasses `readOnly` — which is what a programmatic stream write into a locked editor needs. |

## File map

| File | New/Edit | What changes |
|---|---|---|
| `frontend/package.json` | Edit | `@guolao/vue-monaco-editor` `^1.6.0`, `monaco-editor` **`0.52.2`** (exact, no caret) |
| `frontend/package-lock.json` | Edit | the install |
| `frontend/src/env.d.ts` | Edit | ambient module for `monaco-editor/esm/vs/editor/edcore.main` (re-exporting `editor.api`); `Window.monaco` (P3) |
| `frontend/src/lib/deps.spec.ts` | **New** | AC-29: the two additions and the exact pin, read from `package.json` |
| `frontend/src/composables/useDarkClass.ts` | **New** | P2 — the `dark` class as a `Readonly<Ref<boolean>>` |
| `frontend/src/composables/useDarkClass.spec.ts` | **New** | L1 |
| `frontend/src/lib/editorLanguage.ts` | **New** | D25 — extension → monaco language id |
| `frontend/src/lib/editorLanguage.spec.ts` | **New** | AC-1 |
| `frontend/src/lib/editorContent.ts` | **New** | D8 — `editorEdit(current, next)` |
| `frontend/src/lib/editorContent.spec.ts` | **New** | AC-2–AC-5 |
| `frontend/src/lib/editorModels.ts` | **New** | D7 — project-scoped URIs, get-or-create, view state, disposal |
| `frontend/src/lib/editorModels.spec.ts` | **New** | AC-6–AC-9, against a fake monaco |
| `frontend/src/lib/monacoSetup.ts` | **New** | D2/D3/D5 — `edcore.main` + four contributions, the worker, `loader.config({ monaco })` |
| `frontend/src/lib/monacoSetup.spec.ts` | **New** | AC-25 |
| `frontend/src/lib/no-cdn.spec.ts` | **New** | AC-25 — source scan, shaped like `no-firestore.spec.ts` |
| `frontend/src/stores/workspace.ts` | Edit | `openTabs`, `buffers`, `dirtyPaths`, `closeTab`, `editContent`, `reloadFile`; per-tab save and per-tab refresh |
| `frontend/src/stores/workspace.spec.ts` | Edit | the file half rewritten around tabs; AC-13–AC-24 |
| `frontend/src/components/workspace/EditorTabs.vue` | **New** | D13 — the hand-rolled strip |
| `frontend/src/components/workspace/EditorTabs.spec.ts` | **New** | AC-13, AC-16 |
| `frontend/src/components/workspace/CodeEditor.vue` | **New** | the wrapper, the registry, the applier, `readOnly`, theme, load states |
| `frontend/src/components/workspace/CodeEditor.spec.ts` | **New** | AC-10–AC-12, AC-26–AC-28 |
| `frontend/src/components/workspace/FileEditor.vue` | Edit | textarea → `CodeEditor`; a read-failure **Try again** added; everything else kept |
| `frontend/src/components/workspace/FileEditor.spec.ts` | Edit | the store fake gains the tab fields; the textarea cases become `CodeEditor` prop cases |
| `frontend/src/components/workspace/EditorPanel.vue` | Edit | `<EditorTabs />` added; definite height down to the editor (D19) |
| `frontend/src/components/workspace/EditorPanel.spec.ts` | Edit | store fake updated; the cap-scrolls case kept verbatim |
| `frontend/src/views/WorkspaceView.spec.ts` | Edit | store fake updated; **`CodeEditor: true`** added to `MOUNT.global.stubs` |
| `frontend/src/components/workspace/FileTree.vue` | **Unchanged** | D10 is delivered by `selectFile`; see "AC coverage" |
| `tests/e2e/helpers.ts` | Edit | `setEditorContent()`, `editorText()`, `editorTokenClasses()` |
| `tests/e2e/files.spec.ts` | Edit | driven through those helpers; assertions unchanged (D24) |
| `tests/e2e/editor.spec.ts` | **New** | AC-30, AC-31 |
| `docs/IMPLEMENTATION_PLAN.md` | Edit | §0 status and the two inherited findings, §4 Slice 7, §9's F6.3 row |
| `docs/PRODUCT_SPEC.md` | Edit | §7.1's Monaco row → installed, with the pin and its reason |

**Untouched, and the review should check it against the diff (D21):** `firestore.rules`,
`firestore.indexes.json`, everything under `functions/`, `firebase.json`, `.env.example`,
`frontend/eslint.config.js`, `frontend/vite.config.ts`.

## Task list

Sixteen tasks. Ordered so nothing depends on a later one and every task leaves the suite green.

---

### T1 — the two dependencies, and making monaco typecheck → AC-29

- **Red:** `frontend/src/lib/deps.spec.ts` — *"declares the two Monaco packages and pins monaco
  exactly"*: read `frontend/package.json` with `readFileSync(join(process.cwd(), 'package.json'))`
  (`no-firestore.spec.ts`'s cwd rule — Vitest runs in `frontend/`), then assert
  `dependencies['@guolao/vue-monaco-editor']` is present, `dependencies['monaco-editor']` is
  exactly `'0.52.2'` and matches `/^\d+\.\d+\.\d+$/` (no `^`, no `~`), and that the full set of
  `dependencies` keys equals the expected literal array — the twelve already there plus these
  two — so a third addition has to be a deliberate edit to this test.
- **Green:** `npm --prefix frontend install @guolao/vue-monaco-editor@^1.6.0 monaco-editor@0.52.2
  --save-exact` for monaco only (install the wrapper with its caret separately). Then add to
  `frontend/src/env.d.ts`:

  ```ts
  // `edcore.main` is the editor with every contribution and no languages (D3). monaco
  // ships no .d.ts for it — only for editor.api, which it re-exports wholesale.
  declare module 'monaco-editor/esm/vs/editor/edcore.main' {
    export * from 'monaco-editor/esm/vs/editor/editor.api'
  }
  ```

  Prove the toolchain accepts the packages before anything is built on them:
  `npm --prefix frontend run typecheck && npm --prefix frontend run lint`. **R2's stop condition
  is here** — if `vue-demi` or the wrapper's `.d.ts` fails under TypeScript 6 / Vite 8 / Vue 3.5,
  stop and write it into this slice's docs rather than substituting the package.
- **Refactor:** none.

---

### T2 — `useDarkClass` (P2)

- **Red:** `frontend/src/composables/useDarkClass.spec.ts` — *"reports the class as it is, and
  follows it when it changes"*: with `dark` absent the ref is `false`; add the class to
  `document.documentElement`, await a microtask/`vi.waitFor`, and it is `true`; remove it and it
  is `false` again.
- **Green:** `useDarkClass(): Readonly<Ref<boolean>>` — a `ref` seeded from
  `document.documentElement.classList.contains('dark')`, a `MutationObserver` filtered to
  `attributeFilter: ['class']`, disconnected in `onScopeDispose` (`useTheme.ts`'s own cleanup
  pattern).
- **Refactor:** cross-reference `useTheme.ts`'s note that the class name is duplicated in
  `index.html`; this is now a third reader of it.

---

### T3 — the language map → AC-1

- **Red:** `frontend/src/lib/editorLanguage.spec.ts` — *"maps every extension the server allows,
  and everything else to plaintext"*: `index.html → html`, `styles.css → css`, `app.js →
  javascript`, `notes.md → markdown`, `data.json → plaintext` (D4), `weird.txt → plaintext`,
  `noextension → plaintext`. Second case, *"covers the whole allowlist"*: for each of
  `['css', 'html', 'js', 'json', 'md']` — restated as a literal here, `filesApi.spec.ts`'s
  `expect(FILE_BYTES_MAX).toBe(100_000)` precedent, with a comment naming
  `functions/src/files/schema.ts`'s `FILE_EXTENSIONS` — `editorLanguage('file.' + ext)` is a
  member of the map's values and never falls through to the default *by accident*: assert the map
  has an own key for each.
- **Green:** `EDITOR_LANGUAGES` as an `as const satisfies Record<string, string>` object,
  `PLAINTEXT = 'plaintext'`, and `editorLanguage(path: string): string` taking the substring after
  the last `.`. Bracket reads only, `noPropertyAccessFromIndexSignature`; `?? PLAINTEXT` for the
  miss, which `noUncheckedIndexedAccess` requires anyway.
- **Refactor:** none.

---

### T4 — the content applier → AC-2, AC-3, AC-4, AC-5

- **Red:** `frontend/src/lib/editorContent.spec.ts` — four cases plus the round trip.
  Equal → `null`. `next` starts with `current` and is longer → `{ kind: 'append', text }` where
  `text` is exactly `next.slice(current.length)` (**and is asserted to be shorter than `next`**,
  which is the assertion that fails if someone "simplifies" it to always replace). Not a prefix →
  `{ kind: 'replace', text: next }`, over three shapes: a different file, a server repair that
  changed earlier bytes, and a shorter string. Round trip: over a fixture corpus of pairs,
  applying the edit to `current` yields exactly `next` — with a local `apply()` in the spec that
  models what monaco does (`append` concatenates, `replace` substitutes wholesale).
- **Green:** a discriminated union `EditorEdit = { kind: 'append'; text: string } | { kind:
  'replace'; text: string }` and `editorEdit(current: string, next: string): EditorEdit | null`.
- **Refactor:** the doc comment carries R1 — why an append and not a `setValue`, in one paragraph,
  because this module is the whole of that decision.

---

### T5 — the model registry → AC-6, AC-7, AC-8, AC-9

- **Red:** `frontend/src/lib/editorModels.spec.ts`, against a hand-written fake monaco
  (`Uri.parse` returning `{ toString: () => raw }`, `editor.createModel` returning a fake
  `ITextModel` that records `dispose`/`isDisposed`, `editor.getModel` reading a Map) and a fake
  editor host recording `setModel`/`saveViewState`/`restoreViewState` in order:
  - *"scopes the model URI to the project"* — `modelUriString('proj-1', 'index.html')` is
    `inmemory://genesis/proj-1/index.html`; two registries for `proj-1` and `proj-2` opening
    `index.html` produce different URIs and two distinct model objects (AC-6).
  - *"returns the same model for a path it already has"* — two `model()` calls, one
    `createModel` (AC-7).
  - *"saves A's view state before the switch and restores B's after it"* — call order is
    `saveViewState → setModel → restoreViewState`, the state saved is filed under A, and a path
    never opened before gets **no** `restoreViewState` call (AC-8).
  - *"disposes everything it made and empties itself"* — `disposeAll(host)` calls
    `host.setModel(null)` **first**, then disposes every model; `paths()` is empty; a later
    `model()` creates a fresh one (AC-9).
- **Green:** `frontend/src/lib/editorModels.ts`:

  ```ts
  import type { editor, Uri } from 'monaco-editor'   // type-only: erased at runtime

  export interface MonacoModelApi {
    Uri: { parse: (raw: string) => Uri }
    editor: {
      createModel: (value: string, language?: string, uri?: Uri) => editor.ITextModel
      getModel: (uri: Uri) => editor.ITextModel | null
    }
  }

  /** What the registry needs of the editor. `IStandaloneCodeEditor` satisfies it. */
  export interface EditorHost {
    setModel: (model: editor.ITextModel | null) => void
    saveViewState: () => editor.ICodeEditorViewState | null
    restoreViewState: (state: editor.ICodeEditorViewState | null) => void
  }

  export function modelUriString(projectId: string, path: string): string
  export function createModelRegistry(monaco: MonacoModelApi, projectId: string): ModelRegistry
  ```

  `ModelRegistry` exposes `model(path, value, language)`, `activate(host, path, value, language)`,
  `disposeAll(host: EditorHost | null)` and `paths()`. `activate` keeps the previously active path
  in the closure, which is what lets the view state be filed under the right key. `model()`
  consults our own `Map` **and** `monaco.editor.getModel(uri)` before creating, because
  `createModel` throws `ERR_MODEL_ALREADY_EXISTS` on a duplicate URI.
- **Refactor:** the doc comment records R5 and the wrapper's global-registry behaviour, so the
  next reader knows why the `path` prop is unbound.

---

### T6 — local monaco, no CDN → AC-25

- **Red, two files.**
  `frontend/src/lib/monacoSetup.spec.ts` — *"hands the loader the locally imported instance"*:
  `vi.mock` the five monaco specifiers (`edcore.main`, the four `*.contribution`s), the
  `?worker` import, and `@guolao/vue-monaco-editor` (for its re-exported `loader`); import the
  module and assert `loader.config` was called exactly once with `{ monaco }` **identical** to the
  mocked namespace object, and that `self.MonacoEnvironment?.getWorker` is a function returning a
  worker. If Vitest declines to mock the `?worker` specifier, the fallback is the Vite-native
  `new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type:
  'module' })` inside `getWorker`, and the case narrows to asserting `getWorker` is a function —
  record whichever was used in the file's comment.
  `frontend/src/lib/no-cdn.spec.ts` — a source scan in `no-firestore.spec.ts`'s exact shape:
  needles built by concatenation, a self-skip, a `describe('the scan itself')` with `FORMS`
  (a `paths.vs` config, a script `src`, a bare URL in a string) and `INNOCENT` (the host named in
  prose, `@monaco-editor/loader` as an import), then *"no CDN host appears under `frontend/src`"*
  over `cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`.
- **Green:** `frontend/src/lib/monacoSetup.ts`:

  ```ts
  import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main'
  import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
  import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
  import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
  import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
  import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
  import { loader } from '@guolao/vue-monaco-editor'

  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
  loader.config({ monaco })
  window.monaco = monaco          // parity with the loader's CDN path (P3)

  export { monaco }
  ```

  No language services are imported — that is D3's refusal, and it is what keeps red squiggles off
  LLM-generated code. Nothing here is imported statically by any other module: `CodeEditor.vue`
  reaches it through `await import('@/lib/monacoSetup')` (D20), which is what puts monaco in its
  own chunk.
- **Refactor:** the doc comment states, in one line each, why `edcore.main` and not `editor.main`,
  why four contributions and no services, and why one worker (D5's bare
  *"You must define a function MonacoEnvironment.getWorker"* at a keystroke).

---

### T7 — the store: tabs and per-path buffers → AC-13, AC-14, AC-15, AC-16, AC-17

The largest task. `workspace.spec.ts`'s `describe('selectFile')` block is rewritten around tabs.

- **Red:** in `frontend/src/stores/workspace.spec.ts`:
  - *"opens a tab, fetches it, and makes it active"* — `openTabs` is `['index.html']`,
    `selectedPath` is `'index.html'`, the buffer holds the fetched content clean, one
    `GET /api/projects/proj-1/files/index.html` (AC-13).
  - *"keeps a failed read's tab and re-reads it on demand"* — the read rejects: the tab stays,
    `fileError` is set, `editorContent` is `''`; `reloadFile()` issues exactly one more `GET` and
    fills the buffer; a second open tab's buffer is untouched throughout (AC-13).
  - *"activates an open tab without a second tab and without a request"* — `selectFile` twice:
    `openTabs` has length 1 and `requests()` after the clear is `[]` (AC-14).
  - *"keeps an unsaved edit across a tab switch, with no request"* — open two, `editContent('my
    edit')` on the first, switch, switch back: content and `fileDirty` survive and `requests()` is
    `[]` (AC-15).
  - *"closes the middle tab onto its left neighbour"*, *"closes the leftmost onto its right"*,
    *"leaves no active tab when the last one closes"* — three cases (AC-16).
  - *"restores a dirty buffer when a closed tab is reopened, with no request"* (AC-17).
  - *"drops every tab and buffer when another project is opened"* and the same for `reset()`.
- **Green:** in `frontend/src/stores/workspace.ts`:

  ```ts
  export interface FileBuffer {
    content: string
    /** What the server last said. `dirty` is the two disagreeing. */
    saved: string
    loading: boolean
    error: string | null
    /** D15/D16 — a generation replaced this buffer, until the next edit or close. */
    replaced: boolean
  }
  ```

  New state: `openTabs: Ref<string[]>`, `buffers: Ref<Record<string, FileBuffer>>`. `selectedPath`
  keeps its name and now means the active tab (D14). `fileContent` and `savedContent` are removed
  from the store's surface.

  New computed passthroughs over the active buffer, all keeping their Slice 6 names so
  `FileEditor.vue` barely moves: `editorContent` (still `streamingFiles[path] ?? buffer.content`),
  `fileDirty`, `fileLoading`, `fileError`, `fileReplaced`, plus `dirtyPaths` for the strip.

  New actions: `closeTab(path)` — splice, activate the left neighbour else the right else `null`,
  keep the buffer but clear its `replaced` (D12, D16); `editContent(text)` — write the active
  buffer's `content` and clear its `replaced` (D16); `reloadFile()` — re-read the active tab.
  `selectFile(path)` becomes: push the tab if absent, make it active, and fetch **only if
  `buffers[path]` is undefined**. `clearFileState()` empties `openTabs` and `buffers`.

  Every write after an `await` keeps its `current(gen)` guard, and every buffer write goes through
  a small `withBuffer(path, fn)` helper so a buffer deleted mid-flight cannot be resurrected by a
  late response.
- **Refactor:** the interface doc gains one paragraph on why the buffer survives a tab close
  (D12: it is what removes the confirm dialog from the slice).

---

### T8 — the store: save, scoped to the active tab → AC-19, AC-20, AC-21

- **Red:** rewrite `describe('saveFile')`:
  - *"PUTs the active buffer and takes the server's answer back into that tab only"* — two tabs
    open, the inactive one dirty; save the active one; its buffer is the server's content and
    clean, the other tab's buffer is byte-identical to before, and the list entry's `size` and
    `updatedAt` are refreshed (AC-19).
  - *"keeps the buffer dirty and records the error when the save fails"* (AC-19).
  - *"issues no request while a stream is open"* (AC-20).
  - *"issues no request with no active tab"*, *"issues no second request while one is in flight"* —
    both kept from Slice 6.
  - AC-21's cap is the component's (T12), but the store keeps the `saving`/`generating` guard here.
- **Green:** `saveFile()` reads `selectedPath` and `buffers[path]`, returning early if either is
  missing. `saving` and `saveError` stay top-level refs — single-flight, and the PRD's data-model
  table deliberately leaves them out of the buffer.
- **Refactor:** none.

---

### T9 — the store: what a generation does to the tabs → AC-18, AC-22, AC-23, AC-24

- **Red:** rewrite the tab-facing half of `describe('the stream — files')`:
  - *"opens a tab for the first streamed file only into an empty strip"* and *"leaves the active
    tab alone for the whole generation"* (AC-18).
  - *"re-reads every open tab the generation rewrote"* — two tabs open on rewritten files, one
    clean and one dirty: two `GET`s after the list refetch, the clean one replaced silently, the
    dirty one replaced with `replaced` true; then `editContent` on the dirty one clears its notice
    and **not** the other's (AC-22).
  - *"drops a buffered but closed file the generation rewrote"* — its entry is gone and reopening
    issues a fresh `GET` (AC-23).
  - *"issues no file request and changes no buffer on a done that wrote nothing"* — `requests()` is
    `['POST /generate']` and `buffers` is deep-equal to what it was (AC-24).
  - *"closes a tab the generation opened for a file that was never stored"* — the P1 case, in both
    Slice 6 shapes: a path that streamed and was refused, and a path the project already holds that
    the turn did not write. `openTabs` is empty, `selectedPath` is null, `requests()` is `[]`.
  - *"keeps a tab the user opened through a turn that wrote nothing"* — kept from Slice 6.
- **Green:** `file_start` calls an internal `openTab(path)` that **creates no buffer** and records
  `autoSelected` when the strip was empty. `applyGenerationFiles(written, gen)` becomes: refetch
  the list if `written` is non-empty; for each open tab in `written`, re-read it (creating the
  buffer if the generation opened that tab), setting `replaced` from whether it was dirty; delete
  the buffer of every **closed** path in `written`; finally, if `autoSelected` is set and is not in
  `written`, drop that tab and its buffer entirely.
- **Refactor:** `reReadSelected` becomes `reReadInto(path, id, gen)`, since it now runs per tab.

---

### T10 — the tab strip → AC-13, AC-16

- **Red:** `frontend/src/components/workspace/EditorTabs.spec.ts`, against a `reactive` store fake
  (`FileTree.spec.ts`'s pattern):
  - *"renders one tab per open path, in order, marking the active one"* — `role="tablist"`, one
    `role="tab"` each, `aria-selected` true on exactly one.
  - *"marks the dirty tabs and no others"* — from `dirtyPaths`.
  - *"activates a tab when it is clicked"* — calls `selectFile(path)`.
  - *"closes a tab from its own control"* — a sibling `<button aria-label="Close styles.css">`
    calls `closeTab(path)` and **not** `selectFile` (AC-16).
  - *"renders nothing with no tab open"*.
- **Green:** `EditorTabs.vue` — `<div role="tablist" data-testid="editor-tabs" class="flex
  shrink-0 gap-1 overflow-x-auto border-b border-border px-2">`, each tab a
  `<button role="tab" data-testid="editor-tab" :data-path :data-active :data-dirty>` with a
  **sibling** close `<button data-testid="editor-tab-close">` — siblings, not nested, because a
  button inside a button is invalid HTML and unreachable by keyboard (D13).
- **Refactor:** none.

---

### T11 — the editor → AC-10, AC-11, AC-12, AC-26, AC-27, AC-28

- **Red:** `frontend/src/components/workspace/CodeEditor.spec.ts`. `@guolao/vue-monaco-editor` is
  mocked with a stub component that declares the same props and emits, and
  `@/lib/monacoSetup` is mocked with a fake monaco (`Uri.parse`, `editor.createModel`,
  `editor.setTheme`) — D23: Monaco itself never runs below L5.
  - *"renders the skeleton until the editor mounts"*, *"renders the failure and a Try again that
    retries the load"* (the mocked `monacoSetup` rejects once then resolves), *"renders neither
    once mounted"* (AC-26).
  - *"holds the editor instance identically"* — the stub emits `mount` with a sentinel object; the
    component's stored value is `===` that object, which no `ref`/`reactive` proxy is (AC-28).
  - *"passes readOnly while generating, with a message, and automaticLayout always"* — the
    `options` prop; flip `generating` and it goes false (AC-11).
  - *"passes vs-dark for the dark theme and vs for light, without remounting"* — toggle the `dark`
    class on `document.documentElement`; the stub's `theme` prop changes and the stub's instance
    is the same node (AC-27).
  - *"appends the tail of a streamed chunk and follows it, and never calls setValue"* — drive the
    store fake's `editorContent`; the fake model records one `applyEdits` whose text is the
    suffix, `revealLine` is called with the last line, and `setValue` was never called on
    anything (AC-10, P4).
  - *"leaves the active model alone when the stream writes another path"* (AC-12).
- **Green:** `CodeEditor.vue`. The shape, in full, because this is the component the whole slice
  turns on:

  - **Load.** `const status = ref<'loading' | 'failed' | 'ready'>('loading')`; `load()` does
    `await import('@/lib/monacoSetup')`, stores the namespace in a **`shallowRef`**, sets
    `'ready'`, and on rejection sets `'failed'`. `onMounted(load)`; **Try again** calls `load()`
    again. (A failed dynamic import is re-fetched by the browser on a later `import()`; the L2
    proves the retry path against the mock either way.)
  - **The instance.** `const editor = shallowRef<IStandaloneCodeEditor | null>(null)`, assigned
    from `@mount`'s first payload argument. Never `ref`, never `reactive` — D6, and AC-28 is the
    assertion rather than a comment.
  - **Models.** On `mount`: create the registry with the resolved monaco and
    `workspace.projectId`; capture `editor.getModel()` — the anonymous model the wrapper creates
    because `path` is unbound — `registry.activate(...)` onto ours, then dispose that anonymous
    one. `watch(() => workspace.projectId)` disposes the whole registry and rebuilds it.
  - **Unmount.** `onBeforeUnmount`: `registry.disposeAll(editor.value)`, which sets the editor's
    model to `null` first. This is load-bearing — the wrapper's own `onUnmounted` disposes
    `editorRef.value.getModel()`, and the `lg` breakpoint unmounts this component on a window
    resize, so without the detach the registry would hand out a disposed model afterwards.
  - **Switching.** `watch(() => workspace.selectedPath)` → `registry.activate(host, path,
    workspace.editorContent, editorLanguage(path))`; `null` → `editor.setModel(null)`.
  - **Streaming.** `watch(() => workspace.editorContent)` → `editorEdit(model.getValue(), next)`;
    `append` → `model.applyEdits([{ range: <zero-width at the end>, text }])` and
    `editor.revealLine(model.getLineCount())`; `replace` → `applyEdits` over
    `model.getFullModelRange()`; `null` → nothing. Wrapped in `applying = true` / `false` — a
    plain closure boolean, because the wrapper re-emits `update:value` on **every** content change
    including ours (its handler compares against `props.value`, which is `undefined` and so never
    equal), and feeding that back into the store would mark every streamed file dirty.
  - **Typing.** `@update:value` → `if (!applying) workspace.editContent(String(value))`. The
    round trip terminates by itself: the store write makes `editorContent` equal to the model, so
    the watcher's `editorEdit` returns `null`.
  - **Options.** A `computed` returning a fresh object — the wrapper's `options` watcher is
    `deep: true` and calls `updateOptions`: `automaticLayout: true`, `minimap: { enabled: false }`,
    `scrollBeyondLastLine: false`, `tabSize: 2`, `wordWrap: 'on'`, `fontFamily: 'var(--font-mono)'`,
    `readOnly: workspace.generating`, and `readOnlyMessage: { value: 'Read-only while a reply is
    generating.' }` **always set** — `exactOptionalPropertyTypes` makes a conditional `undefined`
    an error, and a message on an editable editor is inert.
  - **Theme.** `:theme="useDarkClass() ? 'vs-dark' : 'vs'"` (T2). The wrapper watches it and calls
    `monaco.editor.setTheme` — no remount, no buffer change (D17, AC-27).
  - **Markup.** Root `<div data-testid="code-editor" class="relative h-full min-h-0 w-full">`;
    `<VueMonacoEditor v-if="status === 'ready'" width="100%" height="100%">`; the skeleton
    (`data-testid="code-editor-loading"`) while `status === 'loading' || editor === null`,
    absolutely positioned over the editor area so `mount` can fire underneath it; the failure
    (`code-editor-failed`, `code-editor-retry`) when `status === 'failed'`.
- **Refactor:** the file header carries D6, D8 and the wrapper-unmount trap, since those are the
  three things a reader cannot infer from the code.

---

### T12 — `FileEditor.vue` around the new editor → AC-19, AC-21, AC-22, AC-13

- **Red:** `FileEditor.spec.ts`, updated. The store fake gains `openTabs`, `editContent`,
  `reloadFile`, `closeTab`, `dirtyPaths`; `CodeEditor` is stubbed. Cases kept as-is: the empty
  state, the byte count in bytes, Save disabled clean / enabled dirty / withheld over the cap with
  the reason on screen (AC-21), the save error beside Save (AC-19), the replaced notice and its
  absence (AC-22), the read failure instead of the editor. Two change: *"puts the file's content
  in the textarea"* and *"shows the streaming buffer rather than the stored one"* become
  assertions that `CodeEditor` is rendered and that `editorContent` is what the panel is showing.
  One is new: *"offers a Try again on a failed read"* → calls `reloadFile()` (AC-13).
- **Green:** swap `<Textarea>` for `<CodeEditor class="h-full" />` inside the
  `min-h-0 flex-1` region; add the `file-editor-retry` button to the read-error branch. The byte
  count, `canSave`, `save()`, the read-only sentence and the save-error alert are untouched — D26's
  claim that Slice 6 put the rules in the right place is exactly what this task tests.
- **Refactor:** the file header's "a textarea in this slice, Monaco in Slice 7" becomes the record
  of what the swap actually cost, and it should be able to say "the widget, and nothing else".

---

### T13 — panel geometry and the strip → AC-30's structural half

- **Red:** `EditorPanel.spec.ts` — the existing *"scrolls the tree at the height it caps it to"*
  case is kept **verbatim**, and two are added: *"renders the tab strip between the tree and the
  editor"*, and *"gives the editor region a definite height"* — the element wrapping `FileEditor`
  carries both `min-h-0` and `flex-1`, and no ancestor inside the panel is `h-auto`. jsdom cannot
  see a collapsed box (R4), so this pins the classes; AC-30 measures the real one at L5.
- **Green:** `EditorPanel.vue` gains `<EditorTabs />` after the tree's `Separator`, and
  `min-h-0 flex-1` all the way down to `CodeEditor`'s `height: 100%`. Also in this commit:
  `WorkspaceView.spec.ts`'s store fake gains the tab fields and `CodeEditor: true` joins
  `MOUNT.global.stubs` — without it that suite mounts the real wrapper, whose `onMounted` calls
  `loader.init()` and, unconfigured, appends a CDN `<script>` in jsdom.
- **Refactor:** none.

---

### T14 — the e2e helpers, and `files.spec.ts` through Monaco (D24)

Same commit as the swap reaching L5, per D24 — a broken e2e that gets skipped is worse than none.

- **Red:** the existing `tests/e2e/files.spec.ts` is red the moment T12 lands, because `fill()`
  and `toHaveValue()` have no textarea. That is this task's red.
- **Green:** in `tests/e2e/helpers.ts`:
  - `setEditorContent(page, text)` — click `.monaco-editor textarea.inputarea`, press
    `ControlOrMeta+a`, press `Delete`, then `page.keyboard.insertText(text)`. `insertText` rather
    than `type()`: one input event, so auto-closing brackets cannot rewrite the fixture.
  - `editorText(page)` — `page.evaluate(() => window.monaco.editor.getEditors()[0]
    ?.getModel()?.getValue() ?? null)` (P3).
  - `editorTokenClasses(page)` — the distinct `mtk*` class names inside `.view-lines`, for AC-31.

  `files.spec.ts` then reads: `await expect(page.getByTestId('code-editor')).toBeVisible()`,
  `expect(await editorText(page)).not.toBe('')`, `await setEditorContent(page, edited)`, and the
  post-reload `expect(await editorText(page)).toBe(edited)`. **Its assertions do not change** —
  same claims, same `edited` string, trailing newline included, read exactly rather than scraped.
  The "editable again" check becomes the absence of `file-editor-readonly` plus a successful
  `setEditorContent`.
- **Refactor:** none.

---

### T15 — this slice's L5 → AC-30, AC-31

- **Red/Green together:** `tests/e2e/editor.spec.ts` — one test, the PRD's demo line, plus one
  geometry case. Sign up, open a project, send `__slow build a contact dashboard`; while
  `chat-generating` is visible, assert `editorTokenClasses(page)` has **more than one** distinct
  class (that is colouring, not grey text), that `file-editor-readonly` is visible, and that
  `setEditorContent` cannot change `editorText` (AC-31's read-only half). After the stream:
  `file-editor-readonly` is hidden; click `styles.css` in the tree → two `editor-tab`s; type into
  it; switch to the `index.html` tab and back → the edit is still there and the tab is still marked
  dirty; **Save**, waiting on the `PUT` response as `files.spec.ts` does; reload → no tab open,
  reopen `styles.css`, the saved content is back. The geometry case asserts
  `getByTestId('code-editor').boundingBox()` has a height over 100 px and that `.view-line` count
  is non-zero (AC-30), then sets the viewport to 390 px wide, opens the **Code** tab, and asserts
  the same two things in the narrow layout.
- **Refactor:** none. Two specs, not one (D24): `files.spec.ts` stays the signal for "file
  operations broke" and this one for "the editor broke".

---

### T16 — the documents

No failing test is possible here and none is pretended: this is prose.

- `docs/IMPLEMENTATION_PLAN.md` — §0's counts and status line, both inherited findings marked
  resolved (the scroll cap, and D22's `useProjectFiles` call recorded as deferred to Slice 12);
  §4's Slice 7 entry marked shipped; §9's F6.3 row.
- `docs/PRODUCT_SPEC.md` — §7.1's Monaco row: installed, `monaco-editor` pinned `0.52.2`, with
  D1's one-line reason.

---

## Firestore rules changes

**None.** No collection, no field, no index, no rule. The whole slice is `frontend/` plus three
files under `tests/e2e/` plus two documents (D21), and the review is expected to check that
against the diff rather than against this sentence. The existing L3 suite — which already proves
`users/{uid}/projects/{projectId}/files` is denied to every client — is unchanged and still runs.

## Dependencies

| Package | Version | Why |
|---|---|---|
| `@guolao/vue-monaco-editor` | `^1.6.0` | The exact package `PRODUCT_SPEC.md` §7.1 names, and the one thing the brief is specific about. Brings `@monaco-editor/loader` and `vue-demi` transitively. |
| `monaco-editor` | `0.52.2`, **exact** | The wrapper's peer, pinned rather than caretted: 0.55 added an `exports` map and 0.56 restructured the ESM tree, and the deep path the wrapper's own `.d.ts` imports — `monaco-editor/esm/vs/editor/editor.api` — stops resolving, which is a `typecheck` failure inside a package the brief requires. Verified: 0.52.2's `package.json` has no `exports` key. |

Nothing is added to `functions/`, nothing to the root, no dev dependency.

## Manual verification

On the emulators, from a clean checkout:

1. `npm run install:all` (once), then **unplug the network** and `npm run dev`. The editor must
   load, colour and stream with no internet — this is D2's whole point, and the failure mode it
   guards against only shows up here.
2. Sign in, open a project, send `__slow build a contact dashboard`. Watch **coloured** HTML
   append into the editor line by line with the view following the last line; the editor is
   locked and says so; the tree fills in.
3. When the stream ends the editor is editable. Click `styles.css` — a second tab. Type; the tab
   shows the dirty mark, the byte count moves, **Save** enables.
4. Click the `index.html` tab, then back. The unsaved line is there; the Network tab shows **no**
   request for either switch.
5. **Save**, then reload. No tab is open; clicking `styles.css` shows the saved content.
6. Close the `index.html` tab — the strip drops it and `styles.css` stays active.
7. Drag the splitter and toggle the theme. The text reflows; the editor changes ground without
   losing the buffer.
8. Bundle check: `npm --prefix frontend run build`, then confirm monaco is in its own chunk and
   not in the entry chunk, and
   `grep -rlE 'jsdelivr|unpkg|cdnjs' frontend/dist` returns nothing.
9. In DevTools, throttle to offline and hard-reload the workspace to see `CodeEditor`'s failure
   state and its **Try again**.

## AC coverage

Every acceptance criterion maps to at least one task.

| AC | Task(s) |
|---|---|
| AC-1 | T3 |
| AC-2, AC-3, AC-4, AC-5 | T4 |
| AC-6, AC-7, AC-8, AC-9 | T5 |
| AC-10, AC-11, AC-12 | T11 |
| AC-13 | T7 (store), T10 (strip), T12 (the retry), plus `FileTree.spec.ts`'s existing row-click case |
| AC-14, AC-15, AC-16, AC-17 | T7; AC-16's strip half also T10 |
| AC-18, AC-22, AC-23, AC-24 | T9; AC-22's notice rendering also T12 |
| AC-19, AC-20, AC-21 | T8 (store), T12 (the rendering) |
| AC-25 | T6 |
| AC-26, AC-27, AC-28 | T11 |
| AC-29 | T1 |
| AC-30 | T13 (the classes), T15 (the measurement) |
| AC-31 | T15 |

**`FileTree.vue` gets no task, and that is not a gap.** The PRD's in-scope list says "a click opens
a tab (D10); nothing else" — and a click already calls `workspace.selectFile(path)`, which is the
action T7 teaches to open a tab. The component's diff is empty, and its existing L2 case
(*"selects a file when its row is clicked"*) is AC-13's tree half unchanged.

## Estimate

| Task | Estimate |
|---|---|
| T1 dependencies + monaco typing | 0.5 h |
| T2 `useDarkClass` | 0.3 h |
| T3 language map | 0.3 h |
| T4 content applier | 0.4 h |
| T5 model registry | 0.9 h |
| T6 `monacoSetup` + no-CDN scan | 0.6 h |
| **T7 store: tabs and buffers** | **1.5 h** ⚠ |
| T8 store: save per tab | 0.5 h |
| **T9 store: generation → tabs** | **1.2 h** ⚠ |
| T10 `EditorTabs.vue` | 0.5 h |
| **T11 `CodeEditor.vue`** | **1.5 h** ⚠ |
| T12 `FileEditor.vue` | 0.7 h |
| T13 panel geometry | 0.4 h |
| **T14 e2e helpers + `files.spec.ts`** | **1.0 h** ⚠ |
| T15 `editor.spec.ts` | 1.0 h ⚠ |
| T16 documents | 0.3 h |
| **Total** | **≈ 11.6 h** |

Five tasks are flagged. T7, T9 and T11 are flagged for their own size; T14 and T15 are flagged
because e2e work is where an hour becomes three — every iteration costs a full emulator boot, and
this is the first time this suite has driven a canvas-rendered widget.

**Against `IMPLEMENTATION_PLAN.md` §5, this exceeds Slice 7's Day 3 allocation**, and Slice 7 is
first on the cut list. R7's cut is pre-decided and the build should honour it: **if the suite is
not green by the end of day 3, revert `frontend/package.json`, `CodeEditor.vue` and
`FileEditor.vue` to the textarea and move to Slice 8.** That revert is one commit precisely
because D26 kept every save rule in the store and D21 means nothing on the server depends on this
slice — the tab work in T7–T10 can stay, since it is a strict improvement over one buffer either
way.

## Notes for the reviewer

- **A bare `import … from 'monaco-editor'` as a *value* would silently pull all ~90 languages**
  into whatever chunk imports it, because the package's `module` field is `editor.main.js`.
  `editorModels.ts` uses `import type`, which is erased under `verbatimModuleSyntax`;
  `monacoSetup.ts` is the only module that imports monaco for its value, and it names
  `edcore.main` explicitly. Worth a look in the diff — no lint rule guards it.
- **`window.monaco` is deliberate** (P3), not a leftover debug line.
- **`applying` in `CodeEditor.vue` is load-bearing** (T11), not defensive: without it the wrapper
  echoes our own streaming appends back and every generated file arrives dirty.
