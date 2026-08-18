# Slice 10 — Live preview · Build log

**Plan:** `03-plan.md` (approved) · **Branch:** `slice/10-live-preview` · **Started:** 2026-08-18

## Baseline, measured before the first line was written

Branch created from a clean, up-to-date `main` (`99fd881`). The whole suite was run first,
because the definition of done requires the L3 and L4 case counts to be *measured against
`main`* rather than assumed (D19).

| Suite | Result on `main` |
|---|---|
| `typecheck` | pass |
| `lint` | pass |
| `test:unit` | 43 + 60 + 3 files, **1051 + 786 + 21 = 1858 tests** passed |
| `test:rules` | 1 file, **38 tests** passed |
| `test:integration` | 16 files, **329 tests** passed |

No pre-existing failure. The rules and integration counts are the numbers the definition of
done compares against at the end; this slice must leave both unchanged.

## Parallelism analysis

The plan's thirteen tasks are ordered but not a single chain. Read against the file map, four
disjoint file sets fall out, so wave 1 ran as four concurrent lanes and wave 2 as two. The
orchestrator kept every git operation, every cross-lane contract and every genuinely
sequential chain.

| Wave | Lane | Tasks | Files owned exclusively |
|---|---|---|---|
| 1 | A | T1, T2 | `lib/api.ts`, `api.spec.ts`, `apiClient.ts`, `authApi.ts`, `generateApi.ts`, `previewBridge.ts`, `previewBridge.spec.ts` |
| 1 | B | T3, T4 | `lib/previewShim.ts`, `previewShim.spec.ts` |
| 1 | C | T7 | `stores/workspace.ts`, `workspace.spec.ts` |
| 1 | D | T13's refactor | `tests/e2e/helpers.ts`, `tests/e2e/highlevel.spec.ts` |
| 2 | E | T5, T6 | `lib/previewDocument.ts`, `previewDocument.spec.ts` |
| 2 | orchestrator | T8, T9 | `stores/preview.ts`, `preview.spec.ts` |
| 3 | orchestrator | T10–T12 | `components/workspace/PreviewPanel.vue`, `PreviewPanel.spec.ts` |
| 3 | orchestrator | T13 | `tests/e2e/preview.spec.ts` |

Why the waves split where they do: T2's bridge needs `ApiError.code` from T1 (same lane, run
in sequence); T5's assembler imports `buildShim` from T3's module, so it cannot start until
lane B lands. T8–T12 are one chain — a store refined across two tasks, then a component whose
tests are all asserted through it — and stay with the orchestrator rather than being split to
look parallel.

Commits are made by the orchestrator alone, one per task, named for the task. Because lanes
land together rather than in plan order, the commit order is lane-landing order within each
wave; each commit still carries exactly one task's test and implementation.

---

## Tasks

### T13 (refactor step) — `connectHighLevel` extracted · lane D

Landed first, ahead of its task number, because it is an independent lane and the new e2e
suite needs it. Pure extraction: `tests/e2e/helpers.ts` gains `connectHighLevel(page)` —
the Connect click, the fake authorize page's `#approve`, the redirect back to `/dashboard`
and the location's name — and `highlevel.spec.ts` calls it in place of the inline block.
The five moved assertions are byte-identical and nothing that spec claims changed. The
second test there (`declining at HighLevel…`) keeps its own inline block: it clicks
`#deny`, which is a different path.

**Tests added:** none — a refactor with existing coverage. `tsc --noEmit` and `prettier
--check` both clean. Commit `d3bcca6`.

### T1 — `ApiError` carries `code` and `detail` → AC-22 · lane A

**Red:** five cases in `frontend/src/lib/api.spec.ts` under `describe('errorForResponse')`
— the envelope's code and detail, the fallback message, the 429 sentence, both fields
absent, and a non-JSON body. All five failed with `errorForResponse is not a function`.

**Green:** `messageForResponse` deleted and replaced by `errorForResponse(res)`, returning
the typed error; `ApiError` gained `readonly code: string | undefined` and `detail`,
assigned from two optional constructor parameters. The three call sites became
`throw await errorForResponse(res)`.

**Deviation from the plan, deliberate:** the plan's sketch has the 429 branch return before
reading the body. It cannot: `Response.json()` may only be called once, and a throttled
response still carries an envelope worth lifting. The body is read once, before any branch,
and the message is chosen afterwards — so the 429 sentence is byte-identical to what it was
and `code` survives it. The four existing `Too many attempts` assertions in
`apiClient.spec.ts`, `generateApi.spec.ts`, `hlApi.spec.ts` and `authApi.spec.ts` stayed
green untouched, which is the proof the change is additive.

`prettier --write` on `authApi.ts` also removed a pre-existing stray double blank line.
Commit `dcf5f40`.

### T2 — `previewBridge.ts`, the acceptance gate and broker → AC-17, AC-18 · lane A

**Red:** eleven cases in a new `frontend/src/lib/previewBridge.spec.ts` — the previous
build's nonce, a foreign `event.source`, an `it.each` of six malformed shapes (no `id`,
unknown `kind`, `DELETE`, non-string `path`, the host's own tag echoed back, `v: 2`), the
happy path, a rejecting proxy, a non-`ApiError` rejection, and an error report. First run
failed at import resolution.

**Green:** `readPreviewMessage` as the single parse point and `handlePreviewMessage` as the
dispatcher, short-circuiting on `ctx.frame === null || event.source !== ctx.frame` before
reading anything. `PreviewMessage` is a discriminated union on `kind`. The failure reply
uses the `code === null ? {} : { code }` conditional spread that mirrors
`functions/src/lib/errors.ts`.

**Two additions beyond the plan, both recorded rather than silent:** an eleventh case for
the non-`ApiError` rejection branch, which the plan's list left unexercised; and the reply
shapes asserted as explicit object literals rather than by calling the exported builders,
so the assertions pin the wire shape instead of restating the implementation. The lane also
verified the AC-17 gate is real by mutating the nonce comparison and watching exactly one
case go red. Commit `fae4a7e`.

### T3, T4 — the shim → AC-9 … AC-16 · lane B

**Red:** fourteen cases in a new `frontend/src/lib/previewShim.spec.ts`, all evaluating the
shim for real with `new Function('window','document','parent', src)` over stubbed globals.
T3's nine (the two `encodeAssets` round-trip cases, the four request-path criteria, the
no-`<` invariant, the exported limits) failed at import resolution; T4's five failed for
the right reasons afterwards — the two call cases timed out because nothing refused or timed
out yet, and the three report cases posted nothing because no listener was registered.

**Green:** `encodeAssets`, `buildShim`, `HL_CALL_LIMIT`, `HL_TIMEOUT_MS`, and the shim
source verbatim from the plan's appendix.

**Three deviations, all deliberate.** (1) Fake timers cover the whole suite rather than
only AC-14: several cases leave a call deliberately pending, and each pending call arms a
30-second timer that would otherwise reject unheard after the run. (2) The timeout message
interpolates `HL_TIMEOUT_MS / 1000` rather than hardcoding "30", so the number is derived
rather than doubled. (3) **The nonce literal goes through the same `<`-escape as the
assets.** The plan escaped only the assets; escaping both makes the no-`<` invariant a
property of `buildShim` for *any* input rather than one conditional on the nonce's alphabet,
and the spec asserts it with a `</script>`-bearing asset too. Commit `c285f65`.

### T7 — the workspace store's two signals → AC-23, AC-24 · lane C

**Red:** nine cases in `frontend/src/stores/workspace.spec.ts` — the ordering case (both
counters 0 while the `GET .../files` is an unresolved `deferred()`, 1 once it settles), a
`done` that stored no file, a stream that errored, an abort, a generation whose project was
left mid-refetch, a successful save, a failed save, `reset()`, and opening another project.
Red was 9 failed / 101 passed, each failing as `expected undefined to be …`. Green is
110/110, with no existing case touched.

**Green:** two refs on the store, incremented together in `applyGenerationFiles` after
`loadFiles()`; `filesRevision` alone in `saveFile`; both zeroed in `clearFileState()`.

**Deviation from the plan's snippet:** the plan nests the increments inside
`if (written.length > 0) { await loadFiles(); if (!current(gen)) return; … }`, which leaves
the pre-existing `if (!current(gen)) return` on the next line as a literal duplicate. The
predicate is hoisted instead — `const wroteFiles = written.length > 0`, one guard, then the
increments behind it. Same semantics, no dead line; the mid-refetch case pins the guard.
Commit `4d1ace2`.

### T5, T6 — `previewDocument.ts` → AC-1 … AC-8 · lane E

**Red:** ten cases for T5 (both no-entry-point causes, the doctype prepended and not
doubled, the CSP-then-shim order in `<head>`, the CSP meta ahead of the shim, a source with
no `<head>`, a fragment with neither `<html>` nor `<head>`, the nonce baked into the shim,
and no warnings for a document that references nothing), all failing at import resolution.
Nine more for T6, of which six failed against a non-rewriting assembler and three passed
vacuously — the lane recorded which three and why, rather than counting nineteen as red.

**Green:** `assemblePreview`, the `CSP_META`/`DOCTYPE` constants, `injection`,
`insertionPoint`, and the scanner with one `rewriteReference` closure holding the absolute /
bare / missing decision.

**Two deviations, both deliberate.** (1) **One combined pass instead of two.** Running the
`<link>` regex and then the `<script>` regex numbers every stylesheet before every script,
which breaks AC-3's document order. Both plan-specified regexes are kept verbatim and
composed into one alternation so a single ordered pass drives them. (2) **The plan's
`<meta charset>` note is false and was not written as briefed.** `buildShim` is ~2545
characters even with no assets, so a generated `<meta charset>` after the injections sits
around byte 2600 — *outside* the 1024-byte window a parser scans, not inside it. The header
comment says the accurate thing instead: a `srcdoc` document decodes no bytes off a network
and takes its encoding from the container, so the declaration is inert either way. Same
conclusion, honest reasoning. Commit `55c6bca`.

### T8, T9 — `stores/preview.ts` → AC-19, AC-20, AC-21 · orchestrator

Eighteen cases: the two empty causes settled before any read, the parallel fan-out, the
loading state, a failed read and its recovery, a fresh nonce per build, AC-37's clearing, the
generation guard, the two rebuild rules, and the broker's six — the forwarded call, the
refused path with no `fetch` at all, the envelope's `code` reaching both the reply and
`reconnectable`, a non-reconnectable code, a reply suppressed by a mid-flight rebuild, and an
error report.

**The red step could not be observed, and the substitute is recorded rather than glossed.**
This task's spec was written before its implementation, but neither could *run* until lane E
landed `previewDocument.ts` — so the first execution of the spec was already green. Rather
than claim a red that did not happen, five mutations were applied to the finished store and
each was confirmed to kill **exactly one** case:

| Mutation | Case killed |
|---|---|
| Drop the post-await nonce check (the `live` wrapper) | `posts nothing when the build changed while the call was in flight` |
| Drop the AC-37 banner clearing | `clears the warnings, the failure and the runtime error before it starts` |
| Drop `state === 'ready'` from `stale` | `is not stale before anything has been built` |
| Rebuild on `filesRevision` too — the rule D12 forbids | `rebuilds by itself when a generation is applied, and not when only a save moved` |
| Drop the generation guard after the reads | `does not write state for a build whose reads land after the project changed` |

This is weaker than a real red step and is not offered as equivalent; it is what was
available once two lanes met at a module boundary. The lesson for the next slice's plan: a
task whose spec cannot execute until another lane lands is not independent, and should either
share that lane or follow it. Commit `b619298`.

### T10, T11, T12 — `PreviewPanel.vue` → AC-25 … AC-38 · orchestrator

Twenty cases across the four states, the controls and triggers, and the banners.

**Two amendments to the plan, both measured rather than assumed.**

1. **The panel spec must mount with `attachTo: document.body`.** The plan's probe recorded
   `iframe.contentWindow` as "present" in this repo's jsdom; measured again here, that holds
   only for an **attached** iframe. A detached one — which is what `mount()` produces by
   default — has `contentWindow === null`, so the bridge's null-frame guard dropped every
   brokered message and six banner cases failed for a reason that had nothing to do with the
   panel. `attachTo` fixes it; `document.body.innerHTML = ''` in `afterEach` stops one case's
   frame leaking into the next.

2. **The warning banner renders the assembler's sentences as written.** `previewDocument`
   emits a full sentence per missing file (`"<name> is referenced by index.html but is not
   one of this project's files, so it was left out."`), so the panel lists them rather than
   wrapping them in a second sentence of its own.

**The red step could not be observed here either**, for the same cross-lane reason, and the
same substitute was applied — eight mutations against the finished component. Six killed
exactly the cases they should have: `allow-same-origin` added to the sandbox, Refresh left
enabled during a generation, Reconnect offered for every failure, the `message` listener
never installed, the wrong window handed to the bridge, and both empty causes saying the same
thing.

**Two mutations survived, and each produced a real fix rather than a note.**

- *The `message` listener is never removed on unmount* left the suite green. The original
  case dispatched a message after unmounting — but by then the frame is gone too, so the
  bridge drops it whether or not the listener leaked. Replaced with an assertion against
  `removeEventListener`, carrying the exact handler `addEventListener` was given. It now
  fails against that mutation. The leak mattered: the `lg` breakpoint unmounts this panel on
  every resize across it.
- *The `:key` on the nonce is removed* also left the suite green — and here the finding is
  that the `:key` is currently **redundant**, because `build()` passes through `'loading'`,
  which unmounts the frame anyway. A new case asserts the property D3 actually needs — the
  frame **element** is replaced on a rebuild, not renavigated — and its comment records that
  two mechanisms produce it and either alone suffices, so the assertion survives whichever a
  later refactor drops. The `:key` stays: it is free, and it is the mechanism that does not
  depend on the state machine keeping its current shape.

Commit `aa669d8`.

### T13 — the demo, end to end → AC-39 · orchestrator

**Red:** `tests/e2e/preview.spec.ts`, one test — sign up and verify, connect the fake
HighLevel location, create a project, assert the empty state and no frame, arm a
`waitForResponse` on `/api/hl/proxy/contacts/search`, send the prompt, wait for the
generation to end, then assert the frame appears **with no interaction**, the proxied call
landed, the fixture contact's name is readable *inside* the sandboxed frame, and neither
failure banner nor the stale hint is on screen.

**Green:** nothing new — this task is the assembly of T1–T12, and it was green on its first
run.

**R1's fallback was not needed.** Playwright drives frames over CDP rather than through the
DOM, so it reads inside the opaque-origin `srcdoc` document without difficulty. The
`frameLocator` assertion stands as written and nothing was substituted. Commit `5c5cf32`.

**One assertion elsewhere had to change**, and it is the same debt in a second place:
`tests/e2e/workspace.spec.ts:79` asserted the preview panel contained the text "Slice 10",
which was the placeholder's own sentence. It now asserts `preview-empty` — the panel's real
state for a project that has never generated. Nothing else in that spec changed.

---

## Two stale placeholder assertions, found and paid

Slice 4 left the preview panel a labelled placeholder reading "A live preview against your
CRM data arrives in Slice 10", and **two suites asserted that sentence** —
`frontend/src/views/WorkspaceView.spec.ts` and `tests/e2e/workspace.spec.ts`. Both are the
debt this slice exists to pay, so both now assert one of the panel's real states instead.

`WorkspaceView.spec.ts` also needed a Pinia, because the panel it mounts is no longer
storeless. The panel is deliberately **not** stubbed there: two of that suite's cases are
about the layout switch putting three panels on screen at once and one behind a tab, so the
third panel has to be the third panel.

`WorkspaceView.spec.ts` carries a scan asserting that no template anywhere in `src` names
"Slice 6". The equivalent scan for "Slice 10" is **not** added — see *Deferred*.

## The production-build check, automated rather than left manual

The definition of done lists this as a manual check, because D8's rejected alternative —
authoring the shim as a real function and serialising it with `.toString()` — fails *only*
in a production build, where esbuild's `keepNames` wraps functions in `__name(...)`. It was
run here rather than left for the reviewer:

```
npm run build                                                    → exit 0
grep -o "preview-host"      frontend/dist/assets/WorkspaceView-*.js  → 2
grep -c "__name("           frontend/dist/assets/WorkspaceView-*.js  → 0
__genesisAsset 2 · securitypolicyviolation 1 · unhandledrejection 1 · "HighLevel calls" 1
raw "<" anywhere inside the emitted shim source                      → false
```

The shim reaches the bundle intact, unwrapped, and still without a single `<` character —
which is the invariant that makes a generated `</script>` unable to break the document.

---

## Acceptance criteria — every one, with the test that proves it

| AC | Level | Test |
|---|---|---|
| AC-1 | L1 | `previewDocument.spec.ts` · `opens head with the CSP meta and then the shim, ahead of anything generated`; `prepends the doctype when the generated source has none` |
| AC-2 | L1 | `previewDocument.spec.ts` · `replaces a stylesheet link with a loader call carrying the stored CSS` |
| AC-3 | L1 | `previewDocument.spec.ts` · `replaces a script src in place, and numbers the assets in document order` |
| AC-4 | L1 | `previewDocument.spec.ts` · `carries content that would close its own element back out byte-identical` |
| AC-5 | L1 | `previewDocument.spec.ts` · `leaves an absolute, rooted, nested or query-bearing reference exactly as written` |
| AC-6 | L1 | `previewDocument.spec.ts` · `drops a reference to a bare filename the project does not hold, and names it` |
| AC-7 | L1 | `previewDocument.spec.ts` · `carries the CSP meta ahead of the shim script` |
| AC-8 | L1 | `previewDocument.spec.ts` · `reports no entry point when the project has files but no index.html`; `reports no entry point for an empty file list` |
| AC-9 | L1 | `previewShim.spec.ts` · `posts exactly one request carrying the nonce, an id and the three arguments` |
| AC-10 | L1 | `previewShim.spec.ts` · `resolves with the reply data exactly as sent` |
| AC-11 | L1 | `previewShim.spec.ts` · `rejects with an Error carrying the failure message, status and code` |
| AC-12 | L1 | `previewShim.spec.ts` · `ignores a reply carrying an unknown id`; `ignores a reply carrying a different nonce` |
| AC-13 | L1 | `previewShim.spec.ts` · `refuses the call past the limit, names it, and posts it nowhere` |
| AC-14 | L1 | `previewShim.spec.ts` · `rejects a call the host never answers, once the timeout passes` |
| AC-15 | L1 | `previewShim.spec.ts` · `reports an uncaught error once, carrying its text`; `reports an unhandled rejection once, carrying its message` |
| AC-16 | L1 | `previewShim.spec.ts` · `reports a content security policy violation, naming the directive` |
| AC-17 | L1 | `previewBridge.spec.ts` · `ignores a request carrying the previous build's nonce` |
| AC-18 | L1 | `previewBridge.spec.ts` · `it.each` over six malformed shapes — `ignores %s` |
| AC-19 | L1 | `stores/preview.spec.ts` · `forwards an accepted request through the proxy and posts the body back` |
| AC-20 | L1 | `stores/preview.spec.ts` · `refuses a path outside the grammar without issuing a request` |
| AC-21 | L1 | `stores/preview.spec.ts` · `carries the message, status and code of a failed proxy call` |
| AC-22 | L1 | `api.spec.ts` · `carries the code and detail from the error envelope`, and its four siblings |
| AC-23 | L1 | `workspace.spec.ts` · `increments both counters after the file list has settled, and not before`, plus the `done`-with-no-file, error and abort cases |
| AC-24 | L1 | `workspace.spec.ts` · `moves filesRevision and not generationsApplied on a successful save`; `moves neither counter when the save fails` |
| AC-25 | L2 | `PreviewPanel.spec.ts` · `shows a loading state while the files are being read, and no iframe` |
| AC-26 | L2 | `PreviewPanel.spec.ts` · `names the chat box when the project has no files`; `says there is no entry point when the project has files but no index.html` |
| AC-27 | L2 | `PreviewPanel.spec.ts` · `shows the read failure and retries it` |
| AC-28 | L2 | `PreviewPanel.spec.ts` · `renders exactly one sandboxed iframe carrying the assembled document` |
| AC-29 | L2 | `PreviewPanel.spec.ts` · `re-reads every file and rebuilds under a new nonce when Refresh is pressed` |
| AC-30 | L2 | `PreviewPanel.spec.ts` · `disables Refresh while a generation is in progress` |
| AC-31 | L2 | `PreviewPanel.spec.ts` · `rebuilds by itself when a generation is applied` |
| AC-32 | L2 | `PreviewPanel.spec.ts` · `offers a refresh rather than taking one when the files change under it` |
| AC-33 | L2 | `PreviewPanel.spec.ts` · `shows a brokered HighLevel failure` |
| AC-34 | L2 | `PreviewPanel.spec.ts` · `offers Reconnect HighLevel for %s` (both codes); `offers no reconnect for a failure a reconnect would not fix` |
| AC-35 | L2 | `PreviewPanel.spec.ts` · `shows a runtime error reported by the document` |
| AC-36 | L2 | `PreviewPanel.spec.ts` · `names a missing referenced file` |
| AC-37 | L2 | `PreviewPanel.spec.ts` · `clears every banner and the hint when it rebuilds`, and at L1 `stores/preview.spec.ts` · `clears the warnings, the failure and the runtime error before it starts` |
| AC-38 | L2 | `PreviewPanel.spec.ts` · `ignores a message that did not come from its own frame` |
| AC-39 | L5 | `tests/e2e/preview.spec.ts` · `a generated app runs in the preview and reads the connected account` |

**No acceptance criterion is unmapped, and none is mapped to a test that does not pass.**

Beyond the criteria, three cases exist because a mutation showed nothing covered the claim:
`PreviewPanel.spec.ts` · `takes its message listener off the window when it is unmounted`
and `replaces the frame element on a rebuild rather than renavigating it`, and
`previewBridge.spec.ts` · `reports a rejection that is not an ApiError as a status-0 failure`.

## Definition of done

| Item | State |
|---|---|
| Every AC maps to a named, passing test | yes — table above |
| `typecheck` | pass |
| `lint` | pass, zero warnings |
| `test:unit` | pass — 1051 + 883 + 21 = **1955** (was 1858 on `main`; +97) |
| `test:rules` | pass — **38**, unchanged from `main`, measured both ways |
| `test:integration` | pass — **329**, unchanged from `main`, measured both ways |
| `test:e2e` | pass — **17** (was 16; +1, AC-39) |
| No new Firestore collection; `firestore.rules` untouched | `git diff --name-only main -- firestore.rules` is empty |
| No functions change | `git diff --name-only main -- functions` is empty |
| `PreviewPanel` ships loading, empty and error states | AC-25 … AC-27 |
| F8.3: every failure row renders an actionable message; both connection codes offer Reconnect | AC-33 … AC-36, AC-34 |
| No secrets in source; `.env.example` unchanged | `git diff --name-only main -- .env.example` is empty |
| No new dependency | `git diff --name-only main -- frontend/package.json` is empty; `deps.spec.ts` green |
| Production build emits the shim intact | run, results above |
| Runs clean on `npm run dev` from a fresh clone | **not verified in this session** — see below |
| Manual check against the real sandbox account | **not done** — see below |

## Not done in this stage, and why

- **The manual check against real credentials** (generate a dashboard against the live
  sandbox account, then disconnect and confirm the Reconnect banner) is unautomatable and
  needs credentials this session does not have. It stays on the PR checklist, where the PRD
  put it. The emulator-backed equivalents are covered: AC-39 for the happy path, AC-34 for
  both reconnect codes.
- **`npm run dev` from a fresh clone** was not walked. The e2e suite boots the same emulator
  set and the same `--mode emulator` Vite build and is green, which is most of the claim, but
  it is not a fresh clone.

## Deferred — out of this slice's scope, recorded rather than done

- **A scan asserting no template names "Slice 10"**, mirroring the "Slice 6" scan already in
  `WorkspaceView.spec.ts`. Two suites asserted the old placeholder's sentence and both had to
  be found by a failing run; a scan would have named them immediately. Not added because it is
  not an acceptance criterion and the plan does not cover it. Worth one line in Slice 12.
- **Two stale forward-references in prose**: `frontend/src/lib/hlProxyApi.ts` says Slice 10's
  shim "will mirror" the signature — it now does — and `WorkspaceView.vue` says the connection
  badge is "informational until Slice 10". Both files are on the plan's *untouched,
  deliberately* list, so neither was edited.
- **`sonner`/`skeleton` for the three banners and the loading state.** They are hand-rolled
  `Alert`s and a pulse block here, as the PRD's inherited constraint says; Slice 12 introduces
  both and should fold these in rather than leave two idioms.

## Lessons for the next slice's plan

1. **A task whose spec cannot execute until another lane lands is not independent.** T8/T9 and
   T5/T6 met at `previewDocument.ts`, and the cost was two tasks that could not have a real
   red step. Either put them in one lane or sequence them.
2. **A "measured, not assumed" table is worth re-measuring at the point of use.** The plan
   recorded `iframe.contentWindow` as present in jsdom; that is true of an *attached* iframe
   and false of the detached one `mount()` produces, and the difference cost six red cases
   before the cause was clear.
3. **Placeholder text that a test asserts is a tripwire for the slice that removes it.** Both
   occurrences here were found by a red suite rather than by the plan, which listed neither
   file.

<!-- build-complete -->
