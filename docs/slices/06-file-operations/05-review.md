# Slice 06 — File operations · Review

**Branch:** `slice/06-file-operations` · **Reviewed at:** `d8d2809` · **Date:** 2026-08-18
**PRD:** `02-prd.md` · **Plan:** `03-plan.md` · **Build log:** `04-build-log.md`

Reviewed as another author's PR: the whole diff against `main`, read before the suite was
believed. 70 files, +10,018 / −145 — at the edge D33 predicted, and the build order it
promised held: the splitter, the schema, the rules and the batch are all reviewable before
a `.vue` file changes.

## Suite

Baseline from the orchestrator's post-build gate on `d8d2809`
(`.autopilot/logs/06/gate-post-build.2.log`, the run that gated this stage). Not re-run in
full here; the columns after it are the suites this review's own fixes touched.

| Check | Gate at `d8d2809` | After the fixes |
|---|---|---|
| `typecheck` | pass | pass |
| `lint` | pass (0 warnings) | pass (0 warnings) |
| `test:unit` — functions | 742 passed | **750 passed** (+8) |
| `test:unit` — frontend | 631 passed | **635 passed** (+4) |
| `test:unit` — scripts | 15 passed | not touched |
| `test:rules` | 36 passed | not touched |
| `test:integration` | 292 passed | not touched |
| `test:e2e` | 14 passed | not touched |

The e2e flake `04-build-log.md` closes out is not this slice's: it landed on
`auth.spec.ts`, `projects.spec.ts` and `workspace.spec.ts` and never on either slice-06
case, and both harness changes (`globalSetup.ts`'s warm-up, `signUpAndVerify`'s 15 s) are
additions with no assertion weakened. Checked, and agreed with.

`firestore.indexes.json` is unchanged, and the claim was checked **against the query**
rather than against D30: `readFileList` is `orderBy('path').limit(FILE_LIMIT).select(…)` —
one field, no `where`, and `select()` adds no index requirement. `.env.example` unchanged;
no configuration added. No `firebase/firestore` import under `frontend/src`; no
`messages.create` in `functions/src`.

## Findings

Three defects, all fixed test-first. Two of them are the slice's own risk register arriving
where it did not expect to.

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | **Critical** | **A generation's own file selection could get a user's file overwritten with an empty buffer.** `file_start` selects into an empty panel but does not fetch (`workspace.ts`) — the bytes are already streaming. `applyGenerationFiles` re-reads the selection only when it is in `done.files`, and otherwise drops it only when the path is **not** in `files`. So when the stream auto-selected a path the project *already holds* and the turn's ops were then refused (`__bad_path`, `__unterminated`, over-cap), the selection stayed with `fileContent` and `savedContent` both `''`: an empty textarea over a file with content in it. The first keystroke makes it dirty, **Save** enables, and the `PUT` replaces the real file with whatever was typed. R4's failure — "silently overwriting what a user is typing" — reached from the side the risk register did not model. | The store now remembers which path *this generation* selected on the user's behalf and drops it at `done` when the turn stored nothing, putting the panel back where it was. A selection the user made is still never touched, dirty included, and no file request is issued for an empty `done.files` (AC-40). Two L1 cases: the generation's selection dropped, the user's kept with its edit. `9f2fba9`, `ff4e636` |
| 2 | **Critical** | **The splitter's chunking invariance is false for a well-formed tag with an over-long path**, and the failure leaks the generated application into the chat. `couldBeDelimiter` stops holding a partial line once the path passes `PATH_MAX` — it must, or an adversarial reply makes the splitter buffer without limit — but `OPEN_LINE`'s capture was `[^"\n]*`, unbounded. So `<genesis:file path="<70 chars>.js">` opened a block when it arrived in one delta and was prose when it arrived in two. Measured: **11 of 100 split offsets disagreed**, and on those the whole file body reached `token` frames, the chat bubble, and the persisted transcript. This is exactly R1, in the one corner the AC-4 property could not reach — no fixture in the corpus carried a path longer than a name may be. | The corpus gains that fixture, so the existing every-offset property covers it, plus an explicit grammar case at `PATH_MAX` and `PATH_MAX + 1`. `OPEN_LINE`'s capture becomes `[^"\n]{0,PATH_MAX}`: one bound, honoured by the grammar and the hold-back alike. Length is now the one path rule the grammar keeps, and it is not validation — it is the bound that keeps the buffer finite. What a path may otherwise be is still decided once, at the terminal (D8). `d1870e9`, `dfe2c49` |
| 3 | Required | **The file tree was clipped, not scrollable, past about seven rows.** `EditorPanel.vue` capped it with `max-h-56 … overflow-hidden`, and `FileTree.vue`'s inner `ScrollArea` could not take over: it sits in a container whose height is its own content, so it never overflows and never scrolls. At the 20-file cap the panel is meant to hold, thirteen rows were on the page and unreachable. `index.html` sorts first, so the rows that disappear are the ones a user goes looking for. Invisible at every level this project tests at — jsdom computes no layout, and the L4/L5 fixtures write three files, which fit. | `overflow-y-auto` on the element that imposes the cap, which is the one that must scroll; `FileTree`'s `ScrollArea` removed with it, since a scroller that can never overflow is a moving piece with no job. A new `EditorPanel.spec.ts` pins the two classes to one element — a weak assertion, and the honest reason is written into the test: it is what is left when the failure itself cannot be observed at L2. `657b861`, `c316d7b` |
| 4 | Consider | `frontend/src/stores/workspace.ts` is now ~850 lines. D24's "one store, not two" is right and its stated mitigation was honoured — the sort, the merge and the byte count went to `lib/files.ts` with their own L1 tests. But Slice 7 adds Monaco state to the same file and Slice 10 the preview. | Not changed here: the argument for one store is sound and a split now would be relocation rather than reduction. Flagged for Slice 7 — the file half is already a coherent unit and could become a `useProjectFiles` composable the store consumes, which is not a second store. |
| 5 | Nit | Seven files under `functions/src/hl/` are reformatted with no behaviour change — Prettier output in a slice that does not touch HighLevel. `CallbackOutcome`'s union now reads as one line where it was one member per line. | Left alone. Reverting churn is churn; noted so the next reviewer does not go looking for a reason. |
| 6 | FYI | `stageFileWrites` is reachable only through `appendAssistantMessage`, so a turn with `messageText === ''` would silently write no files. Unreachable today — every op emits a `[file: …]` marker token before any content, so an op implies a non-empty message — but the coupling is implicit and AC-10 is the only thing standing under it. | No change. Recorded because the day someone makes the marker conditional, the symptom is files quietly not being written. |
| 7 | FYI | `done.files` is sorted with the default comparator, which matches Firestore's `orderBy('path')` only because `filePathSchema` restricts paths to ASCII. True today, and true for as long as D12 holds. | No change. |

### Dead code — Step 9, decided here

There is no author to ask, so the call is recorded instead of the question.

```
DEAD CODE IDENTIFIED:
- createFileSplitter, CLOSE_TAG, MAX_INDENT, OPEN_HEAD, OPEN_TAIL
  re-exported from functions/src/llm/index.ts — nothing imports any of them
  through the barrel; prompt.ts reaches the three tag constants directly
  from './fileops', and the specs do too
- FileExtension in functions/src/files/schema.ts — derived, never referred to
- FILE_LIMIT in frontend/src/lib/filesApi.ts — mirrored with a reason that
  does not hold
```

**Removed, all three** (`d6fcf99`). The barrel's job is the module's public surface, and
five names with no importer are drift the compiler will not complain about. `FILE_LIMIT`'s
mirror is the interesting one: T14 justified it as letting the editor "disable **Save**
before issuing a request the server would refuse", which is true of `FILE_BYTES_MAX` —
`FileEditor.vue` reads it — and false of the file cap. The client **cannot create a file**:
`PUT` refuses to (D19) and there is no `POST`, so a browser has no path to the twentieth
file and no button to withhold when it gets there. `FILE_LIMIT` belongs where the only
writer that can reach it lives, on the server. The comment now says so rather than
restating a reason that was never about this constant.

`FILE_BYTES_MAX` stays, and so does its L1 pin to the server's number.

## AC coverage

Every criterion in `02-prd.md` maps to a named passing test. Spot-checked rather than taken
from the build log — the rows below are the ones where a test could plausibly have been
written to pass against a broken implementation.

| AC | Test | Verified |
|---|---|---|
| AC-4 (chunking invariance) | `functions/src/llm/fileops.spec.ts` — every fixture at every offset **and** one code unit at a time, frames folded before comparison so the fold is not asserting the opposite of the property | ✅ and **strengthened** — the corpus was missing the over-long-path shape (finding 2) |
| AC-9 (the message invariant) | same file, over all 22 fixtures, `messageText` accumulated *from the emitted frames* | ✅ — invariant by construction, test as regression guard |
| AC-11 – AC-15 | `functions/src/files/opset.spec.ts`, `files/schema.spec.ts` | ✅ — boundary asserted in both directions (64 accepted, 65 refused) |
| AC-16 – AC-25 | `tests/integration/generate-files.spec.ts` | ✅ — the negatives are "no document exists", not "no error was returned" |
| AC-26 – AC-31 | `tests/integration/files.spec.ts` | ✅ — cross-tenant is a 404 on all three routes with bob's file re-read unchanged; `400 invalid_path` proved to precede any Firestore read by asking for a bad path under a project id that does not exist |
| AC-31 (attestation) | `functions/src/index.spec.ts` | ✅ — source scan, and the spec says why: `requireAppCheck` short-circuits under the emulator, so no emulator-backed test can observe it |
| AC-32, AC-33 | `tests/rules/firestore.spec.ts` | ✅ — **denial** for owner, stranger and anonymous across read, list, create, update, delete; the build log records the mutation check (an `allow if uid == uid` block fails six) |
| AC-34 | `functions/src/llm/prompt.spec.ts` | ✅ — the prompt's tag syntax, extensions and both caps are interpolated from `fileops.ts` and `files/schema.ts`, and the spec imports the same constants |
| AC-40, AC-41 | `frontend/src/stores/workspace.spec.ts` | ✅ after finding 1 — the criterion was met; the gap was a state the ACs did not name |
| AC-44 | `FileTree.spec.ts` | ✅ at L2; the layout half is finding 3 |
| AC-48 | `tests/e2e/files.spec.ts` | ✅ — asserts a file row is on screen **while** the `Generating…` badge still is, which is the only place a buffering proxy would be caught, and that an edit survives a reload |

## The Genesis-specific checks

- **Rules before the write.** `firestore.rules` gains the deny-all block for
  `users/{uid}/projects/{projectId}/files/{fileId}` in `1e3a1b1`, the same commit as
  `writeGeneratedFiles`, and ahead of the routes that read the collection. R7 discharged.
- **Nothing partial is persisted.** Traced end to end: `planFileWrites` returns writes only
  when the mapper's own `truncated` is false *and* nothing is unterminated *and* the whole
  set validates; `stageFileWrites` stages onto the batch `appendAssistantMessage` commits,
  so the message and every file land together or not at all. There is no path that writes
  some of a turn's files. F8.1 discharged for this surface.
- **`clientGone` does not suppress the write**, and the implementation reads
  `event.truncated` rather than the forced flag to make that true — a deviation from the
  plan, correctly taken, recorded in T11, and covered by an L1 case because the emulator
  cannot propagate a disconnect.
- **The token boundary.** No file route touches `hlConnections`; nothing added logs a file's
  content — `parseStoredFile` logs `file.unreadable` with no field of the document in it,
  which is right: a file is the user's own application.
- **Path traversal** is refused by the shape of a name, and the encoded forms were measured
  rather than assumed (T12). `requireFilePath` runs before any Firestore call on both routes
  that take a path.
- **Streaming.** No buffering middleware on the SSE path; headers flushed before the body;
  the end-of-input flush's frames are written *before* the terminal frame, which is what
  makes AC-25's "concatenated chunks equal the stored content" true for a reply whose last
  bytes are `</genesis:file>` — the shape a model most often produces.
- **States.** Both new screens ship loading, empty and error. `FileTree` orders error first
  for `ProjectsCard`'s reason, which is right: a failed first request leaves `filesLoaded`
  false and a loading branch above it would render a skeleton forever.
- **Scope.** Nothing in the diff the PRD did not ask for, bar the e2e harness work, which is
  flake remediation and argued in the build log.

## Manual verification

Not performed — this stage runs unattended, with no browser and no sandbox account.

Two things therefore remain hand-checks, and both are already owed:

- **R2 — does the real `claude-opus-5` emit `<genesis:file>` tags?** Every automated test
  drives the fake. In the definition of done and on Slice 13's checklist; unchanged by this
  review.
- **Finding 3's layout.** The fix is reasoned from the CSS and the failure it replaces was
  reproduced by reading, not by rendering: jsdom computes no layout and the e2e fixture
  writes three files, which fit inside the cap either way. The change is safe under both
  readings — if the tree never overflows, `overflow-y-auto` shows no scrollbar and nothing
  moves. **Worth one glance at a project with more than seven files** during the ship demo.

## Deliberately deferred

- Store decomposition (finding 4) — Slice 7, with Monaco's state in hand.
- The `hl/` formatting churn (finding 5) — left as it is.
- A frontend mirror of the file cap — deleted rather than deferred; the client has no path
  to it.
- Everything in the PRD's out-of-scope table: Monaco, the preview, snapshots, project files
  in the model's context, directories, `POST`/`DELETE` on files, optimistic concurrency.

## Verdict

**Approve.** The slice does what its PRD says, and the parts that carry the risk — the
splitter's grammar, the all-or-nothing rule, the batch, the rules, the route guards — are
built the way the decisions argued and tested the way the ACs asked. Two of the three
defects found were in the seams between decisions that are each individually correct, which
is what a wide slice costs; both are fixed with a failing test in front of them.
