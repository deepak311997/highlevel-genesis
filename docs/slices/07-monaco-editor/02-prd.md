# Slice 07 — Monaco editor · PRD

**Spec:** F6.3, F6.5 (the "accumulates tokens into the editor" half) ·
**Branch:** `slice/07-monaco-editor` · **Depends on:** 6 · **Date:** 2026-08-18

## Problem

The code panel is a textarea. F6.3 names four things by name — Monaco via
`@guolao/vue-monaco-editor`, a clickable file tree, **tabbed editing**, tokens appearing live
during generation — and today we have one of them. Generated HTML arrives as undifferentiated
grey text; only one file can be open at a time, and clicking a second file **throws away
unsaved edits to the first** with no warning, because there is exactly one buffer.

This slice swaps the widget and pays for what the swap implies: one editor instance driving
per-file text models, a tab strip over them, streamed file chunks applied as **append edits**
so the view follows the code as it is written, and the read-only window Slice 6 already
established restated as Monaco's own `readOnly`. Nothing on the server changes.

## The demo

Send a prompt, watch syntax-coloured HTML stream into a locked Monaco editor line by line;
when it finishes, open a second file in a second tab, type into it, switch tabs and back to
find the edit still there, save it, and reload.

## Decisions

No interview was run: this slice ships under the unattended loop, so every question below was
answered from `PRODUCT_SPEC.md` §4 (F5.1, F6.1, F6.3, F6.5) and §7.1, `IMPLEMENTATION_PLAN.md`
§0 (the two findings Slice 7 inherits), §4 (Slices 6, 7, 10, 11), §5's cut order and §9,
`CLAUDE.md`'s non-negotiables and its named Monaco trap,
`.claude/skills/feature-review/references/typescript-vue.md`, the merged code of Slices 0–6, and
the published contents of `monaco-editor` and `@guolao/vue-monaco-editor` — several decisions
below turn on what is actually in those tarballs rather than on what their documentation says.

`IMPLEMENTATION_PLAN.md` §0 asks this slice to settle one carried-over question — whether the
file half of `stores/workspace.ts` becomes a `useProjectFiles` composable. It is settled in D22,
and the answer is "not here", with the reason.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | **Which packages, at which versions?** | **`@guolao/vue-monaco-editor` ^1.6.0** — the exact package the brief names — with **`monaco-editor` pinned to `0.52.2`**, not the current `0.56.0`. | The wrapper is non-negotiable (`PRODUCT_SPEC.md` §7.1 says "use the exact package, not `monaco-editor-vue3`"). The monaco pin is measured, not conservative-by-habit: 0.55 added an `exports` map and 0.56 restructured the tree (`esm/vs/languages/definitions/*` replacing `esm/vs/basic-languages/*`, and `"./*": "./esm/vs/*.js"`), which means the deep path **the wrapper's own `.d.ts` imports** — `monaco-editor/esm/vs/editor/editor.api` — no longer resolves. Under this project's `strict` typecheck that is a build failure in the mandated package, caused by a peer we chose. 0.52.2 has no `exports` map, the classic layout, and satisfies the wrapper's `>=0.43.0` peer. Rejected: latest monaco (breaks typecheck against the brief's own package); rejected: hand-rolling a wrapper over `monaco-editor` (substitutes a named package for no gain). |
| D2 | **Where does Monaco come from at runtime?** | **Bundled locally.** The app hands the imported instance to the loader (`app.use(VueMonacoEditorPlugin, { monaco })` → `loader.config({ monaco })`), so `loader.init()` resolves from our own bundle and no network request is made. | The package's default is `@monaco-editor/loader` fetching monaco from a CDN over AMD. That would make `npm run dev` on the emulators require the internet from a fresh clone — which the brief names explicitly as a deliverable — put a third party in the e2e suite's critical path, and force a CSP allowlist entry in Slice 13. Verified in the loader's source: `config({ monaco })` short-circuits `init()` to the passed instance. Rejected: the CDN default; rejected: self-hosting the AMD build under `public/` (a second copy of monaco, versioned by hand). |
| D3 | **How much of Monaco?** | **`monaco-editor/esm/vs/editor/edcore.main`** — the complete editor with every contribution (find, bracket matching, folding, multi-cursor, the context menu) and **no languages** — plus exactly four `basic-languages` contributions: `html`, `css`, `javascript`, `markdown`. **No language services** (`vs/language/{css,html,json,typescript}`). | `editor.api` alone is the bare API with no contributions and gives a crippled editor; the package default `editor.main` drags in all ~90 languages *and* the four language-service workers. The services are the part we actively do not want: they put **red squiggles on LLM-generated code**, and a reviewer watching the demo reads that as "Genesis generates broken code" when it is usually a missing tsconfig or an unresolvable relative `<script src>`. Colouring is what F6.3 asks for; diagnostics are not. |
| D4 | **Then what colours a `.json` file?** | **Nothing — it renders as `plaintext`.** | Measured: monaco ships no `basic-languages/json`; JSON's tokenizer lives only inside the worker-backed language service, so colouring it costs the whole json worker and its diagnostics. `.json` is an allowlisted extension (Slice 6, D12) but not one a generated CRM mini-app leans on — the app is `index.html` + `styles.css` + `app.js`. Recorded as a cost rather than discovered later; revisit in Slice 9 if real generations produce JSON that matters. |
| D5 | **Web workers — none, or one?** | **One: monaco's generic `editor.worker`,** wired through Vite's `?worker` import and `self.MonacoEnvironment.getWorker`. | The standalone editor reaches for that worker on its own (word-based suggestions, link detection, and anything that diffs a model), and when `MonacoEnvironment` is unset it throws a bare *"You must define a function MonacoEnvironment.getWorker"* the first time it does — at a keystroke, not at mount, so it would survive a smoke test. One worker is a few kilobytes and removes the whole class of failure; disabling the features by option instead means hoping nothing else ever asks. |
| D6 | **How is the editor instance held?** | A **`shallowRef`** assigned from the component's `@mount` payload, and plain closure variables for everything else Monaco hands us. Never `ref`, never `reactive`. | `CLAUDE.md` and the review reference both name this trap: `ref()` over the editor makes Vue walk a very large third-party object graph on every property access. Asserted rather than commented — AC-28 emits `mount` with a sentinel object and requires the stored value to be **identical** to it, which a deep reactive proxy is not. |
| D7 | **Who owns the text models — the wrapper, or us?** | **We do.** The wrapper's `path` and `value` props are left unbound; models are created and switched by our own registry, keyed `inmemory://genesis/<projectId>/<path>`, and disposed when the project closes. | Read from the wrapper's source, not assumed: it keys models by `monaco.Uri.parse(path)` in monaco's **global** registry and, at unmount, disposes only whichever model happened to be active. Bind `path="index.html"` and two different projects share one model — open project B and it shows project A's code, with A's undo history. Project-scoped URIs plus our own disposal close that, and it also removes a load-bearing dependency on whether the parent's watcher or the child's fires first in a flush. The wrapper still owns what we actually want from it: the loader, editor construction, the container, the sizing and the theme prop. |
| D8 | **How do streamed chunks reach the editor?** | **An append edit, never `setValue`.** A pure `editorEdit(current, next)` returns `{ kind: 'append', text }` when `next` starts with `current`, `{ kind: 'replace', text: next }` otherwise, and `null` when they are equal. After an append the view is revealed to the last line. | **This is the slice's one real hazard.** `setValue` replaces the model wholesale: the viewport snaps back to line 1, so a user watching a 300-line file stream in stares at its first ten lines for the entire generation, the undo stack is reset each chunk, and the whole document is re-tokenized per chunk — O(n²) over the file. An append is O(delta), keeps the cursor and scroll, and lets `revealLine` follow the tail, which is what "tokens appear live in the editor" actually looks like. It is also **invisible below L5**: jsdom computes no layout and runs no Monaco, so both versions pass every L1 and L2 test in this repo. Rejected: binding the wrapper's `value` prop (its watcher does exactly the `setValue` above). |
| D9 | Read-only while streaming. | **`options.readOnly` follows `generating`,** with a `readOnlyMessage` so a blocked keystroke explains itself. | Slice 6's D21 restated in the new widget, for the same reason: a generation's batch and the editor are two writers for one document and the collision is silent. `IMPLEMENTATION_PLAN.md` §4 lists this as one of Slice 7's key tests. |
| D10 | **What opens a tab?** | Clicking a row in the file tree opens a tab for that path and makes it active; a row whose tab is already open just activates it, with **no second tab and no refetch**. | The tree stays the navigation surface it already is (Slice 6), so the tree's own diff in this slice is nearly nothing. Refetching on re-activation would silently discard the buffer, which is the exact bug tabs exist to fix. |
| D11 | Does a generation open tabs? | **It opens a tab for the first file it writes only if no tab is open at all**, and never changes the active tab otherwise. | Slice 6's `autoSelected` rule, carried over. Opening a fresh project and prompting must show the code arriving — that is the demo — but a generation that yanks the user off the file they are reading is a worse experience than one that quietly rewrites it underneath (which D9 already makes safe). |
| D12 | **Closing a tab — and what happens to unsaved work?** | Every tab has its own close control. Closing the active tab activates the **left** neighbour, the right one if it was leftmost, and leaves the editor empty if it was the only one. **The buffer survives the close**, keyed by path, until the project is closed. | This is what removes the confirm dialog from the slice entirely: closing a tab cannot lose work, because reopening the file restores the unsaved content and its dirty mark without a request. A "discard your changes?" modal is a component, a focus trap, an e2e case and a decision about what the default button is — all bought by a rule that costs one line. Rejected: dropping the buffer on close (silent data loss, or a dialog); rejected: refusing to close a dirty tab (a tab you cannot get rid of). |
| D13 | **Which component is the tab strip?** | **Hand-rolled** — a `role="tablist"` of `<button role="tab">`, each with a sibling close `<button aria-label="Close <path>">` — styled to match the vendored `Tabs`. | Two reasons, both structural. A closable tab cannot be a single `TabsTrigger` without nesting a `<button>` inside a `<button>`, which is invalid HTML and unreachable by keyboard. And all tabs share **one** Monaco instance, so there is no per-tab `TabsContent` for reka-ui's `Tabs` to switch between — the root would be managing panels that do not exist. The brief's "tabs" requirement is already discharged by the shadcn `Tabs` in the narrow workspace layout (Slice 4), which is untouched. |
| D14 | **Where does per-tab state live?** | The store's single `fileContent` / `savedContent` / `fileLoading` / `fileError` / `fileReplaced` become **one map keyed by path**: `{ content, saved, loading, error, replaced }`. `selectedPath` keeps its name and now means *the active tab*. | Keeping the name is deliberate diff hygiene: `FileTree.vue` and half of `FileEditor.vue` do not change at all, so the review reads the change to the buffer model rather than a rename spread over four files. The active tab's values stay exposed as computed passthroughs (`editorContent`, `fileDirty`, `fileLoading`, `fileError`, `fileReplaced`), which is what makes the component churn small. |
| D15 | After a generation writes files, which buffers refresh? | **Every open tab whose file the generation wrote is re-read.** A clean buffer is replaced silently; a dirty one is replaced and shows "replaced by the latest generation". A file that is **buffered but closed** has its entry dropped, so reopening it fetches the server's copy. | Slice 6's D20 and D22 restated per tab instead of per selection — the reason is unchanged (the server *repairs* content and computes `size`, so what streamed is not necessarily what was stored), and the number of re-reads is bounded by the number of open tabs. Dropping closed buffers rather than re-reading them keeps the request count to what is on screen. |
| D16 | When does the "replaced" notice go away? | **On the next edit in that tab, or when the tab is closed.** It is per tab, not global. | It has to be dismissible by doing something, or it sits over a file the user has since re-edited and lies. Slice 6 cleared it on selecting another file; with tabs, "another file" no longer implies leaving this buffer behind, so the trigger moves to the buffer itself. |
| D17 | **Does the editor follow the app's theme?** | **Yes** — `vs-dark` when the resolved theme is dark, `vs` when light, switching without remounting the editor or touching the buffer. | The app has a real three-state theme control (`composables/useTheme.ts`, `ThemeToggle.vue`), and a permanently-white editor inside a dark workspace is the single most obvious way this slice could look unfinished. The wrapper takes `theme` as a prop, so this is a binding, not a mechanism. |
| D18 | Which editor options? | `automaticLayout: true`, `minimap: { enabled: false }`, `scrollBeyondLastLine: false`, `tabSize: 2`, `wordWrap: 'on'`, `fontFamily` from `--font-mono`, and `readOnly` per D9. | `automaticLayout` is the load-bearing one: the editor sits inside a `ResizablePanelGroup`, and without it Monaco never re-measures when the splitter moves, leaving the text clipped at the old width — a visible bug with no error attached. The minimap is noise in a 35%-width panel, and `wordWrap` keeps generated HTML readable there rather than requiring a horizontal scroll. |
| D19 | **Panel geometry** — the finding Slice 6 handed over. | The tree keeps its cap **on the element that scrolls** (`max-h-56 overflow-y-auto` on the wrapper in `EditorPanel.vue`), and the editor region gets a **definite height**: `flex-1 min-h-0` all the way down, with the editor at `height: 100%`. | `IMPLEMENTATION_PLAN.md` §0 hands this over by name, and Monaco makes it sharper: it measures its container, so a container sized by its own content collapses the editor to **0 px** and renders nothing at all. jsdom computes no layout, so no L1 or L2 test in this repo can see it — which is exactly how the Slice 6 version shipped. AC-30 asserts a non-zero rendered height at L5, which is the only level where a box has a size. |
| D20 | **Is Monaco in the initial bundle?** | **No.** The setup module is behind a dynamic `import()`, so the editor chunk loads when the workspace first needs it. `CodeEditor.vue` renders a skeleton until `mount` fires, and an error with **Try again** if the chunk fails. | Monaco is roughly a megabyte gzipped and the sign-in page has no use for it. This is also what gives the new screen an honest loading state and an honest error state, which the definition of done requires anyway. |
| D21 | Does anything server-side change? | **No.** No route, no collection, no rules block, no index, no system-prompt change, no configuration, no `.env` key. The whole slice is `frontend/` plus two e2e files. | Stated so the review can check it as a claim rather than infer it from the absence of a section. It is also why this slice is comfortably reviewable in one PR where Slice 6 was "at the edge" (Slice 6, D33). |
| D22 | **Does the file half of the store become `useProjectFiles`?** (`IMPLEMENTATION_PLAN.md` §0 and Slice 6's review finding 4 defer the call to here.) | **No — not in this slice.** The new pure logic goes to `frontend/src/lib/` instead, so the store grows by wiring only. Revisit in Slice 12's audit. | The call is made with Monaco in hand, as asked. This slice **rewrites** the file half — one buffer becomes a map, one selection becomes a tab list — so extracting it in the same PR produces a diff in which everything both moved and changed, which is precisely the shape a review misses things in. The size argument is also weaker than it looks: three of the four new modules (`editorLanguage`, `editorContent`, `editorModels`) are pure and live outside the store regardless, so the store lands near where it started. And §5 is explicit that Slices 2–13 ship the brief's line, not a hardened version of it, with Slice 7 already first on the cut list. |
| D23 | **How is Monaco tested below L5?** | **It is not run below L5 at all.** `VueMonacoEditor` is stubbed in L2; everything that decides *what* goes into the editor is pure and L1-tested against a hand-written fake monaco. The real editor is exercised once, at L5. | Monaco in jsdom is a dead end — no layout, no canvas metrics, no `ResizeObserver` worth the name — and a test that mounts it there proves the mock works. Recorded explicitly because "there is no L2 test that Monaco renders" otherwise reads as an oversight rather than as the boundary it is. It is also why D8's hazard gets its own pure module: the append-vs-replace decision is the part that can be proven cheaply and repeatedly. |
| D24 | **Slice 6's e2e drives a textarea. What happens to it?** | `tests/e2e/files.spec.ts` is **updated in place**, in the same commit as the swap, to drive Monaco through two helpers in `tests/e2e/helpers.ts`. Its assertions are unchanged. Slice 7's own L5 is a new `tests/e2e/editor.spec.ts`. | `fill()` and `toHaveValue()` both stop working the moment the textarea is gone, and a broken test that gets skipped or loosened is worse than no test. Two specs, as in Slice 6's D32: `files.spec.ts` stays the signal for "file operations broke", `editor.spec.ts` for "the editor broke", so a red run still names the culprit. |
| D25 | Language mapping. | `.html → html`, `.css → css`, `.js → javascript`, `.md → markdown`, `.json → plaintext`, anything else → `plaintext`. Pure, with a test asserting the map covers **every** extension Slice 6's allowlist permits. | An unmapped extension silently rendering as plaintext is the failure mode, and it is invisible — the file just looks grey. Pinning the map to the allowlist is what makes a future extension addition fail a test instead of shipping colourless. |
| D26 | Save. | Unchanged semantics, now scoped to the **active tab**: the byte count, the cap check, the disabled states and the read-only guard all read the active buffer, and a save touches no other tab. | Slice 6's rules were deliberately put in the store so that this swap would touch the widget and nothing else (`FileEditor.vue`'s own header says so). Keeping that true is the test of whether that was right. |
| D27 | Does the tree change? | Only in that a click now opens a tab. Its four states, its ordering, its writing marker and its Retry are untouched. | Slice 6 put the order and the merge in `lib/files.ts` with their own tests; nothing here has a reason to move them. |
| D28 | Is this one reviewable PR? | **Yes, comfortably.** No backend, no rules, no data model. One dependency pair, one setup module, three pure modules, two new components, one rewritten component, one section of the store, two e2e files. | Build order is the mitigation, as in Slice 6: the pure modules and their fakes first (D8's hazard is reviewable before any `.vue` file changes), then the store, then the components, then the e2e. |

## In scope

- `frontend/package.json` — **new deps:** `@guolao/vue-monaco-editor`, `monaco-editor` **pinned**
  `0.52.2` (D1)
- `frontend/src/lib/monacoSetup.ts` — **new.** The locally imported monaco (`edcore.main` plus the
  four `basic-languages` contributions), `MonacoEnvironment.getWorker` for the one generic worker,
  and `loader.config({ monaco })` behind a dynamic import (D2, D3, D5, D20)
- `frontend/src/lib/editorLanguage.ts` — **new.** Extension → monaco language id (D25)
- `frontend/src/lib/editorContent.ts` — **new.** `editorEdit(current, next)`, the append/replace
  decision (D8)
- `frontend/src/lib/editorModels.ts` — **new.** The project-scoped model URI, get-or-create, view
  state save/restore on switch, and disposal (D7)
- `frontend/src/components/workspace/CodeEditor.vue` — **new.** The `VueMonacoEditor` wrapper:
  the instance in a `shallowRef`, the model registry, the streaming applier, `readOnly`, the
  theme, the loading and load-failure states (D6, D8, D9, D17, D18, D20)
- `frontend/src/components/workspace/EditorTabs.vue` — **new.** The tab strip: active mark, dirty
  mark, close control, horizontal overflow (D12, D13)
- `frontend/src/components/workspace/FileEditor.vue` — rewritten around the tabs and `CodeEditor`;
  the byte count, **Save**, the dirty state, the save error, the replaced notice and the read-only
  reason all kept
- `frontend/src/components/workspace/EditorPanel.vue` — the tab strip added, and the editor given a
  definite height (D19)
- `frontend/src/components/workspace/FileTree.vue` — a click opens a tab (D10); nothing else
- `frontend/src/stores/workspace.ts` — `openTabs`, the per-path buffer map, `closeTab()`,
  `dirtyPaths`, the active-tab passthroughs, the per-tab refresh after a generation (D11, D14,
  D15, D16)
- `tests/e2e/helpers.ts` — `setEditorContent()` and `editorText()`, Monaco-aware (D24)
- `tests/e2e/files.spec.ts` — driven through those helpers; assertions unchanged (D24)
- `tests/e2e/editor.spec.ts` — **new.** This slice's one L5
- `frontend/src/lib/no-cdn.spec.ts` — **new.** A source scan, in the shape of the existing
  `no-firestore.spec.ts` (D2)
- `docs/IMPLEMENTATION_PLAN.md`, `docs/PRODUCT_SPEC.md` — §0/§4/§9 status, §7.1's Monaco row

## Out of scope

| Not here | Picked up by |
|---|---|
| The `srcdoc` preview, the runtime shim, running the generated app | Slice 10 |
| Snapshot, list and restore | Slice 11 |
| Project files in the model's context; the HighLevel cheat-sheet | Slice 9 |
| Language services — validation, red squiggles, IntelliSense, formatting (D3) | Not planned — deliberately refused |
| `.json` syntax colouring (D4) | Revisit in Slice 9 if real generations need it |
| A diff view of what a generation changed | Stretch S3 (F10.3) |
| Extracting `useProjectFiles` from the store (D22) | Slice 12's audit, if still worth it |
| Persisting the open tab set across a reload | Not planned |
| Reordering tabs by drag, split panes, a second editor group | Not planned |
| Creating, renaming or deleting a file; directories | Not planned (Slice 6, D12/D19) |
| A confirm dialog on closing a dirty tab (D12) | Not planned — the buffer survives instead |
| Monaco's diff editor (`VueMonacoDiffEditor`) | Stretch S3 |
| Any server-side change: routes, rules, indexes, the system prompt (D21) | — |

## User flow

1. The user opens a project. The code panel shows the file tree's loading state, then its rows —
   or "No files yet." on a new project. The editor area shows **"Select a file to read or edit
   it."**; no tab is open.
2. They send "build a contact dashboard". The composer disables, the chat shows `Generating…`.
3. The model opens `index.html`. A row appears in the tree marked *Writing…*; because no tab is
   open, a tab opens for it and becomes active. The Monaco chunk loads — a skeleton for as long
   as that takes — and then **coloured HTML appends into the editor line by line, the view
   following the last line**. The editor is read-only and says so.
4. `styles.css` and `app.js` follow. Their rows appear in the tree; the active tab does not move.
5. On `done` the tree refetches, the streaming buffers are dropped, `index.html` is re-read from
   the server, and the editor becomes editable.
6. The user clicks `styles.css` in the tree. A second tab opens and activates; its content is
   fetched. They type a line — the tab shows a dirty mark, the byte count moves, **Save** enables.
7. They click the `index.html` tab, look at something, and click back to `styles.css`. **The
   unsaved line is still there**, the tab is still dirty, and no request was made.
8. **Save** issues the `PUT`. The button settles, the dirty mark clears.
9. They close the `index.html` tab. It leaves the strip and `styles.css` stays active.
10. Reload. The tree comes back from the server; no tab is open; clicking `styles.css` shows the
    saved content.
11. If Monaco's chunk fails to load, the editor area shows the failure and a **Try again**; the
    tree, the chat and the rest of the workspace are unaffected.

## Data model

**Unchanged.** No new collection, no new field, no rules change, no index change. The review
should check that claim against the diff: `firestore.rules`, `firestore.indexes.json` and
everything under `functions/src/` are expected to be untouched (D21).

Client-side state changes, and only in `useWorkspaceStore`:

| Was | Is | Note |
|---|---|---|
| `selectedPath: string \| null` | unchanged in name and type | Now means *the active tab* (D14) |
| — | `openTabs: string[]` | Ordered by the order they were opened |
| `fileContent`, `savedContent`, `fileLoading`, `fileError`, `fileReplaced` | `buffers: Record<string, { content, saved, loading, error, replaced }>` | One entry per path that has been opened this session; survives a tab close (D12) |
| `fileDirty` | unchanged in name | Now `content !== saved` for the **active** buffer |
| — | `dirtyPaths: string[]` | What the strip marks |
| `selectFile(path)` | unchanged in name | Opens a tab if needed, then activates it (D10) |
| — | `closeTab(path)` | D12 |
| `streamingFiles`, `fileTree`, `editorContent` | unchanged | `editorContent` still prefers the streaming buffer for the active path |

## API contracts

**Unchanged.** `GET /api/projects/:projectId/files`,
`GET /api/projects/:projectId/files/:path`, `PUT /api/projects/:projectId/files/:path` and
`POST /generate` keep the shapes Slice 6 specified, including `done`'s `files` and `fileError`.
This slice issues the same three requests from a different widget.

The one behavioural change on the client side is **when** they are issued: re-activating an
already-open tab issues nothing (D10), reopening a closed-but-buffered file issues nothing (D12),
and a generation re-reads one request per open tab it rewrote rather than one for the selection
(D15).

## Edge cases and failure modes

| Situation | Behaviour | User sees | Retry? |
|---|---|---|---|
| Monaco's chunk is still loading | The editor area renders a skeleton; the tree and tabs are already usable | A skeleton where the code will be | n/a |
| Monaco's chunk fails to load | The editor area renders the failure; nothing else in the workspace is affected | "The editor could not be loaded." and **Try again** | Retry |
| A file is opened and the read fails | That tab is kept, its buffer is not populated | The read error inside that tab, with **Try again** | Retry |
| A generation streams into the active tab | Each chunk is an append edit; the view follows the last line | Code appearing line by line, coloured, in a locked editor | n/a |
| A generation streams into a file that is **not** the active tab | The active model is not touched; the tree marks the other file *Writing…* | The tree filling in; the open file unchanged | n/a |
| The user types while a stream is open | Monaco refuses the edit and says why | A locked editor and "Read-only while a reply is generating." | n/a |
| A generation rewrote an open tab, buffer clean | The tab is re-read; the buffer is replaced silently | The new content | n/a |
| …buffer dirty (D15, D16) | The buffer is replaced and the tab shows the notice until the next edit or close | "Replaced by the latest generation." | n/a |
| A generation rewrote a **closed** buffered file | Its entry is dropped; reopening fetches the server's copy | Nothing until they reopen it | n/a |
| A generation whose files were refused (`done.files` empty) | No file request is issued; no buffer changes; `generateFileError` renders as in Slice 6 | The reply, the refusal sentence, the tree untouched | Retry |
| A tab is closed while dirty | It leaves the strip; the buffer survives; reopening restores the edit and the dirty mark, with no request | The edit, exactly as typed | n/a |
| The last tab is closed | No active tab; the editor renders its empty state | "Select a file to read or edit it." | n/a |
| A tree row for an already-open tab is clicked | The tab is activated; **no** refetch and no second tab | The buffer as they left it | n/a |
| The buffer is over the byte cap | **Save** is disabled before any request | The byte count in the destructive colour, naming the limit | n/a |
| A save fails | The buffer is kept exactly as typed, still dirty | The server's message beside **Save** | Re-save |
| Two browser tabs saving one file | Last write wins — **unchanged from Slice 6** (D23), proven by its AC-28 there | The later content on refresh | n/a |
| The splitter is dragged, or the window resized | `automaticLayout` re-measures; text reflows (AC-11) | Nothing broken — which is the point | n/a |
| The theme is toggled while a file is open | The editor's theme prop changes; no remount, no buffer change | The editor changing ground with the app | n/a |
| The project is left and another opened | Every model this project created is disposed; tabs, buffers and the registry are empty | The new project's own tree | n/a |
| A file whose extension has no tokenizer (`.json`) | Rendered as plaintext (D4) | Uncoloured but correct text | n/a |

## Acceptance criteria

**The language map — pure (D25)**

- **AC-1** — Given `index.html`, `styles.css`, `app.js`, `notes.md`, `data.json` and a name whose
  extension is outside Slice 6's allowlist, then `editorLanguage()` returns `html`, `css`,
  `javascript`, `markdown`, `plaintext` and `plaintext`; and every extension the allowlist permits
  has an entry in the map.

**The content applier — pure (D8)**

- **AC-2** — Given `current === next`, then `editorEdit` returns `null` and no edit is issued.
- **AC-3** — Given `next` starts with `current` and is longer, then it returns an append whose
  text is exactly the suffix — not the whole document.
- **AC-4** — Given `next` does not start with `current` — a different file's content, a server
  repair that changed earlier bytes, or a shorter string — then it returns a replace carrying the
  whole of `next`.
- **AC-5** — **Round trip.** For every pair in the fixture corpus, applying the returned edit to
  `current` yields exactly `next`.

**The model registry — pure, against a fake monaco (D7)**

- **AC-6** — Given a project id and a path, then the model URI is
  `inmemory://genesis/<projectId>/<path>`; given the same filename under two different project
  ids, then the URIs differ and two distinct models exist, so neither project can see the other's
  content.
- **AC-7** — Given a path that already has a model, when it is opened again, then the same model
  instance is returned and no second model is created.
- **AC-8** — Given a switch from path A to path B, then A's view state is saved before the model
  changes and B's is restored after it if one was saved; given B has never been open, then no
  restore is attempted.
- **AC-9** — Given the project is closed, then every model the registry created is disposed and
  the registry is empty; a subsequent open creates fresh models.

**Streaming into the editor (D8, D9)**

- **AC-10** — Given the active tab's file is being written, when chunks arrive, then each produces
  an **append** edit on that model, the view is revealed to the last line, and **no `setValue` is
  issued for that file for the duration of the stream**.
- **AC-11** — Given a stream is open, then the editor's `readOnly` option is `true` and a
  `readOnlyMessage` is set; when the stream ends, then `readOnly` is `false`. The options passed
  also carry `automaticLayout: true`, so a splitter drag re-measures instead of clipping (D18).
- **AC-12** — Given the stream writes a path that is not the active tab, then the active model is
  not modified.

**Tabs (D10–D14)**

- **AC-13** — Given no tab is open, when a tree row is clicked, then a tab opens for that path,
  becomes active, its content is fetched, and the strip renders it as active; given that read
  fails, then the tab is kept, its buffer is not populated, its error is set, and a **Try again**
  re-reads it — no other tab is affected.
- **AC-14** — Given a tab is already open for a path, when its row is clicked, then it is
  activated, **no request is issued**, and there is still exactly one tab for that path.
- **AC-15** — Given two open tabs, when the user edits the active buffer, switches to the other
  tab and back, then the edit is still in the buffer, the tab is still marked dirty, and **no
  request was issued** by either switch.
- **AC-16** — Given three tabs with the middle one active, when it is closed, then it leaves the
  strip and the **left** neighbour becomes active; given the leftmost is closed, then the right
  neighbour becomes active; given the only tab is closed, then there is no active tab.
- **AC-17** — Given a dirty tab is closed and its file reopened from the tree, then the buffer
  returns with the unsaved content and the dirty mark, and **no request is issued**.
- **AC-18** — Given no tab is open when a generation starts, then a tab opens for the first file
  written and becomes active; given a tab is already open, then the active tab is unchanged for
  the whole generation.

**Save, per tab (D26)**

- **AC-19** — Given the active tab is dirty and within the cap, then **Save** is enabled; when the
  save succeeds, then the stored content replaces **that tab's** buffer, it is no longer dirty,
  and no other tab's buffer changed; when it fails, then that buffer is untouched, still dirty,
  and the error renders beside **Save**.
- **AC-20** — Given a stream is open, then **Save** is unavailable and `saveFile()` issues no
  request.
- **AC-21** — Given the active buffer exceeds the byte cap, then **Save** is disabled and the byte
  count renders as over the limit, naming it.

**After a generation (D15, D16)**

- **AC-22** — Given two tabs are open on files a generation rewrote, one clean and one dirty, then
  both are re-read from the server, the clean one is replaced silently, and the dirty one is
  replaced and shows the "replaced by the latest generation" notice; the notice clears on the next
  edit in that tab.
- **AC-23** — Given a buffered but **closed** file was among the files a generation wrote, then its
  buffer entry is dropped, and reopening it issues a fresh read.
- **AC-24** — Given `done` carries an empty `files`, then **no** file request is issued and no
  buffer changes.

**Monaco wiring (D1–D6, D17, D20)**

- **AC-25** — Given the setup module is loaded, then `loader.config` is called with the locally
  imported `monaco` instance before any editor mounts, and **no CDN host** (`cdn.jsdelivr.net`,
  `unpkg.com`, `cdnjs`) appears anywhere under `frontend/src`.
- **AC-26** — Given the editor chunk has not resolved, then `CodeEditor` renders its skeleton;
  given the load fails, then it renders the failure with a **Try again** that retries the load;
  given it mounts, then neither renders and the editor does.
- **AC-27** — Given the resolved theme is dark, then the editor's `theme` is `vs-dark`; when the
  theme is toggled to light, then it becomes `vs`, and the editor is **not** remounted and the
  buffer does not change.
- **AC-28** — **The instance is not made reactive.** Given `mount` is emitted with a sentinel
  editor object, then the value the component holds is **identical** (`===`) to that object — which
  a `ref`/`reactive` proxy is not.
- **AC-29** — Given `frontend/package.json`, then `@guolao/vue-monaco-editor` and `monaco-editor`
  are the only added dependencies, `monaco-editor` is pinned exactly, and no
  `firebase/firestore` import exists anywhere under `frontend/src` — re-asserted.

**Geometry and the demo — the only levels where a box has a size**

- **AC-30** — Given the workspace in a browser at desktop width, then the file tree scrolls within
  its cap with every row reachable, and the editor renders with a **non-zero height** showing
  Monaco's own line elements; the same holds in the narrow tabbed layout.
- **AC-31** — Given a verified account with a project, when the user sends `__slow build a contact
  dashboard`, then **coloured tokens appear in Monaco while the reply is still streaming** and the
  editor is read-only throughout; when the stream ends the editor is editable; opening a second
  file adds a second tab; an unsaved edit in one tab survives switching to the other and back;
  **Save** stores it; and after a reload the file returns with the saved content.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1 | L1 | `frontend/src/lib/editorLanguage.spec.ts` | The map, and that it covers the whole allowlist |
| AC-2, AC-3, AC-4 | L1 | `frontend/src/lib/editorContent.spec.ts` | Equal, append, replace |
| AC-5 | L1 | `frontend/src/lib/editorContent.spec.ts` | Round trip over the corpus |
| AC-6, AC-7 | L1 | `frontend/src/lib/editorModels.spec.ts` | Project-scoped URIs; reuse, not recreation |
| AC-8, AC-9 | L1 | `frontend/src/lib/editorModels.spec.ts` | View state on switch; disposal on close |
| AC-13, AC-14, AC-15 | L1 | `frontend/src/stores/workspace.spec.ts` | Opening, re-activating, switching without refetch |
| AC-16, AC-17 | L1 | `frontend/src/stores/workspace.spec.ts` | Close and neighbour selection; the surviving buffer |
| AC-18, AC-24 | L1 | `frontend/src/stores/workspace.spec.ts` | Generation opens a tab only into an empty strip; empty `files` issues nothing |
| AC-19, AC-20, AC-21 | L1 | `frontend/src/stores/workspace.spec.ts` | Save per tab: success, failure, guards |
| AC-22, AC-23 | L1 | `frontend/src/stores/workspace.spec.ts` | Per-tab refresh, the notice and its clearing, dropped closed buffers |
| AC-10, AC-12 | L2 | `frontend/src/components/workspace/CodeEditor.spec.ts` | Append edits and `revealLine` against a fake editor; the inactive path untouched |
| AC-11, AC-27, AC-28 | L2 | `frontend/src/components/workspace/CodeEditor.spec.ts` | `readOnly` follows `generating`; theme prop; instance identity |
| AC-26 | L2 | `frontend/src/components/workspace/CodeEditor.spec.ts` | Skeleton, load failure + Try again, mounted |
| AC-13, AC-16 | L2 | `frontend/src/components/workspace/EditorTabs.spec.ts` | Strip rendering, active and dirty marks, close control, a11y roles |
| AC-19, AC-21, AC-22 | L2 | `frontend/src/components/workspace/FileEditor.spec.ts` | Byte count, Save states, save error, replaced notice, empty state |
| AC-13 | L2 | `frontend/src/components/workspace/FileTree.spec.ts` | A row click calls `selectFile` — existing case, kept |
| AC-25 | L1 | `frontend/src/lib/monacoSetup.spec.ts` | `loader.config` receives the local instance |
| AC-25 | L1 | `frontend/src/lib/no-cdn.spec.ts` | Source scan: no CDN host under `frontend/src` |
| AC-29 | L1 | `frontend/src/lib/no-firestore.spec.ts` | Existing scan, unchanged |
| AC-29 | L1 | `frontend/src/lib/deps.spec.ts` | `package.json`: the two additions, the exact pin |
| AC-30, AC-31 | L5 | `tests/e2e/editor.spec.ts` | Coloured tokens while streaming, read-only, two tabs, the surviving edit, save, reload, non-zero height |

`tests/e2e/files.spec.ts` is updated to drive Monaco (D24) and keeps asserting Slice 6's AC-48;
it is not listed above because it proves no criterion of this slice.

## Definition of done

- [ ] Every acceptance criterion above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`,
      `test:e2e`
- [ ] `tests/e2e/files.spec.ts` passes **unchanged in what it asserts** — driven through Monaco,
      not loosened, not skipped
- [ ] `firestore.rules`, `firestore.indexes.json` and `functions/` are untouched by this slice,
      and the review checks that against the diff rather than against D21
- [ ] The code panel ships loading, empty and error states for the editor as well as the tree,
      and the chat panel's existing states still pass
- [ ] `@guolao/vue-monaco-editor` is the exact package the brief names; `monaco-editor` is pinned
      and the pin's reason (D1) is in this document
- [ ] Nothing is fetched from a CDN at runtime: `loader.config({ monaco })` is called before the
      first mount, and the built `frontend/dist` is grepped for `jsdelivr`/`unpkg` at ship time
- [ ] The editor instance is never `ref`/`reactive` — asserted by AC-28, not by a comment
- [ ] No `firebase/firestore` import anywhere under `frontend/src`; no new configuration, so
      `.env.example` is unchanged — stated rather than assumed
- [ ] Runs clean on `npm run dev` (emulators) from a fresh clone **with the network unplugged
      after install**: the editor loads, colours, streams and saves
- [ ] Bundle check: Monaco is in its own chunk and is not in the entry bundle
- [ ] `IMPLEMENTATION_PLAN.md` §0 status, §4 Slice 7 and §9's F6.3 row updated;
      `PRODUCT_SPEC.md` §7.1's Monaco row marked installed, with the version pin and its reason
- [ ] PR opened with demo evidence: code streaming into a coloured, locked editor; two tabs; an
      unsaved edit surviving a tab switch; a save surviving a reload. **Human approves before
      merge**

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **`setValue` per chunk instead of an append edit** (D8). It passes every automated test this repo can run below L5, and in the running app it snaps the viewport to line 1 on every chunk — so the user watches the first ten lines of a file for an entire generation — while re-tokenizing the whole document each time. | The decision is a **pure function** with its own module and five ACs, so the append/replace rule is reviewable before any `.vue` file changes, and AC-10 asserts the negative that matters: no `setValue` for a file while it is streaming. AC-31 watches it happen in a real browser. |
| R2 | **The mandated wrapper is old.** `@guolao/vue-monaco-editor@1.6.0` predates Vue 3.5, Vite 8 and TypeScript 6, ships `vue-demi`, and its own `.d.ts` imports a monaco path that current monaco no longer resolves. A typecheck failure here is a failure in a package the brief requires. | D1's pin removes the known break, and `typecheck` is the gate rather than a smoke test. **If `vue-demi` or the wrapper still fails under this toolchain, that is a stop-and-write-it-down, not a keyboard decision** — replacing it means substituting a brief-named package, which needs a recorded decision (`PRODUCT_SPEC.md` §7). |
| R3 | **Monaco cannot run in jsdom**, so most of what this slice does visibly has exactly one automated proof, at L5, and L5 is the level we run least often. | D23 pushes every decidable thing into pure modules with fakes — the language map, the edit decision, the model registry — so the L5 is left proving only what genuinely needs a browser: colouring, layout, and read-only enforcement. The L2s assert the props the component passes, which is the contract, against a stub. |
| R4 | **Layout collapse.** Monaco measures its container; a container with no definite height renders a 0 px editor and no error. This is exactly the Slice 6 finding (`IMPLEMENTATION_PLAN.md` §0) in a form that fails louder. | D19 puts the cap on the element that scrolls and a definite height on the editor's, `automaticLayout: true` handles the resizable splitter, and AC-30 asserts a non-zero rendered height at L5 — the only level with a layout engine. |
| R5 | **Model URI collision across projects** (D7). The wrapper's own model management is global-registry-keyed and would show project B the contents of project A's `index.html`, with A's undo history — a data-confusion bug with no error. | Project-scoped URIs, our own registry, disposal on project close; AC-6 asserts two projects cannot share a model and AC-9 asserts disposal. |
| R6 | **Bundle weight.** Monaco is around a megabyte gzipped; landed in the entry chunk it would be paid for on the sign-in page. | D20's dynamic import puts it in its own chunk behind the workspace, which is also what earns the editor an honest loading state (AC-26). A bundle check is in the definition of done. |
| R7 | **Slice 7 is first on `IMPLEMENTATION_PLAN.md` §5's cut list**, and the graded chain (8 → 9 → 10) is still ahead. Sinking a day into an editor would be the wrong trade even if the editor were perfect. | The cut is pre-decided and written down here: if Monaco is not green by the end of day 3, revert the two dependencies and `FileEditor.vue` to the textarea — a single commit, because D26 kept every rule in the store and D21 means nothing on the server depends on this slice. Then move to Slice 8. |
| R8 | **The e2e that already exists breaks by construction** — `fill()` and `toHaveValue()` do not work on Monaco — and the tempting fix is to loosen or skip it. | D24: it is updated in the same commit as the swap, through two named helpers, with its assertions unchanged. Weakening a test to get a green suite is out of bounds for this project regardless. |

## Blocked

Nothing. Every question this slice raises is answered above.
