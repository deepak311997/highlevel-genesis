# Slice 07 — Monaco editor · Build log

**Plan:** `03-plan.md` (approved) · **PRD:** `02-prd.md` · **Branch:** `slice/07-monaco-editor` ·
**Started:** 2026-08-18

Appended as the work happens, one entry per task. Deviations from the plan are recorded
under the task that caused them, with the reason.

## Before the first task

`main` at `5c1fb06` (Slice 06). `typecheck`, `lint` and `test:unit` green — 50 files,
635 frontend tests, 19 script tests. `test:rules` confirmed green in parallel with T1.

## T1 — the two dependencies, and making monaco typecheck (AC-29)

**Commit:** `f8dfa1d` · **Tests added:** `frontend/src/lib/deps.spec.ts` (L1, 2 cases).

`@guolao/vue-monaco-editor@^1.6.0` and `monaco-editor@0.52.2` (exact, `--save-exact`).
`env.d.ts` gained the ambient module for `monaco-editor/esm/vs/editor/edcore.main` — monaco
ships no `.d.ts` for it, only for `editor.api`, which `edcore.main.js` re-exports wholesale —
and the `Window.monaco` declaration P3 needs.

**Everything the plan's "verified against the real packages" table claims was re-confirmed
against the installed tarballs:** `monaco-editor@0.52.2`'s `package.json` has no `exports`
key, `esm/vs/editor/edcore.main.js` exists, `editor.api.d.ts` is the only `.d.ts` beside it,
and `esm/vs/editor/editor.worker.js` is present.

**R2's stop condition is cleared.** A scratch module importing `loader` and
`VueMonacoEditor` from the wrapper, `* as monaco` from `edcore.main`, and
`editor.worker?worker` typechecks under TypeScript 6 / Vite 8 / Vue 3.5 — so `vue-demi` and
the wrapper's own `.d.ts` are fine and no package substitution is needed. The scratch file
was deleted; T6 and T11 import the same three for real.

One commit rather than two: the test and the install are one change, and a `test:` commit
that installs nothing would have been red at HEAD.

## T2 — `useDarkClass` (P2)

**Commit:** `35b75a2` · **Tests added:** `frontend/src/composables/useDarkClass.spec.ts`
(L1, 3 cases — seeded from the document, follows a change, stops on scope dispose).

A `MutationObserver` on `document.documentElement`'s `class`, filtered to that attribute,
disconnected in `onScopeDispose` (`useTheme.ts`'s own cleanup pattern). The disposal case is
an addition to the plan's two: the `lg` breakpoint unmounts `CodeEditor` on a window resize,
so a leaked observer per mount is a real cost rather than a hypothetical one.

`useTheme.ts`'s duplication note now names all three readers of the `dark` class name.

## T3 — the language map (AC-1)

**Commit:** `465556d` · **Tests added:** `frontend/src/lib/editorLanguage.spec.ts` (L1,
11 cases).

`EDITOR_LANGUAGES` as `as const satisfies Record<string, string>`; the allowlist coverage
case asserts an **own key** per extension rather than a return value, since every extension
returns something and a call alone cannot tell a mapping from a fall-through.

Three cases beyond the plan's list, each a real shape: `vendor.min.js` (the *last*
extension), `INDEX.HTML` (case), and `weird.` (a trailing dot names no extension).

## T4 — the content applier (AC-2 – AC-5)

**Commit:** `eea0be0` · **Tests added:** `frontend/src/lib/editorContent.spec.ts` (L1,
17 cases including an 11-pair round-trip corpus).

The round trip's `apply()` is written in the spec rather than imported, so the assertion is
the spec's own expectation of monaco rather than a definition shared with the code under
test. The corpus carries two multi-byte pairs, since slicing by code unit is where a naive
suffix goes wrong.

## T5 — the model registry (AC-6 – AC-9)

**Commit:** `27f1ecc` · **Tests added:** `frontend/src/lib/editorModels.spec.ts` (L1,
11 cases against a hand-written fake monaco).

**Deviation from the plan, in the fake rather than the code.** The first run of *"creates
fresh models after a disposal"* failed: the fake's `getModel` kept returning a disposed
model, so the registry adopted it. Real monaco's standalone model service **unregisters** a
model on `dispose()`, so `getModel(uri)` answers `null` afterwards — the fake was wrong, not
the implementation. Fixed by making `dispose()` unregister, which is what closes the loophole
where this suite would pass over code that hands out disposed models.

Four cases beyond the plan's four: adopting a model monaco already holds (a breakpoint
remount builds a fresh registry over live models), re-activating the active path being a
no-op, disposing with a `null` host, and a disposal forgetting the active path.

## T6 — local monaco, no CDN (AC-25)

**Commit:** `f1fac80` · **Tests added:** `frontend/src/lib/monacoSetup.spec.ts` (L1, 4 cases),
`frontend/src/lib/no-cdn.spec.ts` (L1, 8 cases).

**The plan's `?worker` fallback was not needed.** Vitest mocks
`monaco-editor/esm/vs/editor/editor.worker?worker` cleanly, so the case asserts `getWorker`
**returns** a worker rather than merely existing — recorded here because the plan asked for
whichever was used to be written down.

Two assertions had to be phrased around Vitest's failure formatter. A module namespace is a
Proxy that throws on unknown property reads, and the formatter walks whatever it is given, so
`expect(namespace).toBe(other)` reports a `PrettyFormatPluginError` instead of the
comparison. Both identity checks go through `Object.is(...)` into a boolean instead.

One case beyond the plan: *"imports edcore.main rather than another entry point"*. The mock
stands in for `edcore.main` alone, so a module importing `editor.api` or `editor.main` would
load the real thing and export far more than the one key the mock has — which is a cheap
runtime proof of D3.

`no-cdn.spec.ts` passes on the day it is written, exactly as `no-firestore.spec.ts` did; its
`describe('the scan itself')` cases are the red-able half, and they are what makes
`offenders).toEqual([])` worth anything.

## T7 — the store: tabs and per-path buffers (AC-13 – AC-17)

**Commit:** `93da4d8` · **Tests added/rewritten:** `frontend/src/stores/workspace.spec.ts` —
`describe('selectFile')` replaced by `describe('tabs and their buffers')` (16 cases).

**Deviation from the plan, in method rather than outcome: there was no ordinary red step.**
The store's file half and its spec change atomically — the spec cannot reference `openTabs`,
`editContent` or `closeTab` before they exist, and `FileEditor.vue` cannot compile against a
store that has both `fileContent` and `buffers`. So the three new rules were **mutation-
checked** after the fact instead, which is the same evidence in the other order:

| Mutation | Cases that went red |
|---|---|
| `selectFile` fetches even when the path is already buffered | AC-14, AC-15, AC-17 |
| `closeTab` deletes the buffer | AC-17 |

**Two further deviations, both forced and both small.**

- `FileEditor.vue`'s one write of `workspace.fileContent` became
  `workspace.editContent(...)`, because the buffer a keystroke writes now depends on which
  tab is active. The plan puts `FileEditor.vue` in T12; this is one line of it, and the
  alternative was leaving the suite red across two commits. The widget swap is still T12.
- `FileEditor.spec.ts`'s *"writes edits back to the store"* now asserts the action was called
  rather than that a ref changed, for the same reason.

`dropBuffer` rebuilds the record rather than using `delete`, because `no-dynamic-delete` is
on. It runs once per generation per closed rewritten file, not once per chunk, so the
whole-object replacement `streamingFiles`' comment warns about is not a cost here.

## T8 — the store: save, scoped to the active tab (AC-19 – AC-21)

**Commit:** `3423df5` · **Tests added:** two cases in `describe('saveFile')`.

Both passed against T7's implementation, so they were mutation-checked rather than observed
red: writing every buffer on a save fails *"PUTs the active buffer … into that tab only"*,
and defaulting a missing buffer fails *"issues no request for a tab whose file has never been
read"*.

**A finding, recorded rather than fixed here.** That second case is reachable, not
hypothetical: `file_start` opens a tab and creates no buffer (P1), and a stream ending in
`error` rather than `done` never reaches `applyGenerationFiles` — so the tab is left open
over a file the session has never read, with `generating` back to false. Saving from it would
`PUT` an empty string over whatever the server holds. The store's guard closes that, and the
test pins it. **Whether the tab itself should be closed on a failed stream is out of this
slice's scope** — the PRD's D11 and P1 both speak only about `done` — so it is listed under
*Deferred* below rather than decided at the keyboard.

## T9 — the store: what a generation does to the tabs (AC-18, AC-22 – AC-24)

**Commit:** `217103f` · **Tests added/rewritten:** 7 cases in `describe('the stream —
files')`.

Red first, on the three genuinely new behaviours: the per-tab re-read fan-out, the dropped
closed buffer, and AC-24's whole-map equality.

**One Slice 6 test was replaced rather than ported**, and it is a deliberate behaviour
change: *"clears the replaced notice when another file is selected"* is no longer true.
D16 moves the trigger to the next edit in that tab, or closing it, because with tabs
"selecting another file" no longer implies leaving this buffer behind. The replacement pair
is *"…the next edit in that tab clears its notice, and no other's"* and *"keeps the replaced
notice across a tab switch"*.

The fan-out is sequential rather than `Promise.all`: there are at most a handful of open tabs,
and one order is easier to reason about — and to assert — than a race between reads that each
write a different buffer.

## T10 — the tab strip (AC-13, AC-16)

**Commit:** `2133e7f` · **Tests added:** `frontend/src/components/workspace/EditorTabs.spec.ts`
(L2, 6 cases).

Hand-rolled per D13. One case beyond the plan's five: *"puts the close control beside the
tab rather than inside it"* asserts the tab element contains no `<button>` at all — the
structural claim D13 rests on, stated directly rather than inferred from the close control
working.

## T11 — the editor (AC-10 – AC-12, AC-26 – AC-28)

**Commit:** `8487bf5` · **Tests added:** `frontend/src/components/workspace/CodeEditor.spec.ts`
(L2, 15 cases against a stub wrapper and a fake monaco).

**Everything the plan's verification table claims about the wrapper was re-read from
`lib/es/index.js` before the component was written, and all of it held**: `mount` emits
`(editor, monaco)`; the `path`/`value` watcher calls `setValue` and `setModel`;
`onUnmounted` disposes `editorRef.value.getModel()`; `onDidChangeModelContent` compares
against `props.value` and so re-emits `update:value` for our own writes; `createEditor`
makes an anonymous model because `path` is unbound.

**One deviation from the plan's shape, and it is a correctness fix.** The plan specifies two
watchers — one on `selectedPath`, one on `editorContent`. Written that way, the content
watcher can fire before the path watcher in a flush and apply the **new** file's text to the
**old** model: one file's bytes written into another's document. They are one watcher over
the pair, so the ordering is a statement rather than a coincidence.

`applying` was mutation-checked and is genuinely load-bearing. The check only works because
the fake model fires the wrapper's change listener **synchronously from inside `applyEdits`**,
which is where monaco fires it — an echo delivered a tick later finds the guard already down
and passes over a component that has no guard at all. The first draft of that case made
exactly that mistake and was fixed rather than accepted.

Three cases beyond the plan's list: the full-range replace branch, disposal on a project
change, and the detach before unmount.

## T12 — `FileEditor.vue` around the new editor

**Commit:** `03ee25b` · **Tests changed:** `FileEditor.spec.ts` — 3 cases changed, 1 added,
10 kept verbatim.

**This task is D26's test, and D26 passed.** Every case except two is byte-for-byte the
Slice 6 case and passes over a completely different editor. The two that changed are the two
that named the textarea by selector. The new one is AC-13's **Try again**, which calls
`reloadFile()` rather than `selectFile()` — the tab is still open after a failed read, and
selecting an already-buffered path issues nothing.

## T13 — panel geometry and the strip

**Commit:** `17d6371` · **Tests added:** 2 cases in `EditorPanel.spec.ts`; the cap-scrolls
case kept verbatim.

The geometry case passed on the day it was written — it pins an existing chain against
regression, in the same spirit as `no-cdn.spec.ts`. **It was not sufficient**, and T14 says
why.

`CodeEditor` is stubbed in `EditorPanel.spec.ts` as well as `WorkspaceView.spec.ts` — the
plan only named the latter, but both mount `FileEditor`, and unstubbed they pull the real
wrapper whose `onMounted` calls `loader.init()`.

## T14 + T15 — the e2e helpers, `files.spec.ts` through Monaco, and this slice's L5

**Commit:** `01adfb1` · **Tests:** `tests/e2e/editor.spec.ts` (2 cases, AC-30 + AC-31);
`files.spec.ts` driven through the helpers with **its assertions unchanged**;
`tests/e2e/helpers.ts` gains `editorText`, `setEditorContent`, `selectAllInEditor`,
`focusEditor` and `editorTokenClasses`.

Committed together, as D24 requires: a broken e2e that gets skipped is worse than none.

### The L5 earned its keep — it found a real bug

**The narrow layout rendered a 5 px editor.** `EditorPanel`'s `h-full` resolves inside a
stretch-sized `ResizablePanel` (measured: 602 px) but **not** inside a `TabsContent` sized by
`flex-grow` — the panel fell back to its content height, 255 px inside a 642 px tab. Monaco
measures its container and has no intrinsic height of its own, so it collapsed with no error
and no failing test anywhere below L5. Slice 6's textarea had hidden the same broken chain
behind its own `min-h-40`; **this is R4 happening, not R4 being avoided.**

Fixed by removing every percentage from the chain rather than by patching the one link:

| File | Change |
|---|---|
| `WorkspaceView.vue` | the Code `TabsContent` becomes `flex … flex-col` |
| `EditorPanel.vue` | `flex-1` beside `h-full` — each is inert in the other layout |
| `FileEditor.vue` | the editor's region becomes a flex column |
| `CodeEditor.vue` | its root becomes a flex item (`flex-1`) rather than `h-full` |

`WorkspaceView.vue` is **not in the plan's file map**. It is one class string, it is the link
that was actually broken, and the alternative was leaving AC-30 unmet in the layout the PRD
names explicitly. Recorded here rather than worked around.

`EditorPanel.spec.ts` now asserts the panel carries **both** `h-full` and `flex-1`, so
dropping either — each of which breaks exactly one layout, silently — fails at L2.

### The helpers took five measured attempts, and every dead end is in their doc comments

This is the first time this suite has driven a canvas-rendered widget, and the plan flagged
T14/T15 for exactly that. What was learned, in order:

1. **`page.click('.monaco-editor textarea.inputarea')` can never succeed.** The input area is
   a zero-size textarea *under* `.view-lines`, which intercepts pointer events; Playwright
   retries the click until the test times out.
2. **`locator(INPUT).focus()` is worse than useless.** It leaves Monaco's own focus state
   unset, so `ControlOrMeta+a` falls through to the *browser's* select-all inside a textarea
   that holds only a small window of text — and the following `Delete` removed exactly one
   character of the document.
3. **`Cmd`/`Meta` chords never reach Monaco under Playwright at all.** Probed directly against
   the live editor: with `hasTextFocus()` true and the caret placed, `getSelection()` is
   **completely unchanged** after `ControlOrMeta+a` and after `ControlOrMeta+ArrowDown`, while
   `Shift+ArrowDown` moves it correctly. So select-all is built from the keys that do arrive —
   `ArrowUp` per line to the top (the editor may be scrolled: a tab that was streamed into has
   its view state restored at the tail), `Home`, then `Shift+ArrowDown` per line and
   `Shift+End`.
4. **A corner-to-corner drag is not a substitute.** Monaco clamps the endpoint to the last
   rendered line, which left the tail of the file behind.
5. **Writing over a selection triggers `autoSurround`.** Isolated with a probe: `'abc\n'`
   round-trips cleanly, but `'<!doctype html>'` came back as `'<!doctype html>>'` and
   `'<title>x</title>\n'` as `'<title>x</title>\n>'` — the leading `<` surrounded the whole
   document, the rest of the insert replaced the old text inside it, and the `>` was left at
   the end. **That is correct editor behaviour and was not "fixed" in the product**; the
   selection is cleared with `Backspace` before writing, and with nothing selected there is
   nothing to surround.

Two intermediate versions were written and then **removed rather than kept**: a
`selectAllInEditor` built on a mouse drag, and a three-attempt retry loop in
`setEditorContent`. The retry was the wrong diagnosis — three attempts converged on the same
wrong text, which is what proved the `>` was being *added* rather than *left over*, and is
what led to the `autoSurround` probe. A retry loop that hid a deterministic defect would have
been exactly the kind of green this project does not accept.

`files.spec.ts`'s assertions are unchanged. Two are *phrased* differently because the thing
they named is gone: `toBeEnabled()` on a textarea becomes the read-only sentence being hidden
plus a write landing, and `toHaveValue()` becomes an exact read of the model — which is what
keeps the trailing newline in the fixture rather than forcing it out.

## T16 — the documents

**Tests:** none, and none pretended — this is prose.

`IMPLEMENTATION_PLAN.md` §0 (status, suite counts, **both** inherited findings closed), §4's
Slice 7 entry, and §9's F5.1, F6.1 and F6.3 rows. `PRODUCT_SPEC.md` §7.1's Monaco row marked
installed with the pin and its reason.

## Deferred

Written down rather than built, because the plan does not cover them:

- **A tab the generation opened, left open by a stream that ended in `error`.** `file_start`
  opens a tab and creates no buffer (P1); only `done` reaches `applyGenerationFiles`, so a
  stream that fails afterwards leaves a tab over a file the session has never read. The store
  refuses to save from it and there is a test pinning that (T8), but nothing closes the tab.
  D11 and P1 both speak only about `done`, so deciding this is out of scope here.
- **`.json` renders as plaintext** (D4) — revisit in Slice 9 if real generations produce JSON
  that matters.
- **Extracting `useProjectFiles` from the store** (D22) — Slice 12's audit.
- **The narrow layout's Chat and Preview tabs** still hand their panels a percentage height,
  exactly as the Code tab did before T14. Neither panel contains anything that measures its
  own container, so neither is broken today; only the Code tab was changed, because only the
  Code tab was in scope.
