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
