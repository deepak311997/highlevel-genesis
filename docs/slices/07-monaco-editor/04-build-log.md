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
