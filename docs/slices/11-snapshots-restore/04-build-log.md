# Slice 11 — Snapshots & restore · Build log

**Branch:** `slice/11-snapshots-restore` · **Plan:** `03-plan.md` · **PRD:** `02-prd.md` ·
**Started:** 2026-08-18 · **Mode:** fast, unattended

## Preflight

- Branch cut from a clean `main` at `e6dd2d9` (*Slice 07 — Monaco editor*).
- `frontend/node_modules` was stale from before Slice 07 — `monaco-editor` was declared but not
  installed, so the first `npm run typecheck` reported 12 errors and `npm run lint` 93, all of them
  "cannot find module `monaco-editor`". `npm install` in all three workspaces fixed it. **Not a
  pre-existing failure in the code**: after the install, baseline `typecheck`, `lint` and
  `test:unit` (60 files / 786 tests frontend, 21 script tests, functions green) all pass on the
  unmodified branch point.

## Parallelism analysis

The task list is one heavy chain plus six genuinely disjoint lanes, so it is worked as such.

| Lane | Tasks | Files it owns exclusively |
|---|---|---|
| **A** (kept in-session — the chain) | T1, T2, T3, T4, T6, T7, T8, T9, T10 | `functions/src/snapshots/**`, `functions/src/files/handlers*.ts`, `functions/src/messages/handlers*.ts`, `functions/src/generate*.ts`, `functions/src/api/index.ts`, `functions/src/index.spec.ts`, `functions/src/llm/fake*.ts`, `tests/fixtures/llm/reply-alt.json`, `tests/integration/snapshots.spec.ts` |
| **B** | T5 | `firestore.rules`, `tests/rules/firestore.spec.ts` |
| **C** | T11 | `frontend/src/lib/snapshots.ts`, `frontend/src/lib/snapshots.spec.ts`, `frontend/src/lib/files.ts`, `frontend/src/lib/files.spec.ts` |
| **D** | T12 | `frontend/src/lib/snapshotsApi.ts`, `frontend/src/lib/snapshotsApi.spec.ts` |
| **E** | T15 | `frontend/src/components/ui/sheet/**` |
| **F** | T18 | `frontend/src/components/workspace/FileEditor.vue`, `FileEditor.spec.ts` |
| **G** | T20 | `docs/IMPLEMENTATION_PLAN.md`, `docs/PRODUCT_SPEC.md` |
| **H** (wave 2) | T13, T14 | `frontend/src/stores/workspace.ts`, `workspace.spec.ts` |
| **I** (wave 2) | T16, T17 | `frontend/src/components/workspace/SnapshotSheet*.{vue,ts}`, `EditorPanel.vue`, `EditorPanel.spec.ts` |
| **J** (wave 3) | T19 | `tests/e2e/snapshots.spec.ts` |

Lane A stays in-session because T1→T2→T3→T4→T6 is a genuine chain (each task's test needs the
previous task's code) and T8/T9/T10 are its integration surface. Lanes H and I wait on the
interfaces the plan pinned (`snapshotsApi.ts`, the store's six fields, the `sheet` primitive) —
those contracts come from `03-plan.md`, never from a sibling lane. Every commit is made in this
session, in plan order; no subagent runs git.

## Tasks


## Session 2 — the run that finished

The first attempt died having written `functions/src/snapshots/schema.spec.ts` (T1's red step)
and nothing else. That file is **kept**: it is exactly the test T1 asks for, it fails for the
right reason (no `./schema` module), and re-deriving it would have produced the same assertions.
Nothing else was in the working tree.

Baseline re-confirmed on the branch point before any new work: `typecheck` ✓, `lint` ✓,
`test:unit` 786 frontend + 21 script + functions ✓, `test:rules` 38 ✓, `test:integration` 325 ✓.

### Parallelism, as actually run

The lane table above is amended in one place. **T12 was pulled forward and kept in-session**,
out of plan order and deliberately: `frontend/src/lib/snapshotsApi.ts` is the interface where the
store lane and the sheet lane meet, the plan pins it, and the rule is that a contract two lanes
need comes from the plan and never from a sibling. Landing it first unblocked both rather than
serialising them behind each other. Its commits are therefore the branch's first two.

| Lane | Tasks | Files it owns exclusively |
|---|---|---|
| **A** (in-session — the chain) | T12, T1, T2, T3, T4, T6, T8, T9, T10, T19 | `functions/src/snapshots/**`, `functions/src/files/handlers*.ts`, `functions/src/messages/handlers*.ts`, `functions/src/generate*.ts`, `functions/src/api/index.ts`, `functions/src/index.spec.ts`, `frontend/src/lib/snapshotsApi*.ts`, `tests/integration/snapshots.spec.ts`, `tests/e2e/snapshots.spec.ts` |
| **B** | T5 | `firestore.rules`, `tests/rules/firestore.spec.ts` |
| **C** | T7 | `functions/src/llm/fake.ts`, `fake.spec.ts`, `tests/fixtures/llm/reply-alt.json` |
| **D** | T13, T14 | `frontend/src/stores/workspace.ts`, `workspace.spec.ts` |
| **E** | T11, T15, T16, T17 | `frontend/src/lib/snapshots*.ts`, `frontend/src/lib/files*.ts`, `frontend/src/components/ui/sheet/**`, `SnapshotSheet.*`, `EditorPanel.*` |
| **F** | T18 | `frontend/src/components/workspace/FileEditor.vue`, `FileEditor.spec.ts` |
| **G** | T20 | `docs/IMPLEMENTATION_PLAN.md`, `docs/PRODUCT_SPEC.md` |

Lane A stays in-session because T1→T2→T3→T4→T6 is a genuine chain — each task's test needs the
previous task's code — and T8/T9/T10 are its integration surface, all three writing one spec file.
Emulator-backed suites (`test:rules`, `test:integration`, `test:e2e`) bind fixed ports, so **only
this session runs them**; every lane was told so explicitly. No subagent ran git; every commit
below was made here.

## Tasks

### T12 — the browser's client for the two routes → AC-22

Out of plan order, for the reason above.

- **Red:** `frontend/src/lib/snapshotsApi.spec.ts` — six cases. `listSnapshots` GETs
  `/api/projects/<enc>/snapshots` and unwraps `snapshots`; `restoreSnapshot` POSTs to
  `…/snapshots/<enc>/restore`; **it sends no `body` and no `Content-Type`**; both ids are
  percent-encoded; `changed: false` passes through. Failed on the missing module.
- **Green:** `frontend/src/lib/snapshotsApi.ts`.
- The absent body is the case worth having: the server parses `z.object({}).strict()`, and
  Express's `json()` only parses when a `Content-Type` says to — so `'{}'` plus a header would be
  a body that happens to be empty, which is one refactor away from being a body that is not.

### T1 — the snapshot collections' schemas → AC-5

- **Red:** `functions/src/snapshots/schema.spec.ts`, 17 cases — kept from the first attempt, which
  had written it and died before the implementation. It failed on the missing `./schema` module,
  which is the reason it should have failed for.
- **Green:** `functions/src/snapshots/schema.ts`.
- **Two fixes to the inherited test**, neither of which weakens it. It used
  `const { totalBytes: _dropped, ...without } = snapshot()` to build a document with a field
  missing, which trips `@typescript-eslint/no-unused-vars`; the replacement is a `without(key)`
  helper. The first attempt at that helper used `delete partial[key]`, which trips
  `no-dynamic-delete`; the second builds the object with `Object.fromEntries(...filter(...))`.
  **No lint rule was relaxed** — the expression changed, not the rule.

### T2 — the pure boundary → AC-1 – AC-4

- **Red:** `functions/src/snapshots/plan.spec.ts`, 20 cases. `mergeSnapshotFiles` (the write wins
  and carries its size, the untouched file survives byte for byte, one entry per path, ordered by
  path, and an empty project yields exactly the writes); `planSnapshotSeq` (1, maximum + 1, gaps
  not closed, the maximum rather than the last element); `planSnapshotPrune` (nothing under the cap,
  one at it, three at cap + 2, selection by `seq` and not by position, and the id carried because
  the id is what the batch deletes); `filesEqual` (equal, order-independent, and each of the three
  ways to differ, plus two empty sets).
- **Green:** `functions/src/snapshots/plan.ts`.
- **Refactor:** `planSnapshotPrune` became **generic over its head** (`<T extends SnapshotHead>`).
  Done in T6, where the reason appeared: `planSnapshot` reads the heads *with their document
  references* and needs them back to delete what it selects. With the pinned signature it had to
  look each one up again by id through a `find`, whose "not found" branch is unreachable and
  therefore untestable. The generic is a strict widening — every call the plan pinned still
  type-checks — and it deletes a branch no test could ever cover.

### T3 — `readStoredFiles` and the turn's resulting set → AC-1's caller half

- **Red:** `functions/src/files/handlers.spec.ts`, 10 new cases. `readStoredFiles` reads
  `collection → orderBy('path') → limit(FILE_LIMIT) → get`, returns parsed documents with content,
  and omits both an unparseable document and one filed under an id that is not its path, logging
  once. `planFileWrites` returns `resulting` equal to `mergeSnapshotFiles(stored, writes)` for a
  turn that rewrites one file and adds another; marks the rewrite `exists: true` and the new file
  `false`; and **issues no read at all** for a prose-only turn, for an unterminated block or for an
  incomplete turn — asserted by making `getDb` *throw*, so a call is a failure rather than a
  quietly-served fake.
- **Green:** `readFilePaths` → `readStoredFiles`; `FileWriteOutcome` gains `resulting`;
  `planFileWrites` derives its existing-path set from the documents and calls `mergeSnapshotFiles`
  only when there is something to write.
- **Also:** `generate.spec.ts`'s db fake gained `orderBy` in the chain and lost `select`.
- **P2 confirmed in code**, not just in the plan: the read now omits unreadable documents where the
  ref-counting version counted them. Both consequences are improvements and both are commented at
  the function — the union check counts one fewer, and a rewrite of a corrupt path is planned with
  `exists: false`, so it is written whole and **repaired**.

### T4 — `appendAssistantMessage` takes an `AssistantTurn` → R10

- **Red:** every call site in `functions/src/messages/handlers.spec.ts` rewritten to the object
  form through a `turn(content, overrides)` helper; `generate.spec.ts`'s positional
  `mock.calls[0]?.[2]` / `?.[3]` / `?.[4]` assertions replaced by a named `turnOf(index)` helper.
- **Green:** the new signature, with `snapshot: SnapshotPlan | null` **present and ignored** so T6
  adds a body rather than a parameter.
- **Amendment to the plan, small but worth stating.** T4 cannot reference `SnapshotPlan` unless the
  type exists, and the plan puts `snapshots/handlers.ts` in T6. So T4 creates that file holding
  **only** `SnapshotPlan` and `PrunedSnapshot` — type declarations, no behaviour, no runtime code —
  and T6 appends the four functions. A type alias has no behaviour to fail, so this is the same
  exception the plan already grants T15's vendoring, and the file's first *executable* line still
  arrives with a failing test in front of it.

### T5 — rules for both new collections → AC-20, AC-21 *(lane B)*

- Two deny-all blocks in `firestore.rules`, after the files block: the snapshot document and — the
  one a reader is most likely to assume is covered — its **nested** `files/{fileId}` subcollection.
- `tests/rules/firestore.spec.ts` gained `snapshot()`, `snapshotFile()`, `plantedScript()`,
  `seedSnapshot()` and `seedSnapshotFile()`, plus a `describe` per collection covering get, list,
  create, update and delete for the verified owner, a different verified user and an anonymous
  client. The nested collection's create cases carry hostile JavaScript, which is what R8 is about.
  The prior-denials case gained both new paths. **38 rules cases → 52.**
- **The red step is not achievable, and it was verified rather than asserted.** Firestore's default
  is denial, so the L3 tests pass against a rules file with no block for these paths. Rather than
  take the plan's word for it, the suite was run once with `firestore.rules` reverted to the branch
  point: **all 52 passed**. So the tests do not prove the blocks exist — what they would catch is a
  later rule granting a parent recursively (`match /users/{uid}/{document=**}`), which is exactly
  R8's trap, and the nested block is the half a reader assumes is covered.
- `firestore.indexes.json` is unchanged: the three snapshot queries are `orderBy('seq','desc')`,
  `orderBy('seq','asc').select('seq')` and an unordered subcollection read — single-field or
  index-free (D16).

### T6 — the snapshot on the turn's batch → AC-9, AC-5's `id === path` half

- **Red:** `functions/src/snapshots/handlers.spec.ts`, 20 cases against a recording batch and a
  faked `getDb` — `planSnapshot` reads the heads once, ordered by `seq`, projected to `seq` alone
  and **uncapped** (P3), mints an auto-id, and carries the next seq, the origin, the files and the
  prune with every pruned file reference; `stageSnapshot` writes the five fields, sums `totalBytes`
  from the files' own sizes, stamps a server sentinel, files each copy at an id equal to its path,
  writes a copy as path/content/size and nothing else, deletes a pruned version's **files and then
  the version**, and never commits; `parseSnapshotFile` refuses and logs a mismatch, three corrupt
  shapes, and puts no field of the document in the log.
  Plus three cases in `messages/handlers.spec.ts` for AC-9: the message, the file, the snapshot and
  its copy on **one** batch committed **once**; the prune's deletes on that same batch; and nothing
  extra staged when the turn carries no snapshot. The recording batch gained a `delete` recorder.
- **Green:** `readSnapshotHeads`, `parseSnapshotFile`, `planSnapshot`, `stageSnapshot`;
  `appendAssistantMessage` calls `stageSnapshot` when `turn.snapshot` is non-null; `generate.ts`
  plans the snapshot from `plan.resulting` **inside the branch that also writes the message**, so a
  turn with no prose issues no snapshot read either.

### T7 — `__alt_files` and `reply-alt.json` → D24 *(lane C)*

- **Red:** four cases in `functions/src/llm/fake.spec.ts` — the marker replays `reply-alt.json`,
  the text carries an `about.html` block, its `index.html` block differs from `reply.json`'s, and
  it writes those two paths **and nothing else**. All four failed by falling through to
  `reply.json`.
- **Green:** `tests/fixtures/llm/reply-alt.json` on `prose-only.json`'s skeleton; the marker and its
  `planFor` case in `fake.ts`; the marker table's new row.
- `reply.json` was **not** touched (Slice 6's D26), so nothing that already passed moved. The
  fixture's `index.html` differs by one added `<nav>` line inside `<body>`, which is visible in a
  diff and in the editor — enough for AC-32 to tell the two versions apart on screen.

### T8 — the write path over the wire → AC-6, AC-7, AC-8, AC-10

- **Red:** `tests/integration/snapshots.spec.ts`, 16 cases. AC-6: one version, `seq: 1`,
  `origin: 'generation'`, `fileCount: 3`, `totalBytes` summed from the copies, every copy
  byte-identical to the live document at an id equal to its path, and **no timestamps on a copy**.
  AC-7: `seq: 2`, `fileCount: 4`, the untouched `styles.css` present and equal, and version 1 left
  exactly as it was. AC-8: six markers, each asserting the count is unchanged, plus a project whose
  first turn stores nothing and therefore has no history at all. AC-10: the prune keeps exactly the
  cap, drops the lowest, **takes its file documents with it** (R4) and numbers the new version
  above the highest — and a second case proves a gap does not close (D5).
- **Green:** nothing new — T6 wrote it, which is what the plan predicted. The 16 cases passed on
  the first run.
- **Refactor:** `storedSnapshots`, `snapshotFiles` and `storedFiles` helpers at the top of the spec,
  so every assertion reads as a claim about documents rather than as Firestore.

### T9 — the list route → AC-11, AC-19 (structural)

- **Red:** 10 more integration cases — newest-first by `seq`, the six fields and **no content**,
  ISO-8601 timestamps, an empty list, the cap honoured against a collection of 25, a corrupt version
  omitted, 401, 403, 400 `invalid_id`, 404 for another user's project (with bob's own history
  proved intact) and 404 for a soft-deleted one. Plus structural cases in
  `functions/src/index.spec.ts`.
- **Green:** `readSnapshotList`, `handleListSnapshots`, `functions/src/snapshots/index.ts`, mounted
  after `filesRouter` at both `/` and `/api`.
- **Amendment to the plan.** The plan puts the whole of AC-19's structural assertion in T9,
  including that the router "names `withVerifiedUser` on both routes" and `attested` on the restore.
  The restore route does not exist until T10, so as written T9 could not be green. The assertion is
  **split**: T9 asserts the `GET` carries `withVerifiedUser` and **not** `attested`, and that
  neither path names a user; T10 asserts the restore carries `attested` and that the router guards
  exactly two routes. Every commit stays green and no assertion is lost — the same coverage, in the
  commit that can honestly hold it. For the same reason the router's `attested` constant is declared
  in T10, where its first use is, rather than sitting unused through T9.

### T10 — the restore route → AC-12 – AC-18, AC-19 (behavioural)

- **Red:** 22 more integration cases. AC-12 (equality, the deletion asserted directly rather than
  inferred from a count, the response equal to a fresh `GET …/files`, and `createdAt` surviving a
  merge); AC-13 (the safety snapshot's origin, seq and contents, and **restoring it returns the
  project to the later version** — the undo has an undo); AC-14 (no snapshot, no `updatedAt`
  advanced, `changed: false`, and the files still answered so a caller has one shape to read);
  AC-15 (a project with no files gets its files back and **no** safety snapshot); AC-16 (a short
  subcollection and a corrupt document, both 409 `snapshot_unreadable` with nothing written, and the
  copy saying so); AC-17 (bob's version, a soft-deleted project, a version id from another of
  alice's own projects, a never-existing id, a malformed project id and a malformed version id —
  the last in its own words, per P1); AC-18 (a 20-file version restored over 20 different files);
  AC-19 (401, 403, a body of any kind ⇒ 400 `invalid_body` with nothing written, and `{}` accepted
  because that is what a bodyless request parses as).
- **Green:** `requireSnapshotId`, `snapshotNotFound`, `readSnapshotFiles`, `readSnapshot`,
  `handleRestoreSnapshot` following the plan's ten steps in order; the route added with `attested`.
- **The red step was verified by a control run, not assumed.** The tests and the handler were
  written in one pass, so to prove the assertions bite, the delete loop — R3's named trap — was
  removed and the suite re-run: **AC-12 failed** (`about.html` still present) and **AC-18 failed**
  with exactly the union state R3 predicts, *40 files where 20 were expected*. Restored, green
  again. A restore that writes but does not delete is the failure this slice was most likely to
  ship, and it is now a red test rather than a review catch.

### T11 — the rendered labels → AC-29's label half *(lane E)*

- **Red:** `frontend/src/lib/snapshots.spec.ts` (8 cases) and four `formatBytes` cases in
  `frontend/src/lib/files.spec.ts`. Both failed on a missing export.
- **Green:** `versionLabel`, `originLabel` (a `switch` with **no `default`**, so a third origin is a
  type error rather than a blank cell) and `snapshotSubtitle`; `formatBytes` beside `utf8Bytes`,
  with P7's decimal KB and its `Math.max(1, …)` floor so 1000–1499 bytes cannot render as `0 KB`.
- The lane deliberately did **not** pin `formatBytes(1) === '1 bytes'`: P7's rule produces that
  string, but asserting it would bake in awkward copy for a case the caller cannot reach. The
  0/512/999/1000 boundaries pin the branch instead.

### T12 — the client library → AC-22

Landed first; see *Session 2* above.

### T13, T14 — the store's list, its restore and the tabs → AC-23 – AC-28 *(lane D)*

- **Red (T13):** 11 cases under `the snapshot list` — the loading/loaded lifecycle, the list
  replaced on success, a failure that sets `snapshotsError` and **leaves the existing list in
  place**, the conditional refetch on `done` (only once loaded, and never for a turn that wrote
  nothing), and `reset()`/`open()` returning every field to its initial value with a stale response
  unable to repopulate it.
- **Red (T14):** 12 cases under `restoreSnapshot` — `restoringId` for the length of the request,
  `files` replaced, the history refetched, a failure leaving `files`/`openTabs`/every buffer alone,
  the tab reconciliation (surviving tab re-read, deleted tab closed and dropped, a dirty buffer
  coming back with `replaced` set), and the two guards (`generating`, and a restore already in
  flight) each issuing no request.
- **Committed as one commit**, not two. The two cycles were worked in order inside one 2,500-line
  spec file; splitting the diff afterwards would have put the lane's internal history above the
  branch's, which is the opposite of what per-task commits are for.
- **One judgement call the lane made and flagged, which stands.** `applyRestoredFiles` runs only
  when the response says `changed`. That follows D10 — a no-op restore wrote nothing, so re-reading
  every tab would discard an unsaved edit for a change that never happened. The file list and the
  history refetch happen either way, which is what AC-24 asks for unconditionally. Pinned by
  `leaves every tab and buffer alone when nothing changed`.
- **The refactor came out cleanly**, so it was taken: `rereadTab(path, id, gen)` now carries the
  shared "re-read, announce a discarded dirty buffer" body for both `applyGenerationFiles` and
  `applyRestoredFiles`, returning whether the caller should continue. The deleted-tab case stays in
  `applyRestoredFiles` alone, above the shared call — nothing was forced into the helper that only
  one caller has.

### T15 — the `sheet` primitive *(lane E)*

- **The CLI reached the network**, so provenance is upstream's:
  `npx shadcn-vue@latest add sheet --yes --overwrite`. Nine files under
  `frontend/src/components/ui/sheet/`. **Hand-vendoring was not needed**, so R9's fallback did not
  fire.
- Four deviations from what the CLI emitted, each commented in place and each with precedent in
  `ui/dialog/`: omit-`undefined` prop forwarding in the five components that use
  `useForwardPropsEmits` (`exactOptionalPropertyTypes` treats a key valued `undefined` as different
  from an absent one); an `sr-only` "Close" label on `SheetContent`'s close button, which upstream
  ships as an icon with no accessible name; an explicit `sheetVariants({ side: props.side })`
  binding; and Prettier's formatting. `Sheet.vue` is byte-identical to upstream and to
  `ui/dialog/Dialog.vue`.
- **The CLI installed a package and it was reverted.** It added `@lucide/vue` to
  `frontend/package.json` and rewrote the lockfile; `npm uninstall @lucide/vue` undid both, and
  `git status` confirms **`frontend/package.json` and `frontend/package-lock.json` are unchanged
  from `main`**. The vendored components import `X` from `lucide-vue-next`, as the rest of the
  codebase does. **No new runtime dependency ships with this slice.**

### T16, T17 — the History sheet and its trigger → AC-29, AC-30 *(lane E)*

- **Red (T16):** 14 cases across `the trigger`, `the four states` and `restoring`, on
  `ProjectFormDialog.spec.ts`'s pattern — a `reactive` store stub with `vi.mock('@/stores/workspace')`,
  queried on `document.body` because Reka portals the sheet content.
- **Green:** `SnapshotSheet.vue` — a ghost **History** trigger, `Sheet` with `side="right"` (P9), a
  `SheetTitle` of "Version history", and branches ordered error → loading → rows → empty, which is
  `FileTree.vue`'s rule and matters because a failed *first* request leaves `snapshotsLoaded` false
  and would otherwise render the empty state over an error. `open` and `confirmingId` are local
  `ref`s (D20). Rows sort defensively by `seq` descending with a comment saying why, and the spec
  feeds them ascending to pin it.
- One testid beyond the plan's eleven: `snapshot-restore-error`, because AC-30's restore-failure
  clause had no id in the list.
- **T17's "watch" was decided by running it, and went the no-stub way.** All five `EditorPanel`
  cases pass with the real `SnapshotSheet` mounted: a closed sheet renders no `div` at all — `Sheet`
  is `DialogRoot` (slot only), the trigger is a `<button>`, and the content is portaled only when
  open — so the spec's `findAll('div')` `max-h-` assertion still finds exactly one element. No stub
  was added and no assertion was moved.

### T18 — the origin-neutral replaced notice → AC-31 *(lane F)*

- **Red:** `names neither a generation nor a restore in the replaced notice`, asserting
  case-insensitively against both words. It failed on Slice 6's copy, which said "generation".
- **Green:** P8's sentence — `Replaced by a newer version of this file. Your unsaved changes were
  discarded.`
- The pre-existing `renders the replaced notice` case asserted the old sentence verbatim, so it was
  updated to the new one **in full**. That strengthens it: it now pins the whole sentence where it
  used to pin a fragment. Nothing was weakened or deleted.

### T19 — end to end → AC-32

- **Red:** `tests/e2e/snapshots.spec.ts`, one test in six movements — empty history on a fresh
  project; two generations, the second `__alt_files`; the history showing two rows newest-first
  with their labels, counts and dates; the inline confirm cancelled and then taken; a **third** row
  marked *Before restore*; the tree back to three files with `about.html` gone and the open tab
  showing version 1's bytes again; and all of it surviving a reload.
- **Green:** nothing new, as the plan predicts — T10, T14 and T16 wrote the behaviour and this is
  the level that proves the three of them meet.
- The test compares the editor's contents against a value captured *before* the second generation,
  and asserts in between that the second generation **changed** it — so "it came back" cannot pass
  by the value never having moved.

### T20 — the documents *(lane G)*

- `docs/IMPLEMENTATION_PLAN.md` §0's status table (Slice 11 given its own row), §4's Slice 11 entry,
  and §9's rows for F5.2, F5.3, F6.6 and the shadcn inventory. `docs/PRODUCT_SPEC.md` §7.2's `sheet`
  row marked shipped.
- **Suite counts were deliberately left out**, per the plan: they go in at ship time from the
  orchestrator's own run rather than from a claim. §0's per-slice counts paragraph for Slice 11 is
  the one thing still owed.
- The lane grepped both documents for `onSnapshot`, `:uid`, `/me` and "client SDK" and found **no
  contradiction** with the API-only or no-uid-in-routes rules near its edits.

## Suite

Measured on this branch after the last commit. The baseline column is `main` at `e6dd2d9`, measured
the same way — the functions figure from a clean worktree of `main` rather than inferred.

| Suite | Baseline | Now | Added |
|---|---|---|---|
| `test:unit` — functions | 39 files / 922 | 42 files / **1000** | +3 files, +78 |
| `test:unit` — frontend | 60 files / 786 | 63 files / **843** | +3 files, +57 |
| `test:unit` — scripts | 3 files / 21 | 3 files / **21** | — |
| `test:rules` | 1 file / 38 | 1 file / **52** | +14 |
| `test:integration` | 15 files / 325 | 16 files / **373** | +1 file, +48 |
| `test:e2e` | 16 | **17** | +1 |

`typecheck` (functions, frontend, root) and `lint` (functions, frontend) both clean, zero warnings.

## AC coverage — every criterion, and the passing test that proves it

| AC | Level | Test |
|---|---|---|
| AC-1 | L1 | `snapshots/plan.spec.ts` › `mergeSnapshotFiles` (5 cases); `files/handlers.spec.ts` › *returns the merge of what is stored with what the turn wrote*, *issues no read and resolves to an empty resulting set for a prose-only turn* |
| AC-2 | L1 | `snapshots/plan.spec.ts` › `planSnapshotSeq` (4 cases) |
| AC-3 | L1 | `snapshots/plan.spec.ts` › `planSnapshotPrune` (5 cases) |
| AC-4 | L1 | `snapshots/plan.spec.ts` › `filesEqual` (6 cases) |
| AC-5 | L1 | `snapshots/schema.spec.ts` (17 cases); `snapshots/handlers.spec.ts` › *refuses and logs a document whose path disagrees with its id* |
| AC-6 | L4 | `snapshots.spec.ts` › *a generation that stores files* (4 cases) |
| AC-7 | L4 | `snapshots.spec.ts` › *a second generation that rewrites one file and adds another* (3 cases) |
| AC-8 | L4 | `snapshots.spec.ts` › *a turn that stores no files* (6 markers + the never-generated case) |
| AC-9 | L1 | `messages/handlers.spec.ts` › *stages the message, the files, the snapshot and its copies on one batch*, *stages the prune on that same batch…*, *stages nothing for the history when the turn carries no snapshot* |
| AC-10 | L4 | `snapshots.spec.ts` › *keeps exactly the cap, drops the lowest, and takes its files with it*, *numbers the new version above the highest, gap or no gap* |
| AC-11 | L4 | `snapshots.spec.ts` › `GET …/snapshots` (10 cases) |
| AC-12 | L4 | `snapshots.spec.ts` › *restoring an earlier version* (3 cases) |
| AC-13 | L4 | `snapshots.spec.ts` › *the safety snapshot* (2 cases) |
| AC-14 | L4 | `snapshots.spec.ts` › *restoring the version the project already is* (2 cases) |
| AC-15 | L4 | `snapshots.spec.ts` › *writes the version's files and takes no safety snapshot* |
| AC-16 | L4 | `snapshots.spec.ts` › *a version that cannot be read whole* (3 cases) |
| AC-17 | L4 | `snapshots.spec.ts` › *a version that is not this caller's to restore* (6 cases); *answers 404 for another user's project, and leaves it alone* |
| AC-18 | L4 | `snapshots.spec.ts` › *ends with exactly the version's twenty files* |
| AC-19 | L1 + L4 | `index.spec.ts` › *does not attest the snapshot list…*, *attests the snapshot restore*, *guards both snapshot routes with withVerifiedUser*, *names the resource and never the user…*; `snapshots.spec.ts` › *the restore route's guards* (4 cases) and the list's 401/403 |
| AC-20 | L3 | `tests/rules/firestore.spec.ts` › the two new `describe`s (15 cases over both collections × three callers × five operations) |
| AC-21 | L3 | `tests/rules/firestore.spec.ts` › *denies a verified owner one operation on every collection*, extended with both new paths |
| AC-22 | L1 | `lib/snapshotsApi.spec.ts` (6 cases); `lib/no-firestore.spec.ts`, unchanged and re-run — its scan covers the new files automatically |
| AC-23 | L1 | `stores/workspace.spec.ts` › *the snapshot list* — *fills the list and marks it loaded*, *is loading while the list request is in flight*, *records a failure and leaves any existing list in place* |
| AC-24 | L1 | `stores/workspace.spec.ts` › *posts the restore, applies the returned list, and refetches the history*, *names the snapshot being restored for the length of the request*, *records a failure and leaves the files, the tabs and every buffer alone* |
| AC-25 | L1 | `stores/workspace.spec.ts` › *re-reads a surviving tab, closes a deleted one, and announces the discard*, *re-reads a clean surviving tab without the notice*, *drops every closed-but-buffered file…* |
| AC-26 | L1 | `stores/workspace.spec.ts` › *issues no request while a generation is open*, *issues no second request while a restore is already in flight* |
| AC-27 | L1 | `stores/workspace.spec.ts` › *refetches the list on a done that wrote files, once it has been loaded*, *issues no snapshot request on a done when the sheet was never opened*, *issues no snapshot request on a done that wrote nothing* |
| AC-28 | L1 | `stores/workspace.spec.ts` › *returns every snapshot field to its initial value on reset*, *returns them to their initial value when another project is opened*, *does not render the previous project's history*, *does not apply a restore that lands after another project was opened* |
| AC-29 | L1 + L2 | `lib/snapshots.spec.ts` (8 label cases); `SnapshotSheet.spec.ts` › `the trigger` (3) and `the four states` (5); `EditorPanel.spec.ts` › *renders the History trigger in its header* |
| AC-30 | L2 | `SnapshotSheet.spec.ts` › `restoring` (6 cases) |
| AC-31 | L2 | `FileEditor.spec.ts` › *names neither a generation nor a restore in the replaced notice*, *renders the replaced notice* |
| AC-32 | L5 | `tests/e2e/snapshots.spec.ts` › *two generations, a restore, and all of it survives a reload* |

**No AC is unmapped, and no AC is mapped to a test that does not pass.**

## Amendments to the plan

Three, all recorded above at the task that made them and none of them a redesign.

1. **T4 creates `snapshots/handlers.ts` holding only two type declarations**, because it cannot name
   `SnapshotPlan` otherwise and the plan places that file in T6. No runtime code; T6 appends every
   function, each behind a failing test.
2. **AC-19's structural assertion is split across T9 and T10**, because as written T9 asserts a
   router shape only T10 provides and so could not have been green. Same coverage, in the commits
   that can honestly hold it.
3. **`planSnapshotPrune` is generic over its head type.** A strict widening that keeps every pinned
   call site and removes an unreachable, untestable branch from `planSnapshot`.

Two further departures worth naming, neither a change to the plan:

- **T12 was worked first**, out of order, because it is the interface two lanes meet at.
- **T13 and T14 share one commit**, for the reason given at that task.

## Deferred

Nothing. Every task in the plan is done, and no work was found that the plan does not cover.

One item is **owed at ship rather than deferred**: `docs/IMPLEMENTATION_PLAN.md` §0's per-slice
suite-counts paragraph for Slice 11. The plan puts it at ship time deliberately, from the
orchestrator's own run rather than from a claim — the numbers are in the *Suite* table above.

## Manual verification

Not performed: this session is unattended and has no browser to drive by hand. The plan's twelve
manual steps are covered mechanically — steps 3–10 and 12 by `tests/e2e/snapshots.spec.ts`, step 11
by `SnapshotSheet.spec.ts` › *disables every Restore during a generation, with the reason on screen*.

<!-- build-complete -->
