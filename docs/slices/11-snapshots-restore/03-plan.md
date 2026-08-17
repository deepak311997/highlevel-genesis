# Slice 11 — Snapshots & restore · Technical plan

**PRD:** `02-prd.md` (approved) · **Branch:** `slice/11-snapshots-restore` · **Mode:** fast ·
**Date:** 2026-08-18

## Approach

A snapshot is a copy of the project's **whole** file set, so the copy is produced by one pure
merge — the files the project already holds, with the turn's writes applied over them — and the
merge, the `seq` allocation, the prune selection and the set-equality check all live in
`functions/src/snapshots/plan.ts` with their own L1 tests, before anything touches Firestore.
`functions/src/files/handlers.ts`'s `readFilePaths` becomes `readStoredFiles` (content included),
which is the one read that feeds both the existing cap check and the new merge; `planFileWrites`
returns the turn's **resulting** file set alongside its writes. The snapshot document, its files
and the prune are *staged* on the batch `appendAssistantMessage` already owns and committed once
with the assistant message and the turn's file writes — so `appendAssistantMessage` takes an
`AssistantTurn` object rather than a sixth positional parameter, and that regrouping lands in its
own commit before any snapshot behaviour rides on it. Restore is a second, symmetrical writer:
one read of the snapshot's files, one read of the project's, one comparison, and one batch that
writes the snapshot's set, deletes everything it does not hold, and stages a safety snapshot of
what was there — all-or-nothing, on both the read side (409 `snapshot_unreadable`) and the write
side (one commit). The browser gets one thin client library, one store extension and one shadcn
`sheet`.

**Alternatives considered.** *Inline `Record<path, content>` on the snapshot document* — lost to
arithmetic: 20 × 100,000 bytes exceeds Firestore's 1,048,576-byte limit, and it would fail only on
the largest projects (PRD D3). *Committing the snapshot in its own batch after the turn's* — one
line shorter and leaves a crash window in which the tree moved and the history did not (D4, R5).
*Keeping the `select()`-only path read and adding a second full read when a snapshot is due* —
the same bytes, one more round trip, two answers to "what does this project hold" (D14).
*Deriving the version number from list position* — pruning renumbers every remaining row (D5).
*A confirmation modal instead of a safety snapshot* — asks the user to be certain rather than
making the mistake survivable, and a modal over a sheet is a second focus trap (D9, D19).

## File map

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/snapshots/schema.ts` | New | `SNAPSHOTS`, `SNAPSHOT_FILES`, `SNAPSHOT_LIMIT`, `snapshotsPath()`, `snapshotFilesPath()`, `snapshotIdSchema`, `snapshotOriginSchema`, `storedSnapshotSchema`, `storedSnapshotFileSchema`, `SnapshotOrigin`, `SnapshotMeta`, `toSnapshotMeta()`, refusal copy |
| `functions/src/snapshots/schema.spec.ts` | New | AC-5 — stored shapes, origin allowlist, `id === path` invariant |
| `functions/src/snapshots/plan.ts` | New, pure | `mergeSnapshotFiles()`, `planSnapshotSeq()`, `planSnapshotPrune()`, `filesEqual()`, `SnapshotHead` |
| `functions/src/snapshots/plan.spec.ts` | New | AC-1 – AC-4 |
| `functions/src/snapshots/handlers.ts` | New | `readSnapshotHeads()`, `planSnapshot()`, `stageSnapshot()`, `readSnapshotList()`, `readSnapshotFiles()`, `requireSnapshotId()`, `snapshotNotFound()`, `handleListSnapshots`, `handleRestoreSnapshot` |
| `functions/src/snapshots/handlers.spec.ts` | New | `stageSnapshot`'s staging shape and the prune, against a recording batch |
| `functions/src/snapshots/index.ts` | New | `snapshotsRouter` — `GET …/snapshots`, `POST …/snapshots/:snapshotId/restore` (attested) |
| `functions/src/api/index.ts` | Edit | Mount `snapshotsRouter` at `/` and `/api`, after `filesRouter` |
| `functions/src/files/handlers.ts` | Edit | `readFilePaths` → `readStoredFiles` (content, `orderBy('path')`); `FileWriteOutcome` gains `resulting: FileWrite[]` |
| `functions/src/files/handlers.spec.ts` | Edit | The renamed read, and `resulting` on each `planFileWrites` outcome |
| `functions/src/messages/handlers.ts` | Edit | `appendAssistantMessage(uid, projectId, turn: AssistantTurn)`; stages the snapshot on the same batch |
| `functions/src/messages/handlers.spec.ts` | Edit | Call sites regrouped; AC-9 — one batch, one commit, snapshot + files + prune all staged on it |
| `functions/src/generate.ts` | Edit | Plans the snapshot from `plan.resulting` and threads it into `AssistantTurn`. No frame, no payload change |
| `functions/src/generate.spec.ts` | Edit | The db fake gains `orderBy` and the snapshots collection; positional-arg assertions become `turn.*` |
| `functions/src/index.spec.ts` | Edit | AC-19 structural — which snapshot route is attested |
| `functions/src/llm/fake.ts` | Edit | `__alt_files` marker → `reply-alt.json` |
| `functions/src/llm/fake.spec.ts` | Edit | The new marker is in `MARKERS` and selects the fixture |
| `tests/fixtures/llm/reply-alt.json` | New | A reply rewriting `index.html` and adding `about.html` (D24) |
| `firestore.rules` | Edit | Two deny-all blocks: `…/snapshots/{snapshotId}` and `…/snapshots/{snapshotId}/files/{fileId}` |
| `tests/rules/firestore.spec.ts` | Edit | AC-20, AC-21 — both collections denied to every client; prior denials re-asserted |
| `tests/integration/snapshots.spec.ts` | New | AC-6 – AC-8, AC-10 – AC-19 |
| `frontend/src/components/ui/sheet/` | New | `Sheet.vue`, `SheetClose.vue`, `SheetContent.vue`, `SheetDescription.vue`, `SheetFooter.vue`, `SheetHeader.vue`, `SheetTitle.vue`, `SheetTrigger.vue`, `index.ts` — vendored |
| `frontend/src/lib/snapshotsApi.ts` | New | `listSnapshots`, `restoreSnapshot`, `Snapshot`, `SnapshotOrigin`, `RestoreResult` |
| `frontend/src/lib/snapshotsApi.spec.ts` | New | AC-22 — method, path, encoding, absent body |
| `frontend/src/lib/snapshots.ts` | New, pure | `versionLabel()`, `originLabel()`, `snapshotSubtitle()` |
| `frontend/src/lib/snapshots.spec.ts` | New | AC-29's label half |
| `frontend/src/lib/files.ts` | Edit | `formatBytes()` beside `utf8Bytes()` |
| `frontend/src/lib/files.spec.ts` | Edit | `formatBytes` cases |
| `frontend/src/stores/workspace.ts` | Edit | Snapshot list + lifecycle, `loadSnapshots()`, `restoreSnapshot()`, tab reconciliation, guards, conditional refetch |
| `frontend/src/stores/workspace.spec.ts` | Edit | AC-23 – AC-28 |
| `frontend/src/components/workspace/SnapshotSheet.vue` | New | Trigger, sheet, loading, empty, error + Retry, rows, inline confirm |
| `frontend/src/components/workspace/SnapshotSheet.spec.ts` | New | AC-29, AC-30 |
| `frontend/src/components/workspace/EditorPanel.vue` | Edit | `<SnapshotSheet />` in the header beside "Code" |
| `frontend/src/components/workspace/EditorPanel.spec.ts` | Edit | AC-29 — the header renders the trigger; existing geometry cases preserved |
| `frontend/src/components/workspace/FileEditor.vue` | Edit | Origin-neutral replaced notice |
| `frontend/src/components/workspace/FileEditor.spec.ts` | Edit | AC-31 — the new copy names neither a generation nor a restore |
| `tests/e2e/snapshots.spec.ts` | New | AC-32 |
| `docs/IMPLEMENTATION_PLAN.md` | Edit | §0 status, §4 Slice 11, §9's F5.2 / F5.3 / F6.6 / shadcn rows |
| `docs/PRODUCT_SPEC.md` | Edit | §7.2's `sheet` row |
| `firestore.indexes.json` | **Unchanged** | D16 — every snapshot query orders by one field or by nothing |

## Interfaces this plan fixes

Written out because the build session follows this literally.

```ts
// functions/src/snapshots/schema.ts
export const SNAPSHOTS = 'snapshots'
export const SNAPSHOT_FILES = 'files'
export const SNAPSHOT_LIMIT = 20

export function snapshotsPath(uid: string, projectId: string): string        // `${projectsPath(uid)}/${projectId}/${SNAPSHOTS}`
export function snapshotFilesPath(uid: string, projectId: string, snapshotId: string): string

export const SNAPSHOT_MISSING = 'That version no longer exists.'
export const SNAPSHOT_UNREADABLE =
  'That version could not be restored: part of it is unreadable. Nothing was changed.'
export const RESTORE_FAILED = 'That version could not be restored. Try again.'

// Its own copy of `projectIdSchema`'s pattern with its own message, so a malformed
// snapshot id and a malformed project id do not share one sentence.
export const snapshotIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'That version could not be found.')

export const snapshotOriginSchema = z.enum(['generation', 'restore'])
export type SnapshotOrigin = z.infer<typeof snapshotOriginSchema>

export const storedSnapshotSchema = z.object({
  seq: z.number().int().min(1),
  createdAt: firestoreTimestamp,
  origin: snapshotOriginSchema,
  fileCount: z.number().int().min(1),   // D27 — a snapshot of nothing is not reachable
  totalBytes: z.number().int().min(0),
})

export const storedSnapshotFileSchema = z.object({
  path: filePathSchema,
  content: z.string(),
  size: z.number().int().min(0),
})

export interface SnapshotMeta {
  id: string
  seq: number
  createdAt: string      // ISO-8601, the project's convention since Slice 2
  origin: SnapshotOrigin
  fileCount: number
  totalBytes: number
}
export function toSnapshotMeta(id: string, stored: StoredSnapshot): SnapshotMeta
```

```ts
// functions/src/snapshots/plan.ts — pure, no Firestore
export interface SnapshotHead { id: string; seq: number }

/** D1. Writes win; untouched files are kept; the result is ordered by path. */
export function mergeSnapshotFiles(stored: readonly StoredFile[], writes: readonly FileWrite[]): FileWrite[]

/** D5. Maximum + 1, or 1 for an empty collection. Gaps do not close. */
export function planSnapshotSeq(heads: readonly SnapshotHead[]): number

/** D6. The `heads.length + 1 - SNAPSHOT_LIMIT` lowest-`seq` heads, or none. */
export function planSnapshotPrune(heads: readonly SnapshotHead[]): SnapshotHead[]

/** D10. Same path set, byte-identical contents. */
export function filesEqual(a: readonly FileWrite[], b: readonly FileWrite[]): boolean
```

```ts
// functions/src/snapshots/handlers.ts
export interface PrunedSnapshot { ref: DocumentReference; fileRefs: DocumentReference[] }

export interface SnapshotPlan {
  /** Minted locally by `planSnapshot`; nothing is read to get it. */
  ref: DocumentReference
  seq: number
  origin: SnapshotOrigin
  files: FileWrite[]
  prune: PrunedSnapshot[]
}

/** Every read the snapshot needs. Nothing is written and nothing is staged. */
export async function planSnapshot(
  uid: string, projectId: string, files: readonly FileWrite[], origin: SnapshotOrigin,
): Promise<SnapshotPlan>

/**
 * D4. Everything staged, nothing committed. Takes **no** `getDb()`: the plan
 * carries the refs, so this function is pure staging and trivially fakeable.
 */
export function stageSnapshot(batch: WriteBatch, plan: SnapshotPlan): void
```

```ts
// functions/src/messages/handlers.ts — R10's regrouping
export interface AssistantTurn {
  content: string
  truncated: boolean
  fileWrites: readonly FileWritePlan[]
  snapshot: SnapshotPlan | null
}
export async function appendAssistantMessage(
  uid: string, projectId: string, turn: AssistantTurn,
): Promise<Message>
```

```ts
// functions/src/files/handlers.ts — D14
export async function readStoredFiles(uid: string, projectId: string): Promise<StoredFile[]>
export interface FileWriteOutcome {
  writes: FileWritePlan[]
  /** D1 — the project's file set as it stands *after* this turn. Empty when `writes` is. */
  resulting: FileWrite[]
  error: FileRejection | null
}
```

```ts
// frontend/src/lib/snapshotsApi.ts
export type SnapshotOrigin = 'generation' | 'restore'
export interface Snapshot {
  id: string; seq: number; createdAt: string
  origin: SnapshotOrigin; fileCount: number; totalBytes: number
}
export interface RestoreResult { files: FileMeta[]; changed: boolean }
export async function listSnapshots(projectId: string): Promise<Snapshot[]>
export async function restoreSnapshot(projectId: string, snapshotId: string): Promise<RestoreResult>
```

```ts
// frontend/src/stores/workspace.ts — added to WorkspaceStore
snapshots: Ref<Snapshot[]>
snapshotsLoading: Ref<boolean>
snapshotsLoaded: Ref<boolean>
snapshotsError: Ref<string | null>
/** The snapshot a restore is in flight for, or null. Disables every row's Restore. */
restoringId: Ref<string | null>
restoreError: Ref<string | null>
loadSnapshots: () => Promise<void>
restoreSnapshot: (snapshotId: string) => Promise<void>
```

**`restoreSnapshot`'s algorithm**, in order, because each step's position is load-bearing:

1. `requireProjectId(req)` — a malformed id costs no Firestore call.
2. `requireSnapshotId(req)` — the same, one segment deeper.
3. `parseBody(z.object({}).strict(), req)` — a body carrying anything is 400 `invalid_body`.
4. `readProject(uid, projectId)` — `null` ⇒ 404 `not_found` (absent, soft-deleted, unreadable and
   someone else's collapse into one answer).
5. The snapshot document — unparseable or absent ⇒ 404 `snapshotNotFound()`.
6. `readSnapshotFiles(uid, projectId, snapshotId, stored.fileCount)` — any file that fails to
   parse, or fewer documents than `fileCount`, ⇒ **409 `snapshot_unreadable`**, nothing written.
7. `readStoredFiles(uid, projectId)` — the project's current set, content included.
8. `filesEqual(current, snapshotFiles)` ⇒ answer `{ files: current.map(toFileMeta), changed: false }`
   with **no batch at all** (D10). `readStoredFiles` orders by path, so this needs no second read.
9. Otherwise one batch: the safety snapshot (`planSnapshot(..., current, 'restore')` +
   `stageSnapshot`) **only if `current.length > 0`** (D9); `stageFileWrites` for every snapshot
   file, with `exists` from the current path set so a rewrite merges and keeps `createdAt`;
   `batch.delete` for every current path the snapshot does not hold (D7). One `commit()`.
10. `readFileList(uid, projectId)` — re-read, because `serverTimestamp()` is a sentinel until it
    commits — and answer `{ files, changed: true }`.

`FILE_LIMIT` is never exceeded at any point (AC-18) because the writes and the deletes are in one
batch: the union state never exists.

## Decisions this plan makes that the PRD left to the build

Recorded here rather than in a commit message, because no human is in the loop.

| # | Question | Decision | Why |
|---|---|---|---|
| P1 | Copy for a **malformed** snapshot id | `That version could not be found.`, code `invalid_id`, 400 | `requireProjectId`'s exact shape one segment deeper. The PRD's copy table names only the *unknown* snapshot (`That version no longer exists.`); a malformed id must not read as a different failure class than a malformed project id does. |
| P2 | `readStoredFiles` omits **unreadable** file documents, where `readFilePaths` counted them | Accepted, and it is the PRD's own position ("a copy of a document nothing can read would be a copy of nothing") | Two consequences the build must not trip on: the `FILE_LIMIT` union check counts one fewer, and a rewrite of a corrupt path is staged with `exists: false`, so it is written whole and **repaired**. Both are improvements; a comment in `readStoredFiles` says so. |
| P3 | `readSnapshotHeads` reads without a `limit()` | Yes | `planSnapshotPrune` must be able to see an already-broken invariant (AC-3's `SNAPSHOT_LIMIT + 2` case). The collection is bounded to ~20 by the prune itself, and the read is `select('seq')` — refs and one number. |
| P4 | `stageSnapshot` takes `(batch, plan)` and never calls `getDb()` | Yes | The plan already carries the new snapshot's `DocumentReference` and every pruned ref, and `DocumentReference.collection()` reaches the files. It makes AC-9's recording-batch test a batch fake rather than a whole Firestore fake. |
| P5 | The sheet fetches on **every** open, not only the first | Yes | D21 says "fetched when the sheet opens"; `snapshotsLoaded` gates the *`done`* refetch (D21, AC-27), not the open. Re-opening after a generation must not show a stale list. |
| P6 | On a restore, buffers for **closed** files are all dropped | Yes | `applyGenerationFiles` drops the closed buffers a generation rewrote; a restore potentially rewrites or deletes everything, so the equivalent set is "all of them". The next open fetches the server's copy, which is the same guarantee, reached the same way. |
| P7 | `formatBytes` uses decimal KB | `< 1000` ⇒ `N bytes`; otherwise `Math.round(n / 1000) KB`, minimum `1 KB` | `fileErrorCopy` already renders `FILE_BYTES_MAX / 1000` as "100 KB", so decimal KB is this codebase's existing unit. The PRD's own examples — 14022 → "14 KB" — agree. |
| P8 | The replaced-notice copy | `Replaced by a newer version of this file. Your unsaved changes were discarded.` | Origin-neutral (D22) and one sentence shorter than Slice 6's, which said "to this file" twice over. |
| P9 | Sheet side | `right` | D17: it slides in from the side of a three-panel workspace rather than covering it, and the code panel — where the trigger lives — is on the right. |

## Task list

Ordered as D29 requires: the pure boundary first, then the batch and its rules, then the routes,
then the client library, then the store, then the sheet. Every task leaves the suite green.

### T1 — The snapshot collections' schemas → AC-5
- **Red:** `functions/src/snapshots/schema.spec.ts` — a valid stored snapshot parses; `origin: 'manual'`,
  `seq: 0`, `fileCount: 0` and a missing `totalBytes` each fail; a valid stored snapshot file parses;
  `snapshotFilesPath()` composes four segments from `snapshotsPath()`; `toSnapshotMeta` renders both
  timestamps as ISO-8601 and carries no content.
- **Green:** `functions/src/snapshots/schema.ts` as specified above. `snapshotsPath` composes from
  `projectsPath` rather than a second `'users'` literal, matching `filesPath`/`messagesPath`.
- **Refactor:** the module header states the two collections, the `id === path` invariant, and why
  the file documents carry no timestamps.
- The `id === path` half of AC-5 is asserted in T6, where `parseSnapshotFile` — the function that
  enforces it — exists. Noted here so neither task assumes the other covered it.

### T2 — The pure boundary → AC-1, AC-2, AC-3, AC-4
- **Red:** `functions/src/snapshots/plan.spec.ts` —
  - `mergeSnapshotFiles`: `{a.js, index.html}` + writes `{index.html', about.html}` ⇒ three entries,
    `index.html` carries the write's content **and size**, `a.js` untouched, ordered by path;
    an empty stored set ⇒ exactly the writes, ordered.
  - `planSnapshotSeq`: `[]` ⇒ 1; max 7 ⇒ 8; `[1, 4, 7]` ⇒ 8 (gaps do not close).
  - `planSnapshotPrune`: 19 heads ⇒ `[]`; 20 ⇒ the single lowest-`seq`; 22 ⇒ the three lowest, so
    the collection lands at 20 after the write.
  - `filesEqual`: identical ⇒ true; one differing byte, one extra path, one missing path ⇒ false.
- **Green:** `functions/src/snapshots/plan.ts`.
- **Refactor:** `planSnapshotPrune` states its arithmetic (`heads.length + 1 - SNAPSHOT_LIMIT`) in a
  comment, because "+1 for the one about to be written" is the off-by-one this function exists to get
  right.

### T3 — `readStoredFiles` and the turn's resulting set → AC-1 (the caller's half)
- **Red:** `functions/src/files/handlers.spec.ts` — `readStoredFiles` orders by path, caps at
  `FILE_LIMIT`, omits an unreadable document and logs it once; `planFileWrites` returns `resulting`
  equal to `mergeSnapshotFiles(stored, writes)` for a turn that rewrites one file and adds another;
  a prose-only turn returns `resulting: []` **and the merge is never called** (D2, AC-1's third
  clause — asserted with a spy on the `plan` module, or by `resulting` being `[]` on every
  refusal path).
- **Green:** rename `readFilePaths` → `readStoredFiles`, returning `StoredFile[]` from
  `.orderBy('path').limit(FILE_LIMIT).get()` mapped through `parseStoredFile`. `planFileWrites`
  derives its existing-path set from it and calls `mergeSnapshotFiles` **only** when
  `validated.writes.length > 0`.
- **Also:** `functions/src/generate.spec.ts`'s db fake at its `getDb.mockReturnValue` gains
  `orderBy` in the chain (`collection → orderBy → limit → get`); the `select` link goes.
- **Refactor:** the doc comment on `readStoredFiles` replaces `readFilePaths`'s "≤20 refs rather than
  ≤20 documents" paragraph with D14's argument and P2's consequence.

### T4 — `appendAssistantMessage` takes an `AssistantTurn` → R10
No new behaviour. A mechanical regrouping in its own commit, so the diff a reviewer skims is small
and self-contained before any snapshot rides on it.
- **Red:** `functions/src/messages/handlers.spec.ts` — every existing `appendAssistantMessage` call
  rewritten to the object form; the existing one-batch/one-commit cases unchanged in substance.
- **Green:** the new signature; `AssistantTurn` exported with `snapshot: SnapshotPlan | null`
  **already present and ignored**, so T6 adds a body rather than a parameter.
- **Also:** `generate.ts`'s single call site; `generate.spec.ts`'s `mock.calls[0]?.[2]` / `?.[3]`
  become `mock.calls[0]?.[2].content` / `.truncated`, and its `mockImplementation` signature follows.
- **Refactor:** none expected — the point of the task is that nothing else moves.

### T5 — Rules for both new collections → AC-20, AC-21
Lands **before** the first write, so no commit in this branch's history writes the collection without
its denial. That is stricter than the definition of done's "same commit as the first write", and is
the reading this plan takes.
- **Red:** *not achievable, and the reason is structural.* Firestore's default is denial, so an L3
  test against a rules file with no block for these paths passes before the block is written. The
  test is still required by `CLAUDE.md` and still earns its place: it is what would catch a later
  rule granting a parent recursively, which is exactly the trap R8 names. The build session writes
  the test first anyway and records in the build log that it went green on the first run and why.
- **Green:** two blocks in `firestore.rules`, after the files block, with a comment saying rules do
  not cascade and that the **nested** one is the easy miss (D15, R8).
- **Test:** `tests/rules/firestore.spec.ts` gains `snapshot()`, `snapshotFile()`, `seedSnapshot()`
  and `seedSnapshotFile()` helpers shaped exactly like what `stageSnapshot` writes, plus a
  `describe` per collection covering get, list, create, update and delete for the verified owner, a
  different verified user, and an anonymous client. The existing "every prior denial is
  re-asserted" case gains the two new paths.
- **Refactor:** the seeds carry real `Date` values where the writer uses `serverTimestamp()`, as
  `seedFile` already does.

### T6 — The snapshot on the turn's batch → AC-9, AC-5's `id === path` half
- **Red:** `functions/src/snapshots/handlers.spec.ts` — against a recording batch and a faked
  `getDb`: `planSnapshot` reads the heads once, mints an auto-id ref, and returns `seq`, the files
  and the prune; `stageSnapshot` stages the snapshot document with `seq`, `origin`,
  `serverTimestamp()`, `fileCount` and `totalBytes` (the sum of the files' `size`), one document per
  file at an id equal to its path, and — for a prune — a delete per pruned file ref **and** one for
  the snapshot itself; `parseSnapshotFile` returns `null` and logs when `path !== id`.
  `functions/src/messages/handlers.spec.ts` — AC-9: the message, every file write, the snapshot
  document, its file documents and the prune are on **one** batch, committed **once**, asserted
  against `db.batches`/`db.commits`/`db.staged` (extended to record `delete`).
- **Green:** `functions/src/snapshots/handlers.ts`'s `readSnapshotHeads`, `parseSnapshotFile`,
  `planSnapshot`, `stageSnapshot`; `appendAssistantMessage` calls `stageSnapshot(batch, turn.snapshot)`
  when it is non-null; `generate.ts` computes
  `plan.writes.length > 0 ? await planSnapshot(uid, projectId, plan.resulting, 'generation') : null`
  and passes it — **inside the branch that also writes the message**, so a turn with no prose (and
  therefore no files) issues no snapshot read either.
- **Also:** `generate.spec.ts`'s db fake gains the snapshots collection query.
- **Refactor:** `stageSnapshot`'s comment states the worst-case write count (63) against Firestore's
  500, and why the prune's *file* documents are deleted explicitly (R4: deleting a parent leaves an
  orphaned subcollection).

### T7 — `__alt_files` and `reply-alt.json` → D24, and R3's precondition
- **Red:** `functions/src/llm/fake.spec.ts` — `__alt_files` is in `MARKERS`, selects
  `reply-alt.json`, and the assembled text contains a `<genesis:file path="about.html">` block and an
  `index.html` block whose bytes differ from `reply.json`'s.
- **Green:** `tests/fixtures/llm/reply-alt.json`, built on `prose-only.json`'s event skeleton
  (`message_start` → one text `content_block` → `message_delta` with `stop_reason: 'end_turn'` →
  `message_stop`), whose text is a sentence of prose, an `index.html` block that differs visibly
  from `reply.json`'s, an `about.html` block, and a closing sentence. `fake.ts` gains the marker and
  its `planFor` case at `DELTA_MS`.
- **Refactor:** the marker table in `fake.ts`'s header gains its row; `reply.json` is **not** touched
  (Slice 6's D26), so nothing that already passes moves.

### T8 — The write path over the wire → AC-6, AC-7, AC-8, AC-10
- **Red:** `tests/integration/snapshots.spec.ts`, modelled on `generate-files.spec.ts`'s harness
  (`seedProject`, `seedPrompt`, `postGenerate`, `clearProjects` via `recursiveDelete`) —
  - AC-6: one generation on an empty project ⇒ exactly one snapshot, `seq: 1`,
    `origin: 'generation'`, `fileCount: 3`, `totalBytes` = the sum of the files' sizes, and three
    file documents byte-identical to the project's, ids equal to paths.
  - AC-7: a second turn with `__alt_files` ⇒ `seq: 2`, `fileCount: 4`, and the copy of the
    **untouched** `styles.css` present and equal to the stored one.
  - AC-8: `__no_files`, `__bad_path`, `__unterminated`, `__dup_files`, `__max_tokens`,
    `__fail_midstream` ⇒ the snapshot count is exactly what it was before the turn.
  - AC-10: a project seeded with `SNAPSHOT_LIMIT` snapshots (and file documents under the oldest)
    ⇒ after another generation, exactly `SNAPSHOT_LIMIT` remain, the lowest-`seq` one is gone,
    **its file documents are gone**, and the newest carries the highest `seq`.
- **Green:** nothing new is expected — T6 wrote it. Anything red here is a T6 defect, fixed in this
  commit.
- **Refactor:** a `storedSnapshots(uid, projectId)` and a `snapshotFiles(uid, projectId, id)` helper
  at the top of the spec, so the assertions read as claims rather than as Firestore.

### T9 — The list route → AC-11, AC-19 (structural)
- **Red:** `tests/integration/snapshots.spec.ts` — three snapshots come back ordered by `seq`
  descending, each carrying `id`, `seq`, `createdAt`, `origin`, `fileCount`, `totalBytes` and **no**
  `content` or `files`; a project with none ⇒ `{ snapshots: [] }`; more than `SNAPSHOT_LIMIT` seeded
  ⇒ at most `SNAPSHOT_LIMIT` entries; no `Authorization` ⇒ 401; `email_verified: false` ⇒ 403; a
  malformed project id ⇒ 400 `invalid_id`; another user's project ⇒ 404.
  `functions/src/index.spec.ts` — the router file names `withVerifiedUser` on both routes, `attested`
  on the restore route, and **not** on the `GET`.
- **Green:** `readSnapshotList` (`orderBy('seq','desc').limit(SNAPSHOT_LIMIT)`, unreadable documents
  omitted and logged), `handleListSnapshots`, `functions/src/snapshots/index.ts`, mounted after
  `filesRouter` in `functions/src/api/index.ts` at both `/` and `/api`.
- **Refactor:** the router's header carries the same three notes every router in this codebase does —
  its own module per collection, routes name the resource never the user, middleware per route
  never `router.use`.

### T10 — The restore route → AC-12 – AC-18, AC-19 (behavioural)
The slice's largest task and the one carrying D7, D8, D9 and D10 at once.
- **Red:** `tests/integration/snapshots.spec.ts` —
  - AC-12: generate, generate with `__alt_files`, restore snapshot 1 ⇒ every file byte-identical to
    that snapshot's, `about.html` **absent**, the response's `files` deep-equal to a fresh
    `GET …/files`, `changed: true`.
  - AC-13: the same restore leaves a snapshot with `origin: 'restore'` and the highest `seq` holding
    the four-file set; restoring **that** returns the project to version 2.
  - AC-14: restoring the version the project already is ⇒ no new snapshot, no file `updatedAt`
    advanced (compared against values read before the call), `changed: false`.
  - AC-15: a project with no files ⇒ the snapshot's files are written and **no** safety snapshot.
  - AC-16: a snapshot whose subcollection is one document short, and one whose file document fails
    to parse ⇒ 409 `snapshot_unreadable`, no file created, deleted or modified, no snapshot written.
  - AC-17: alice restoring bob's snapshot, a soft-deleted project, a snapshot id from another of
    alice's own projects, a never-existing id ⇒ 404 in every case, bob's data untouched; malformed
    project id and malformed snapshot id ⇒ 400 `invalid_id`.
  - AC-18: a 20-file snapshot restored over 20 **different** files ⇒ exactly the snapshot's 20.
  - AC-19: no `Authorization` ⇒ 401; unverified ⇒ 403; any request body ⇒ 400 `invalid_body`.
- **Green:** `readSnapshotFiles`, `requireSnapshotId`, `snapshotNotFound`, `handleRestoreSnapshot`
  following the ten-step order above; the route added to `snapshots/index.ts` with `attested`.
- **Refactor:** the handler's doc comment states, in order, why each read precedes the batch and why
  the no-op returns before one is opened.

### T11 — The rendered labels → AC-29's label half
- **Red:** `frontend/src/lib/snapshots.spec.ts` — `versionLabel(1)` ⇒ `Version 1`;
  `originLabel('generation')` ⇒ `Generation`, `originLabel('restore')` ⇒ `Before restore`;
  `snapshotSubtitle(3, 11_240)` ⇒ `3 files · 11 KB`, `snapshotSubtitle(1, 512)` ⇒ `1 file · 512 bytes`.
  `frontend/src/lib/files.spec.ts` — `formatBytes(0)` ⇒ `0 bytes`, `formatBytes(999)` ⇒ `999 bytes`,
  `formatBytes(1000)` ⇒ `1 KB`, `formatBytes(14_022)` ⇒ `14 KB`.
- **Green:** `frontend/src/lib/snapshots.ts` and `formatBytes` in `frontend/src/lib/files.ts`.
- **Refactor:** `formatBytes` sits beside `utf8Bytes` and its comment says both count the same unit.

### T12 — The client library → AC-22
- **Red:** `frontend/src/lib/snapshotsApi.spec.ts`, on `projectsApi.spec.ts`'s pattern (a stubbed
  `fetch`) — `listSnapshots` issues `GET /api/projects/<enc>/snapshots` and returns `snapshots`;
  `restoreSnapshot` issues `POST /api/projects/<enc>/snapshots/<enc>/restore` with **no `body`** and
  **no `Content-Type`**, and returns `{ files, changed }`; both ids are percent-encoded.
- **Green:** `frontend/src/lib/snapshotsApi.ts`.
- **Refactor:** the module header states, as `filesApi.ts` does, that this is the whole of the
  browser's access to the collection and that the uid is never sent.
- `frontend/src/lib/no-firestore.spec.ts` is unchanged and re-run; its scan covers the new files
  automatically.

### T13 — The store's snapshot list → AC-23, AC-27, AC-28
- **Red:** `frontend/src/stores/workspace.spec.ts` — `loadSnapshots()` sets and clears
  `snapshotsLoading`, sets `snapshotsLoaded`, replaces the list; on failure it sets `snapshotsError`
  and **leaves the existing list in place**; a `done` carrying files refetches the list **only if**
  `snapshotsLoaded`; a `done` with no files issues no snapshot request at all; `reset()` and opening
  another project return every snapshot field to its initial value, and a response in flight across
  either cannot repopulate it (the `current(gen)` guard).
- **Green:** the six new fields, `loadSnapshots()` on `loadFiles()`'s exact shape (gen-guarded,
  list left alone on failure), `clearSnapshotState()` called from `open()` and `reset()`, and one
  line in `applyGenerationFiles` after the refetch.
- **Refactor:** `clearSnapshotState()` sits beside `clearFileState()` and is called from the same
  two places, so a seventh field cannot be added to one and forgotten in the other.

### T14 — Restore, and what it does to the tabs → AC-24, AC-25, AC-26
- **Red:** `frontend/src/stores/workspace.spec.ts` — `restoreSnapshot(id)` sets `restoringId` for the
  length of the request, replaces `files` with the response's list, clears `restoringId` however it
  ends, and refetches the snapshot list; on failure it sets `restoreError` and leaves `files`,
  `openTabs` and every buffer untouched; with tabs on `index.html` and `about.html` and a restored
  set holding only `index.html`, `index.html` is re-read from the server, `about.html`'s tab is
  closed and its buffer dropped, and a dirty `index.html` buffer comes back with `replaced` set;
  with `generating` true, or a restore already in flight, **no request is issued**.
- **Green:** `restoreSnapshot(snapshotId)` and a private `applyRestoredFiles(files, gen)`.
  `applyRestoredFiles` iterates a **copy** of `openTabs.value` (it mutates the array through
  `closeTab`), re-reads the surviving tabs sequentially through `readInto` exactly as
  `applyGenerationFiles` does, closes and drops the deleted ones, and drops every closed-but-buffered
  path (P6).
- **Refactor:** the shared "re-read, announce a discarded dirty buffer" body is factored out of
  `applyGenerationFiles` and `applyRestoredFiles` if and only if it comes out cleanly; if it does
  not, the two carry a cross-reference instead. Do not force it — the deleted-tab case is genuinely
  new and only one of them has it.

### T15 — The `sheet` primitive (scaffolding)
**No red step is possible**, and this is the one task in the slice where that is true rather than
convenient: vendoring a component from upstream has no behaviour of its own to fail. It is covered
by T16's tests the moment it is used.
- **Do:** `cd frontend && npx shadcn-vue@latest add sheet`.
- **If the CLI cannot reach the network** (R9): vendor from the pinned upstream source instead, add
  the deviation comment `PRODUCT_SPEC.md` §7.2 requires, and **say so explicitly in the build log**,
  so the review checks provenance by diff rather than by trust. `reka-ui` is already a dependency
  (`^2.10.3`) and `class-variance-authority` is too, so no new runtime package is involved either way.
- **Expect to edit:** upstream forwards props with `useForwardPropsEmits`, whose result carries keys
  valued `undefined`, which this project's `exactOptionalPropertyTypes` treats as different from
  absent. `ui/dialog/DialogContent.vue` and `ui/dialog/DialogTrigger.vue` show the exact fix
  (`Object.fromEntries(... filter(([, v]) => v !== undefined))`) and the comment that goes with it.
- **Note:** reka-ui's dialog content warns without a title, so `SheetContent` must be used with a
  `SheetTitle` — T16 does.

### T16 — `SnapshotSheet.vue` → AC-29, AC-30
- **Red:** `frontend/src/components/workspace/SnapshotSheet.spec.ts`, on `ProjectFormDialog.spec.ts`'s
  pattern (a `reactive` store stub, `vi.mock('@/stores/workspace')`) — closed, no snapshot request has
  been issued; opening calls `loadSnapshots()`; `snapshotsLoading` renders the loading state; a loaded
  empty list renders "No versions yet."; `snapshotsError` renders the message and a **Try again** that
  calls `loadSnapshots()`; three snapshots render three rows newest-first, each showing *Version N*,
  its origin label, its file count, its size and its date and time; **Restore** turns that row into a
  two-step confirm; **Cancel** returns the row unchanged and issues nothing; confirming calls
  `restoreSnapshot(id)`; while `restoringId` is set every row's Restore is disabled and that row says
  so; `restoreError` renders inside the sheet; `generating` disables every Restore with a reason on
  screen while the list still renders.
- **Green:** `frontend/src/components/workspace/SnapshotSheet.vue` — a **History** trigger
  (`data-testid="snapshot-trigger"`), `Sheet` with `side="right"`, a `SheetTitle` of "Version
  history", and the four states. `open` and the confirming row id are local `ref`s (D20). Testids:
  `snapshot-sheet`, `snapshot-loading`, `snapshot-empty`, `snapshot-error`, `snapshot-retry`,
  `snapshot-row`, `snapshot-restore`, `snapshot-confirm`, `snapshot-cancel`, `snapshot-restoring`,
  `snapshot-generating`.
- **Refactor:** the confirm is two states of one row and nothing more (D19); the header comment says
  why there is no second overlay.

### T17 — The trigger in the code panel header → AC-29
- **Red:** `frontend/src/components/workspace/EditorPanel.spec.ts` — the header renders
  `snapshot-trigger`, and the existing geometry cases (`max-h-` capped element scrolls; the height
  chain) still pass unchanged.
- **Green:** `<SnapshotSheet />` in `EditorPanel.vue`'s header, which becomes
  `flex items-center justify-between`.
- **Watch:** if the sheet's markup trips the spec's `findAll('div')` `max-h-` assertion, stub
  `SnapshotSheet.vue` in that spec exactly as `CodeEditor.vue` is already stubbed there, and add the
  trigger assertion to `SnapshotSheet.spec.ts` instead. Decide by running it, not by guessing.

### T18 — The origin-neutral replaced notice → AC-31
- **Red:** `frontend/src/components/workspace/FileEditor.spec.ts` — the notice renders when
  `fileReplaced` is true and its text contains neither "generation" nor "restore".
- **Green:** the copy in `FileEditor.vue` becomes P8's sentence.
- **Refactor:** the surrounding comment cites D22 rather than Slice 6's D15/D16 alone.

### T19 — End to end → AC-32
- **Red:** `tests/e2e/snapshots.spec.ts`, on `files.spec.ts`'s harness (`signUpAndVerify`,
  `openNewProject`, `assertEmulatorBuild`, `resetEmulators`) — generate; generate again with
  `__alt_files`; open **History**; two rows; restore version 1 through the inline confirm; three rows;
  the tree drops to three files with `about.html` gone; the editor shows version 1's `index.html`;
  reload and all of it survives.
- **Green:** nothing new expected. Anything red is a defect in T10, T14 or T16, fixed here.
- **Refactor:** a header stating what only this level can prove — that the restore reaches real
  documents through real routes and survives a reload.

### T20 — The documents
- **No test.** `docs/IMPLEMENTATION_PLAN.md` §0's status table, §4's Slice 11 entry and §9's rows for
  F5.2, F5.3, F6.6 and the shadcn inventory; `docs/PRODUCT_SPEC.md` §7.2's `sheet` row marked
  shipped. Suite counts go in at ship time, from the orchestrator's run rather than from a claim.

## AC coverage

Every acceptance criterion maps to at least one task. **No AC is unmapped.**

| AC | Task | AC | Task |
|---|---|---|---|
| AC-1 | T2, T3 | AC-17 | T10 |
| AC-2 | T2 | AC-18 | T10 |
| AC-3 | T2 | AC-19 | T9 (structural), T10 (behavioural) |
| AC-4 | T2 | AC-20 | T5 |
| AC-5 | T1, T6 | AC-21 | T5 |
| AC-6 | T8 | AC-22 | T12 |
| AC-7 | T7, T8 | AC-23 | T13 |
| AC-8 | T8 | AC-24 | T14 |
| AC-9 | T6 | AC-25 | T14 |
| AC-10 | T8 | AC-26 | T14 |
| AC-11 | T9 | AC-27 | T13 |
| AC-12 | T10 | AC-28 | T13 |
| AC-13 | T10 | AC-29 | T11, T16, T17 |
| AC-14 | T10 | AC-30 | T16 |
| AC-15 | T10 | AC-31 | T18 |
| AC-16 | T10 | AC-32 | T19 |

## Firestore rules changes

Two blocks, appended after the files block in `firestore.rules`. Rules do not cascade, so neither
the projects block nor the files block says anything about either path, and the **nested** one is
the easy miss (D15, R8).

```
// --- snapshots ----------------------------------------------------
// A point-in-time copy of a project's whole file set, written only by
// /generate's one batch per turn and by
// POST /api/projects/:projectId/snapshots/:snapshotId/restore.
// Read only by GET /api/projects/:projectId/snapshots.
match /users/{uid}/projects/{projectId}/snapshots/{snapshotId} {
  allow read, write: if false;
}

// --- a snapshot's copied files ------------------------------------
// These documents *are* the generated application, one version back, so a
// client that could write here could plant its own JavaScript and have a
// later restore put it into the project — where Slice 10's preview runs it.
//
// Rules do not cascade, so the block above says nothing about this path.
// It is the one a reader is most likely to assume is covered, and it is not.
match /users/{uid}/projects/{projectId}/snapshots/{snapshotId}/files/{fileId} {
  allow read, write: if false;
}
```

**L3 tests** in `tests/rules/firestore.spec.ts`, seeded past the rules with exactly what
`stageSnapshot` writes, so the denial is on the rule and not on the shape:

- `snapshots/{snapshotId}`, for the **verified owner**: `getDoc`, `getDocs` on the collection,
  `setDoc` (create), `updateDoc` (e.g. flipping `origin` to `'generation'` to disguise a forged
  version), `deleteDoc` — all denied.
- `snapshots/{snapshotId}/files/{fileId}`, addressed as `.../files/index.html` because the id **is**
  the path: the same five operations, all denied. The create case carries a payload of hostile
  JavaScript, which is what R8 is about.
- The same two sets for a **different verified user** and for an **anonymous** client.
- The existing "the rules file changed, so every prior denial is re-asserted" case gains
  `users/alice/projects/proj-1/snapshots/snap-1` and
  `users/alice/projects/proj-1/snapshots/snap-1/files/index.html` (AC-21).

`firestore.indexes.json` is **unchanged**: the list is `orderBy('seq','desc').limit(20)`, the prune
read is `orderBy('seq','asc').select('seq')`, and a snapshot's files are read unordered — three
single-field or index-free queries (D16, R6). The review verifies that against the queries, not
against this paragraph.

## Dependencies

**No new npm packages.** `reka-ui` (`^2.10.3`), `class-variance-authority` and `lucide-vue-next` are
already frontend dependencies, and they are everything the vendored `sheet` needs. `zod`,
`firebase-admin` and `express` cover the functions side. `.env.example` is unchanged, because no
configuration is added — stated rather than assumed, as the definition of done asks.

The only external step is `npx shadcn-vue@latest add sheet` (T15), which needs the network; R9's
fallback and its build-log obligation are written into that task.

## Manual verification

On emulators, from a clean checkout:

1. `npm run install:all`, then `npm run dev`.
2. Sign up, verify the address through the emulator's link, and open a new project.
3. Send `build a contact dashboard`. Watch three files stream into the tree. Nothing visible changes
   because of the snapshot — that is correct (user flow step 2).
4. Press **History**. One row: *Version 1 — Generation · 3 files · … · 18 Aug 2026, …*.
5. Close the sheet. Send `__alt_files add an about page`. The tree goes to four files and
   `index.html`'s contents change.
6. Press **History**. Two rows, newest first. Version 2 says *4 files*.
7. Press **Restore** on Version 1. The row becomes *Restore this version?*. Press **Cancel** — the
   row returns unchanged and nothing is requested.
8. Press **Restore** again, then confirm. The row shows a restoring state and every other Restore is
   disabled.
9. The list refreshes to **three** rows, the newest marked *Before restore*. The tree drops to three
   files; `about.html` is gone. The open `index.html` tab shows version 1's code. A tab left open on
   `about.html` has closed.
10. Reload the page. Tree, file contents and version list all come back from the server.
11. Send a prompt and, while it is streaming, open **History**: the list reads, and every **Restore**
    is disabled with a reason on screen.
12. Restore the *Before restore* version. The project returns to the four-file state — the safety
    snapshot is real, and it is the undo for the undo.

## Estimate

| Task | Estimate |
|---|---|
| T1 — snapshot schemas | 0.5 h |
| T2 — the pure boundary | 0.75 h |
| T3 — `readStoredFiles` + resulting set | 0.75 h |
| T4 — `AssistantTurn` regrouping | 0.75 h |
| T5 — rules + L3 | 0.5 h |
| T6 — the snapshot on the batch | 1.25 h |
| T7 — `__alt_files` + fixture | 0.5 h |
| T8 — L4 write path | 1.25 h |
| T9 — the list route | 0.75 h |
| T10 — the restore route | **1.75 h** |
| T11 — labels + `formatBytes` | 0.5 h |
| T12 — the client library | 0.5 h |
| T13 — store: the list | 0.75 h |
| T14 — store: restore + tabs | 1.25 h |
| T15 — vendor `sheet` | 0.5 h |
| T16 — `SnapshotSheet.vue` | **1.5 h** |
| T17 — the header trigger | 0.25 h |
| T18 — the replaced notice | 0.25 h |
| T19 — e2e | 1 h |
| T20 — the documents | 0.5 h |
| **Total** | **≈ 16.75 h** |

Nothing is over half a day. The two largest — T10 and T16 — are flagged rather than split: T10 is
one handler whose ten steps only make sense together, and splitting T16's four states across commits
would leave a screen with no error state in the middle of the branch, which the definition of done
forbids on a new screen. The two carrying the most risk of a re-do are T6 (R5 — the batch) and T14
(R7 — two writers, and the deleted-tab case), both of which have their assertions written before
their implementations.

## Hard stop

Approve this approach, then run `/feature-build 11`.
