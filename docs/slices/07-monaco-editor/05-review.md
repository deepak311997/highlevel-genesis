# Slice 07 — Monaco editor · Review

**Reviewed:** 2026-08-18 · **Branch:** `slice/07-monaco-editor` · **Base:** `main`
**Diff:** 37 files, ~6.4k insertions / ~280 deletions — of which 2,620 are the four slice
documents and 1,147 of those are the generated `02-prd.html`. The code is ~1,850 lines of
source and ~1,900 of tests, across `frontend/` and three files under `tests/e2e/`.

Reviewed as another author's PR, diff-first, against `02-prd.md`'s 31 acceptance criteria.

## Suite

The first five rows are the orchestrator's gate run on `01adfb1`/`16ed110`
(`.autopilot/logs/07/gate-post-build.1.log`), which is what admitted this stage. The
rows marked *re-run* were run again here, after this review's fixes.

| Check | Result |
|---|---|
| `typecheck` | **0 errors** — re-run after the fixes |
| `lint` | **0 warnings** (`--max-warnings 0`, both packages) — re-run after the fixes |
| `test:unit` | **1,506 passed** — 750 functions · **737 frontend** · 19 scripts. 1,501 at the gate; the five added are this review's own, written test-first |
| `test:rules` | **36 passed** (gate) — untouched by this slice, which adds no collection |
| `test:integration` | **292 passed** (gate) — untouched; no route changed |
| `test:e2e` | **16 passed** — re-run in full after the fixes, since three of them are visible only in a browser. The first re-run went **red**, which is finding 3 |
| `npm run build` | **clean**, run here to close two open definition-of-done boxes — see *Manual verification* |

## AC coverage

Walked all 31 against the diff. The build log's own table (`04-build-log.md`) names a test
per criterion; what is below is this review's verification of it — where "read" means I
opened the test and checked it would fail against a broken implementation rather than
merely exist.

| AC | Test | Verified |
|---|---|---|
| AC-1 | `lib/editorLanguage.spec.ts` | ✅ the allowlist restatement matches `functions/src/files/schema.ts:59` exactly, and the coverage case asserts `Object.hasOwn` rather than the return value — so a fall-through to `plaintext` cannot pass as a mapping |
| AC-2 – AC-5 | `lib/editorContent.spec.ts` | ✅ equal/append/replace plus a round trip over the corpus; the append case asserts the suffix, not the document |
| AC-6 – AC-9 | `lib/editorModels.spec.ts` (13 cases) | ✅ project-scoped URIs, reuse, adoption of a model monaco already holds, view state saved *before* the switch, disposal, and a fresh create afterwards |
| AC-10, AC-12 | `components/workspace/CodeEditor.spec.ts` | ✅ the fake model *applies* the edits it is given, so a sequence of appends is meaningful; `setValue` is asserted never called, on model **and** editor |
| AC-11, AC-27, AC-28 | `CodeEditor.spec.ts` | ✅ AC-28 is a real identity assertion — `setModel.mock.instances[0]` is the emitted object, which a deep reactive proxy would not be |
| AC-13 – AC-18 | `stores/workspace.spec.ts`, `EditorTabs.spec.ts` | ✅ including the two negatives that matter: re-activating an open tab and reopening a closed dirty one both issue **no request** (`requests()` asserted empty, not just "content survived") |
| AC-19 – AC-21 | `stores/workspace.spec.ts`, `FileEditor.spec.ts` | ✅ a save is asserted to touch **that** buffer and no other |
| AC-22 – AC-24 | `stores/workspace.spec.ts` | ✅ per-tab refresh, the notice and its two clearing triggers, the dropped closed buffer, and `done` with empty `files` issuing nothing |
| AC-25 | `lib/monacoSetup.spec.ts`, `lib/no-cdn.spec.ts`, **`tests/e2e/editor.spec.ts` (added here)** | ⚠️→✅ the two L1s prove the call and the source; neither could prove the *runtime* claim. See finding 4 |
| AC-26 | `CodeEditor.spec.ts` | ✅ all three states, and the Try again genuinely re-runs the import |
| AC-29 | `lib/deps.spec.ts`, `lib/no-firestore.spec.ts` | ✅ the whole dependency set is asserted, so a third addition cannot arrive unnoticed |
| AC-30, AC-31 | `tests/e2e/editor.spec.ts` | ✅ real bounding boxes at both layouts, `mtk*` class count while the stream is open, and a keystroke Monaco actually refuses |

Two things I checked as claims rather than inferring from the PRD:

- **D21 — nothing server-side changed.** Confirmed against the diff: `firestore.rules`,
  `firestore.indexes.json` and every path under `functions/` are absent from it. The rules
  and integration suites are therefore reported from the gate run unchanged.
- **The data-access rule.** No `firebase/firestore` import anywhere under `frontend/src`
  (`no-firestore.spec.ts` still passes), no new route, no `:uid` or `me` anywhere. This
  slice reads and writes nothing new.

## Findings

Ordered by leverage. The five marked *fixed* were fixed here, test-first — the failing
test before the change, in every case.

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | **Required** (correctness) | **A generation that ends in `error` leaves behind a tab you can type into where the typing goes nowhere.** `file_start` opens a tab and creates **no buffer** (P1), and only `done` reaches `applyGenerationFiles` — which is the only thing that hands that tab back. So a stream interrupted after its first file left an empty editor over a file that may have content, `editContent` silently no-op'd every keystroke (`withBuffer` returns early with no buffer), the byte count read 0 and **Save** stayed dead with nothing on screen to explain any of it. Switching tabs and back then wiped what had been typed, because the store's `''` won. The build log deferred this as "out of scope"; it is one branch away from a rule the store already applies. | **Fixed.** The tail of `applyGenerationFiles` became `closeAutoSelected(written)`, and `runGeneration`'s `finally` calls `closeAutoSelected([])` — a turn that never reached `done` stored nothing by construction. `done` runs first and nulls `autoSelected`, so the second call is a no-op rather than a double close. Two new store cases: the generation's tab is handed back on an errored stream, and the **user's** own tab (dirty) is not. |
| 2 | **Required** (architecture / performance) | **`FileEditor` unmounted the whole editor on every read.** The loading state was a `v-else-if`, so `fileLoading` destroyed `CodeEditor` — and with it the Monaco instance and the entire model registry: every *other* open tab's undo history and scroll position, disposed for a fetch that had nothing to do with them, plus a full editor construction on the way back. It fired on every open of a file this session had not read **and on the re-read that ends every generation**, which is the slice's own demo path. Invisible to the suite: no test existed for `file-editor-loading` at any level, and jsdom would not have shown the cost anyway. It also made the registry's view-state machinery (AC-8) inoperative across exactly the switches it was written for — thirteen L1 cases proving a registry the running app kept throwing away. | **Fixed.** The skeleton now covers the editor instead of replacing it — an `absolute inset-0` overlay inside a `relative` region, which is the pattern `CodeEditor` already uses for its own two states. The footer stays withheld while the read is in flight, so nothing reports "0 bytes" for a file that is still arriving. New L2 case pins that the editor stays mounted. The height chain is unchanged and AC-30 re-measured it in a browser. |
| 3 | **Required** (data integrity) | **A model's line endings were an accident of when it was created.** Monaco guesses a new model's EOL from the text it is created with and falls back to the platform default when there is none — and this registry creates a model when a *tab is activated*, which is before the file's bytes arrive. An empty model can therefore come out **CRLF**, after which every `\n` monaco writes into it becomes `\r\n`: the first keystroke marks the whole document dirty and **Save** stores a file in which every line changed. The old code masked this by accident, because unmounting the editor on every read (finding 2) meant the model was always recreated *after* the content had arrived; the streaming path created its model empty and was rescued by the same unmount at `done`. Finding 2's fix removed the mask, the e2e went red on it — a two-byte difference in a 57-byte file, exactly the class of defect R3 says only L5 can see — and the underlying rule was never stated anywhere. | **Fixed.** `createModelRegistry`'s `model()` now calls `setEOL(EndOfLineSequence.LF)` on every model it hands out, created or adopted; monaco skips the call when the model already agrees, so it is free on the common path. New L1 case with a fake model **born CRLF**, so the assertion cannot pass by tautology. Full e2e re-run green afterwards. |
| 4 | **Required** (test coverage) | **AC-25's runtime half had no test.** `no-cdn.spec.ts` scans `frontend/src`, which is a claim about our source, not about the running app — and the built bundle contains `cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs` regardless, because it is `@monaco-editor/loader`'s own default (verified in `dist/assets/es-*.js`). What makes it inert is `loader.config({ monaco })` having run before the first `init()`, and only a browser can be asked whether that held. A regression here passes every check on a developer's machine and fails on a locked-down network — which the definition of done names as a deliverable. | **Fixed.** `tests/e2e/editor.spec.ts` now collects every request matching the three CDN hosts from before the first navigation and asserts none was made — across mount, colouring, a stream, a save and a reload. |
| 5 | Nit (accessibility) | **The dirty mark announced nothing.** `aria-label="Unsaved changes"` sat on a bare `<span>`; ARIA forbids an accessible name on a generic element, so the attribute is dropped and the one signal a tab you are *not* looking at has to give reached a screen reader as the bullet character or as silence. | **Fixed.** `aria-hidden` on the dot, `sr-only` text beside it — `PasswordField.vue`'s existing pattern. New L2 case. |
| 6 | **Consider** (accessibility) | **The tab strip is a half-built APG tab pattern.** `role="tablist"` + `role="tab"` + `aria-selected` are there, but there is no `role="tabpanel"` for them to control, no `aria-controls`/`aria-labelledby` pair, and no roving `tabindex`/arrow-key navigation — so a screen reader announces "tab, 2 of 3" for a widget that behaves like three buttons. D13's reasons for hand-rolling it are sound; the roles just got ahead of the behaviour. | **Deferred, deliberately.** The move is either to finish it (a `tabpanel` id on the editor region, `aria-controls` from each tab, `aria-labelledby` back to the active one, and ArrowLeft/ArrowRight moving focus) or to drop the roles and present a list of buttons. Half-wiring it here — `aria-controls` alone — would be worse than both. It is a keyboard-and-focus change, which is a change of a different shape from this slice, and it now has a written home: **Slice 12's audit**. |
| 7 | Nit | `editorLanguage` reads its own `satisfies`-typed constant through `(EDITOR_LANGUAGES as Record<string, string>)`, a cast the project's standards discourage. It is load-bearing only against `noPropertyAccessFromIndexSignature`, and `Object.hasOwn` + a `Map` would remove it. | **Not changed.** One cast, on a five-key literal, in a pure function whose spec asserts every key. Removing it buys type-safety this function already has by construction. |
| 8 | FYI | `monacoSetup.ts` publishes `window.monaco`. It is not a test hook smuggled into production — `@monaco-editor/loader`'s CDN path sets it as a matter of course and its `init()` reads it — and it exposes no data, only the editor library. Recorded so a later reviewer does not have to re-derive that. | None. |

### What I checked and did not find

Since a slice-sized diff deserves an account of the negatives:

- **The named hazards hold.** The editor instance is a `shallowRef` with an identity
  assertion behind it, not a comment (D6/AC-28). Streamed chunks are `applyEdits` appends
  with a zero-width end range, never `setValue` — asserted on both objects that could have
  one. Model URIs carry the project id, and `disposeAll` detaches the editor *before*
  disposing, which is what keeps the wrapper's own `onUnmounted` from handing out a
  disposed model.
- **The `applying` guard is real and its test is honest.** The fake model fires the
  wrapper's listener **synchronously from inside `applyEdits`**, which is where monaco
  fires it — a test that delivered the echo a tick later would pass against a component
  with no guard at all.
- **`files.spec.ts` was not loosened.** Its `edited` fixture keeps its trailing newline and
  is compared exactly, read from the model rather than scraped from virtualised DOM. The
  two re-phrased assertions name a textarea attribute that no longer exists; both make the
  same claim about the same window.
- **The store's staleness discipline survived the rewrite.** Every write that lands after
  an `await` is still guarded by `current(gen)`, and the new per-path writes go through
  `withBuffer` on top of it, so a read that lands after its buffer was dropped cannot
  resurrect it.
- **No dependency surprises.** Two additions, both in the PRD, `monaco-editor` pinned
  exactly with a measured reason; the lockfile is committed and not hand-edited; the whole
  dependency set is asserted by a test. `npm audit` reports nothing new for either.
- **Sizing.** `stores/workspace.ts` is 1,065 lines and grew by ~135 net despite the file
  half being rewritten, because the pure logic went to `lib/`. It is at the boundary Step 8
  names, which D22 answers with a date rather than a shrug (Slice 12). No other file is
  near it; `CodeEditor.vue` is 292 lines including a 36-line header that earns its keep.

## Dead code

Step 9's question, decided here rather than asked, since there is nobody to ask:

- **`activate()`'s `path === null → setModel(null)` branch** (`CodeEditor.vue:141`) —
  effectively unreachable in the app, because `FileEditor` renders its empty state instead
  of the editor when nothing is selected. **Kept.** It is three lines, it is covered by a
  test that exercises it directly, and the alternative to a defined "no document" state is
  an editor showing the last file after its tab was closed. Cheap defence against a
  reordering of `FileEditor`'s branches — which finding 2 just did.
- **Nothing else.** The textarea and its `file-editor-input` testid are gone from source and
  from both e2e specs with no residue; `fileContent`/`savedContent` survive only inside one
  doc comment, describing the shape they replaced. `Textarea` the component is still used by
  `MessageComposer.vue`, so it stays in the vendored set. No shims, no `// removed`
  comments, no back-compat branches.

## Manual verification

Two definition-of-done boxes the build session left unchecked as "manual". One of them is
not manual, so it was run:

- **Bundle check — done, passes.** `npm run build` from a clean tree: monaco lands in its
  own chunks (`monacoSetup-*.js` 958 kB / 239 kB gzipped, plus `editor.api-*.js` 2.29 MB)
  and the entry chunk is **10.76 kB**. The sign-in page does not pay for the editor (D20,
  R6). Rollup's "chunks larger than 500 kB" warning is monaco and is expected.
- **`dist` grep — expect one hit, and it is fine.** The definition of done says to grep the
  built output for `jsdelivr`/`unpkg` at ship time. It hits exactly one file:
  `@monaco-editor/loader`'s default `{paths:{vs:'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs'}}`
  inside the vendored loader. It is not ours and it is never used, because
  `loader.config({ monaco })` short-circuits `init()`. **Do not "fix" it at ship time** —
  the meaningful assertion is that no such request is made, and finding 4 added it to the
  e2e.
- **Still owed, and genuinely manual:** `npm run dev` on the emulators from a fresh clone
  **with the network unplugged after install**. The new e2e assertion is strong evidence
  (no CDN request across a full session in a real browser) but it is not the same test.

## Deliberately deferred

- **Finding 6** — the tab strip's ARIA/keyboard pattern → Slice 12's audit, with the two
  end states written down.
- **`useProjectFiles`** (D22) → Slice 12's audit. The reasoning survives review: this slice
  rewrote the file half, and moving it in the same PR would have produced a diff in which
  everything both moved and changed.
- **`.json` renders as plaintext** (D4) → Slice 9, if real generations produce JSON that
  matters. Recorded as a cost in the PRD rather than discovered later, which is the right
  way round.
- **The narrow layout's Chat and Preview tabs** still hand their panels a percentage
  height. Neither contains anything that measures its own container, so neither is broken
  today — but the Code tab was, silently, and these are the same shape. Worth a sweep when
  Slice 10 puts an iframe in one of them.

## Verdict

**Approve.** The change definitely improves code health: it swaps a textarea for the widget
the brief names, and pays for what the swap implies rather than working around it — per-file
models under one editor, an append-edit streaming rule proven as a pure function, a tab
model that makes losing unsaved work structurally impossible, and a height chain that no
longer depends on a percentage resolving. The hazards it names are the ones that would have
bitten, and each is asserted rather than commented.

The four defects found here were all of the kind this project's levels cannot see from where
they sit: one behind a stream that ends the wrong way, one behind a component boundary jsdom
does not measure, one that only a browser could answer, and one — the line endings — that
was being held correct by the accident of the second. Every one of them is now covered by a
test that fails against the old code. The last of the four is also the strongest argument for
this slice's own D23: the L5 was worth its cost twice, once during the build and once here.

Next: `/feature-ship 07`.
