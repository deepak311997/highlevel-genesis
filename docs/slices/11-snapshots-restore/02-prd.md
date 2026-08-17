# Slice 11 — Snapshots & restore · PRD

**Spec:** F5.2, F5.3, F6.6 · **Branch:** `slice/11-snapshots-restore` · **Depends on:** 6 ·
**Date:** 2026-08-18

## Problem

Every generation **overwrites** the project's files in place. A second prompt rewrites
`index.html`, `styles.css` and `app.js` on top of the first one's work (Slice 6, D18: generations
create and update, never delete), and there is no copy of what was there before — so a turn that
makes the app worse is a turn the user cannot undo. Slice 6 said so in as many words: "rollback is
Slice 11's snapshot, which is the feature that actually owns *put the project back*."

This slice adds the copy and the way back. Every generation that stores files also stores a
point-in-time copy of the project's **whole** file set, the copies are listed newest-first in a
shadcn Sheet with their timestamps, and any one of them can be restored exactly — including
deleting the files a later generation added.

## The demo

Generate an app, generate a different one over it, open **History**, restore version 1 — and the
editor shows version 1's code with version 2's extra file gone from the tree.

## Decisions

No interview was run: this slice ships under the unattended loop, so every question below was
answered from `PRODUCT_SPEC.md` §2 (step 8 of the golden path), §3 (the collection list), §4
(F5.2, F5.3, F6.6, F8.1) and §7.2 (the component inventory), `IMPLEMENTATION_PLAN.md` §4 (Slices 6,
11, 12, 13), §5's cut order and §9's two ⏭ rows, `CLAUDE.md`'s non-negotiables, and the merged code
of Slices 0–8 — in particular `docs/slices/06-file-operations/02-prd.md`, whose D9, D11, D13, D18,
D21, D23 and D31 this slice extends rather than reopens. Load-bearing decisions carry the
alternative that was rejected, because a decision with no rejected alternative was not a decision.

Nothing in `IMPLEMENTATION_PLAN.md` §8 is owed a first answer here; the file-storage row was
settled in Slice 6 and its stated reason — "snapshots and restore stay trivial" — is the thing this
slice cashes in.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | **What does a snapshot capture — the turn's files, or the project's?** | **The project's whole file set as it stands after the turn**: the files already stored, with the turn's writes applied over them. | F5.2 says "point-in-time copy of **all** project files", and the reason is Slice 6's D18: a turn that only rewrites `app.js` leaves `index.html` untouched, so a snapshot holding just the turn's writes is a copy of *part* of an app. Restoring it would then produce exactly the half-restored, silently-broken state D9 refuses for the write path. Rejected: **the turn's writes alone** (a partial app, and the failure only shows in the preview); rejected: **the state *before* the turn** — an undo model, in which the first snapshot of every project is empty and "restore version one" hands the user a blank project. |
| D2 | **When is a snapshot written?** | **Only when a turn actually stores files.** A prose-only reply (Slice 6, D17), a refused op set (D9), an unterminated block, a truncated turn and a mid-stream failure (D10) all write **no snapshot**, because they write no file. | The snapshot is a copy of the files, so a turn that changed no file has nothing to copy, and a history of identical rows is a history nobody can navigate. It also keeps one rule for the whole terminal: **the snapshot is written exactly when the files are**, so there is no third state where a version exists that no file write produced. |
| D3 | **One document holding every file, or a document plus a subcollection?** | **A snapshot document with a `files` subcollection**, one document per file, id = path. | Arithmetic, not taste: `FILE_LIMIT` × `FILE_BYTES_MAX` is 20 × 100,000 = **2,000,000 bytes**, and Firestore's document limit is 1,048,576. A snapshot holding its files inline is a document that cannot be written for a project that is within its own caps — and it would fail on the largest, most valuable projects only, which is the worst possible distribution of a failure. Rejected: **an inline `Record<path, content>`** (above); rejected: **a content-addressed blob store with dedup** — the right answer at a hundred times this scale and a slice of its own at this one. |
| D4 | **Is the snapshot atomic with the turn?** | **Yes — staged on the same `WriteBatch`** as the assistant message and the turn's file writes, committed once. `appendAssistantMessage` keeps ownership of the batch and takes an `AssistantTurn` object (`content`, `truncated`, `fileWrites`, `snapshot`) rather than growing a sixth positional parameter. | Slice 6's D11 argument, one collection further: the message says `[file: index.html]` and the file says what `index.html` contains; a version that claims to be a copy of that turn must commit with it or it is a copy of a moment that never existed. Two commits would also give a crash window in which the tree has moved on and the history has not — which is precisely the state a user would open the sheet to escape. Worst case 63 writes (1 message + 20 files + 1 snapshot + 20 snapshot files + 21 pruned), far inside Firestore's 500. |
| D5 | **How is a version identified to the user?** | **A stored, monotone `seq` per project**, rendered as *Version N*. The list orders by `seq` descending; restore addresses a snapshot by its **document id**. | The demo line is "restore version one", so the number has to be stable enough to say out loud. Deriving it from position in the list is exactly what pruning (D6) breaks: drop the oldest and every remaining version silently renumbers, so the row a user was looking at yesterday means something else today. Storing it costs one field and one `orderBy` that Firestore indexes automatically. Rejected: **ordering by `createdAt` and numbering client-side** (renumbers on prune); rejected: **showing the raw document id** (unspeakable, and it leaks an internal name into the UI). |
| D6 | **How many snapshots does a project keep?** | **`SNAPSHOT_LIMIT = 20`**, the newest. Writing the twenty-first prunes the oldest — its document *and* its `files` subcollection — **in the same batch**. | Unbounded is not an option once D9 exists: a restore writes a snapshot too, so a user clicking **Restore** repeatedly is an unbounded write amplifier, and 100 generations × 2 MB is 200 MB of copies for one project. Twenty is the same number as `FILE_LIMIT`, and it matches the list's cap so "you are seeing every version" is a guarantee rather than a hope — `MESSAGE_LIMIT` / `PROJECT_LIMIT` / `FILE_LIMIT`'s rule, unchanged. Rejected: **keep everything and cap only the list** (storage grows for versions the product will never show); rejected: **a TTL** (a project untouched for a month would lose its history for having been finished). |
| D7 | **What exactly does restore do to the file set?** | **It makes the project's files equal the snapshot's, exactly** — every file in the snapshot is written, and **every current file the snapshot does not hold is deleted**. | "Restore version one" has to mean the project *is* version one; a union would leave the file version two added sitting in the tree, referenced by nothing, and `index.html` from version one calling scripts that no longer match. This is the only place in the product that deletes a file document, and it is deliberate: Slice 6's D18 kept generations non-destructive precisely so that this operation could be the one that is. Rejected: **merge/union** (a hybrid app, broken in a way the tree does not show). |
| D8 | **One unreadable file inside a snapshot — restore the rest?** | **No. Restore is all-or-nothing.** If any of the snapshot's file documents fails to parse, or the subcollection holds fewer documents than the snapshot's own `fileCount`, the restore is refused with **409 `snapshot_unreadable`** and **nothing is written**. | D9's argument, applied to the read side. Everywhere else in this codebase an unreadable document is treated as absent (`parseStoredFile`, `parseStored`, `parseStoredMessage`) — that is right for a list, where the cost is one missing row, and wrong here, where the cost is silently restoring a *different* version than the one named. `fileCount` is stored so the check is a comparison rather than a hope. |
| D9 | **Is restore itself undoable?** | **Yes. A restore first snapshots the current state**, with `origin: 'restore'`, in the same batch — unless the project currently holds no files (nothing to preserve) or the restore is a no-op (D10). | Restore is the one operation here that destroys work, and the work it destroys is the work the product cannot otherwise recover: a **manual edit** made since the last generation, which `PUT` does not snapshot (D23). The pre-state is already read to decide what to delete (D7), so the copy costs a stage on a batch that is already open. Rejected: **a confirmation dialog instead** — it asks the user to be certain rather than making the mistake survivable, and a dialog is a component, a focus trap and an e2e case. The cheap half of that idea is kept anyway as an inline confirm (D19). |
| D10 | **Restoring the version the project already is?** | **A no-op.** If the snapshot's files are byte-identical to the project's current files, **nothing is written at all** — no file writes, no deletes, no safety snapshot — and the response carries `changed: false`. | Both sets have already been read, so the comparison is free, and without it the safety snapshot of D9 turns a harmless double-click into a new version identical to the last one — filling a twenty-row history with copies of one moment and pruning the versions that mattered. |
| D11 | **What routes exist?** | **`GET /api/projects/:projectId/snapshots`** (a plain authenticated read) and **`POST /api/projects/:projectId/snapshots/:snapshotId/restore`** (attested — it mutates). No `DELETE`, and no route that reads one snapshot's file contents. | F5.3 is exactly two verbs: list them, restore one. Deleting a version by hand is not in the brief and D6's prune is what bounds the collection; reading a snapshot's contents without restoring is a **diff view**, which is Stretch S3. No user identifier appears in either path — the uid comes from the token, and both the project and the snapshot are ownership-checked by the path composed from it. |
| D12 | **What does restore answer with?** | **`{ files: FileMeta[], changed: boolean }`** — the project's file list as it now stands. The store applies it directly rather than issuing a follow-up `GET /files`. | Liveness is refetch-after-mutation (`CLAUDE.md`), and this response **is** the refetch: the server has just written the documents and is answering from what it stored, so a second list request would ask the same server the same question one round trip later. Slice 6's D20 argument does not apply — there is no streamed copy here that could disagree with the stored bytes. The snapshot *list* is refetched separately, because the safety snapshot (D9) means it genuinely changed. |
| D13 | **Document ids?** | **The snapshot is an auto-id; a snapshot file's id *is* its path**, with the `id === path` invariant asserted on parse — Slice 6's D13, restated one collection deeper. | Auto-id for the snapshot because nothing about a version is a natural key and a client-chosen one lets a caller probe (Slice 3's argument). Path-as-id for the files because it makes a snapshot's file set structurally identical to the project's, which is what lets one comparison answer D10 and one loop answer D7. |
| D14 | **Where does the copied content come from?** | **From one read of the project's file documents, content included**, replacing the `select()`-only path read the cap check used. `readFilePaths` becomes `readStoredFiles`. | The turn already reads the collection to answer "is the union within `FILE_LIMIT`, and which writes are rewrites"; the snapshot needs the same documents with their bytes. One read of ≤20 documents (≤2 MB, once per generation, on a path that has just spent an LLM call) is the price of F5.2. Rejected: **keeping the `select()` and adding a second, full read when a snapshot is due** — the same bytes, one more round trip, and two answers to "what does this project hold". |
| D15 | **Rules?** | **Two new deny-all blocks** — `…/snapshots/{snapshotId}` and `…/snapshots/{snapshotId}/files/{fileId}` — with L3 tests in the same commit. | Rules do not cascade into subcollections, so neither the projects block nor the files block says anything about either path, and the *nested* one is the easy miss: a block on `snapshots/{id}` alone would leave the documents that hold the actual code reachable by nothing but the default denial, which is not what this file is for. These documents are copies of the generated application, so a client that could write here could plant its own JavaScript and have Slice 10's preview run it. |
| D16 | **Indexes?** | **Unchanged.** The list is `orderBy('seq','desc').limit(SNAPSHOT_LIMIT)` and the prune read is the same field ascending — single-field orders, served by Firestore's automatic index. The snapshot-files read is an unordered collection read. | Stated rather than assumed, because Slices 3 and 4 each paid for a missing composite index and the emulator does not enforce them. `firestore.indexes.json` is unchanged and the review checks that claim against the queries rather than against this sentence. |
| D17 | **Which component, and where is it opened from?** | **shadcn-vue `sheet`**, added with `npx shadcn-vue@latest add sheet`, opened by a **History** button in the **code panel header** beside "Code". | F6.6 says "Sheet/Dialog" and `IMPLEMENTATION_PLAN.md` §4 already chose the sheet: it slides in from the side of a three-panel workspace rather than covering it, so the file tree the restore is about to change stays visible behind it. The header is where it belongs because versions are versions *of the files* — putting it in the workspace header would associate it with the project, and the chat panel has no claim on it. This completes the brief's component inventory except Slice 12's two. |
| D18 | **Restore while a generation is streaming?** | **Refused.** The Restore action is disabled for the length of a stream with a reason on it, and `restoreSnapshot()` re-checks `generating` in the store. | Slice 6's D21, extended to the second writer this slice adds. A restore committing mid-stream would be overwritten seconds later by the generation's own batch, so the user would watch their restore silently undo itself. The component renders the rule and the store enforces it, because a keyboard path does not go through the button. |
| D19 | **A confirmation before restoring?** | **Yes, inline in the row**: **Restore** turns that row into *Restore this version?* with **Restore** / **Cancel**. No second overlay. | Restore is destructive and one click away from a list of near-identical rows, so a misclick is likely; but a modal on top of a sheet is a second focus trap and a nested-overlay bug waiting to happen. Two states of one row costs a boolean and reads as deliberate. D9 is what makes the residual mistake survivable. |
| D20 | **Where does the sheet's open state live?** | **In the component.** Not in the store. | Slice 4's D17 put the composer draft in the store because the `lg` breakpoint swaps one component tree for another and eats component state — but the thing it protects there is *typed work*. An overlay closing because the window was resized is not lost work; it is an overlay closing. Nothing is destroyed and one keystroke reopens it. |
| D21 | **How does the client learn a new version exists?** | **It asks.** The list is fetched when the sheet opens, refetched after a restore, and refetched at a `done` that wrote files **only if** it has already been loaded this session. `done`'s SSE payload is **unchanged**. | Refetch-on-open is the cheapest correct answer and it costs the stream nothing: a `snapshotId` on `done` would add a field to the wire protocol, the frontend parser and every fixture, to save a request the sheet makes at most once per session. The `snapshotsLoaded` condition is what keeps a user who never opens the sheet from paying for it on every turn — and what keeps an *open* sheet from going stale while the user watches a generation finish behind it. |
| D22 | **What happens to open tabs when a restore lands?** | Tabs whose file the snapshot still holds are **re-read**; a dirty one is replaced and the discard is **announced**. A tab whose file the restore **deleted** is closed and its buffer dropped. The notice copy becomes origin-neutral. | Slice 6's D22 and Slice 7's `applyGenerationFiles`, reused rather than re-argued: silence is the one unacceptable outcome and a merge UI is a slice of its own. The deleted case is new and is the one that bites — a tab left open over a file that no longer exists shows bytes nothing owns, and **Save** from it would 404 (Slice 6, D19: `PUT` does not create), so the tab is taken away at the moment the file is. The copy stops saying "the latest generation" because a restore is now a second thing that can replace a buffer. |
| D23 | **Does a manual save snapshot?** | **No.** F5.2 says "on every generation" and that is the whole trigger. | A snapshot per keystroke-batch would fill the twenty-row history with the last twenty saves and prune away every generation, which is the history the user actually navigates by. The edit is not unprotected: D9's safety snapshot captures it at the only moment this slice can destroy it. |
| D24 | **How is restore fidelity made observable?** | **A new fake marker `__alt_files` and fixture `reply-alt.json`** — a reply that writes a *different* `index.html` and adds a fourth file. | Load-bearing rather than convenience: the fake replays one fixture, so two generations produce byte-identical files and a restore that did nothing at all would pass. The alternative reply changes one file and adds one, which is what makes both halves of D7 — content restored, later file deleted — assertable at L4 and visible at L5. Slice 6's D26 rule holds: `reply.json` is not touched, so nothing that already passes moves. |
| D25 | **Does a snapshot link to the message that produced it?** | **No `messageId` field.** | Nothing in this slice reads it: the sheet renders a time, a version number and a file count. Storing an id "for later" is a field with no test, no consumer and one more thing to keep true — and the consumer it would be for, a per-generation diff, is Stretch S3, where the link can be added with the feature that needs it. |
| D26 | **What is stored on the snapshot document?** | `seq`, `createdAt`, `origin` (`'generation' \| 'restore'`), `fileCount`, `totalBytes`. No name, no note, no label. | Each of the five is rendered or checked: `seq` names the version, `createdAt` dates it, `origin` distinguishes *Generation* from *Before restore*, `fileCount` is both a row's subtitle and D8's integrity check, `totalBytes` is the other half of the subtitle. A user-editable name is a rename dialog, a validation schema and a route — an unearned feature on a twenty-row list ordered by time. |
| D27 | **Can a user restore back to "no files"?** | **No**, and it is not offered: the empty state before the first generation was never snapshotted. | D2 writes a snapshot only when files are stored, so the first version of a project is the first generated app. Emptying a project is not a product feature — there is no delete-file route (Slice 6, D19) — so a version representing "nothing" would be a way to reach a state nothing else can reach. |
| D28 | **Two generations at once, or two tabs restoring at once?** | **Not transactional.** `seq` is read immediately before the write, like every other guard-rail in this codebase, so two simultaneous turns can mint the same `seq`. The consequence is **cosmetic only**: two rows labelled *Version 3*. | `liveProjectCount`, `messageCount` and `readFilePaths` all made the same trade for the same reason, and Slice 6's D23 stated it from the other side. What the collision cannot do is restore the wrong thing: restore addresses a snapshot by **document id** (D5), so the label being ambiguous costs a squint and not a project. A transaction would be a read-write of the whole collection on a path that is already the most expensive in the product. |
| D29 | **Is this one reviewable PR?** | **Yes, and it is at the edge** — the same shape as Slice 6, which is the comparison worth making. One new functions module (`snapshots/`: schema, handlers, router), one changed read in `files/`, one changed batch owner in `messages/`, two rules blocks, one client library, one store extension, one new component plus one vendored primitive, one fixture and its marker. No new index, no change to the SSE protocol, no change to the prompt. | Checked deliberately, and the mitigation is build order: **the pure boundary first** — the resulting-set merge, the prune plan, the equality check and the schemas as L1 units; then the batch and its rules; then the two routes; then the client library; then the store; then the sheet. Everything hazard-bearing (D1, D3, D4, D7, D8) is reviewable before a `.vue` file changes. What would have pushed it over is out of scope below: a diff view, per-snapshot browsing, naming a version, and snapshotting manual saves. |

## In scope

- `functions/src/snapshots/schema.ts` — **new.** `SNAPSHOTS`, `SNAPSHOT_LIMIT`, `snapshotsPath()`,
  `snapshotFilesPath()`, the stored snapshot and snapshot-file schemas with the `id === path`
  invariant (D13), `SnapshotOrigin`, the wire shape `SnapshotMeta`, `toSnapshotMeta()`, and the
  refusal copy
- `functions/src/snapshots/plan.ts` — **new, pure.** `mergeSnapshotFiles()` (D1),
  `planSnapshotSeq()` and `planSnapshotPrune()` (D5, D6), `filesEqual()` (D10)
- `functions/src/snapshots/handlers.ts` — **new.** `readSnapshotHeads()`, `stageSnapshot()`
  (the snapshot document, its files and the prune, all staged, nothing committed — D4),
  `readSnapshotList()`, `readSnapshotFiles()`, `requireSnapshotId()`, `handleListSnapshots`,
  `handleRestoreSnapshot` (D7, D8, D9, D10)
- `functions/src/snapshots/index.ts` — **new.** `snapshotsRouter`, mounted at `/` and `/api`
- `functions/src/api/index.ts` — the new router mounted after `filesRouter`
- `functions/src/files/handlers.ts` — `readFilePaths` → `readStoredFiles` (content included, D14);
  `planFileWrites` also returns the turn's resulting file set
- `functions/src/messages/handlers.ts` — `appendAssistantMessage` takes an `AssistantTurn` and
  stages the snapshot on the same batch (D4)
- `functions/src/generate.ts` — the snapshot plan threaded from `planFileWrites` to the batch; no
  change to any frame or payload
- `firestore.rules` — two deny-all blocks (D15)
- `tests/fixtures/llm/reply-alt.json` — **new**; `functions/src/llm/fake.ts` gains `__alt_files`
  (D24)
- `frontend/src/components/ui/sheet/` — **new**, vendored via the shadcn-vue CLI (D17)
- `frontend/src/lib/snapshotsApi.ts` — **new.** `listSnapshots`, `restoreSnapshot`, the wire types
- `frontend/src/lib/snapshots.ts` — **new, pure.** the version label, the origin label and the
  `N files · X KB` subtitle
- `frontend/src/lib/files.ts` — `formatBytes()` beside the existing `utf8Bytes()`
- `frontend/src/stores/workspace.ts` — the snapshot list and its lifecycle, `restoreSnapshot()` and
  the tab reconciliation (D22), the guards (D18) and the refetch rule (D21)
- `frontend/src/components/workspace/SnapshotSheet.vue` — **new.** trigger, sheet, loading, empty,
  error + Retry, rows, the inline confirm (D19)
- `frontend/src/components/workspace/EditorPanel.vue` — the trigger in the header
- `frontend/src/components/workspace/FileEditor.vue` — origin-neutral replaced notice (D22)
- `tests/integration/snapshots.spec.ts`, `tests/e2e/snapshots.spec.ts` — **new**
- `docs/IMPLEMENTATION_PLAN.md`, `docs/PRODUCT_SPEC.md` — §0/§4/§9 status and §7.2's `sheet` row

## Out of scope

| Not here | Picked up by |
|---|---|
| A **diff** between two versions, or between a version and the working set | Stretch S3 (F10.3) |
| Browsing or previewing a snapshot's file contents without restoring (D11) | Stretch S3 |
| Naming, annotating or pinning a version (D26) | Not planned |
| Deleting a version by hand (D11) — the prune is what bounds the collection | Not planned |
| Snapshotting a manual save (D23) | Not planned |
| Restoring a single file rather than the set (D7) | Not planned |
| A snapshot of the empty state, or restoring a project to no files (D27) | Not planned |
| Transactional `seq` allocation (D28) | Not planned |
| Content-addressed storage or dedup between versions (D3) | Not planned |
| Any change to the SSE protocol, the system prompt, or generation itself (D21) | — |
| Snapshot history for the *preview* — what a version rendered as | Slice 10 owns the preview; not planned |
| A skeleton or a toast for the sheet's loading and error states | Slice 12, where `skeleton` and `sonner` are decided |

## User flow

1. The user opens a project that has generated at least once. The code panel header shows **Code**
   and a **History** button.
2. They send a prompt. The reply streams, files appear, and at `done` the project's files are
   updated **and a copy of the whole set is stored** as version 1. Nothing on screen changes because
   of the copy.
3. They send a second prompt that rewrites `index.html` and adds `about.html`. That turn stores
   version 2 — the project's file set as it now stands, all four files.
4. They press **History**. The sheet slides in from the right, shows its loading state, then two
   rows newest-first: *Version 2 — Generation · 4 files · 14 KB · 18 Aug 2026, 09:12* and
   *Version 1 — Generation · 3 files · 11 KB · …*.
5. They press **Restore** on version 1. The row becomes *Restore this version?* with **Restore** and
   **Cancel**.
6. They confirm. The row shows a restoring state and every other **Restore** is disabled. The
   server copies the current four files to a new version marked *Before restore*, writes version 1's
   three files back, and deletes `about.html`.
7. The sheet's list refreshes — three rows now — the file tree drops to three files, the open
   `index.html` tab re-reads and shows version 1's code. A tab open on `about.html` closes.
8. If a tab had unsaved edits, its buffer is replaced and the editor says so until the next edit.
9. Reload. The tree, the file contents and the version list all come back from the server.
10. If the restore fails — the project is gone, the version is gone, the copy is unreadable — the
    sheet shows the server's message, **nothing in the project has changed**, and the row's Restore
    is available again.
11. While a generation is streaming, every **Restore** is disabled with a reason; the list still
    reads.

## Data model

**New collection: `users/{uid}/projects/{projectId}/snapshots/{snapshotId}`** — auto-id (D13).

| Field | Type | Note |
|---|---|---|
| `seq` | number | ≥ 1, monotone within the project (D5). The list orders by it; the UI renders *Version N* |
| `createdAt` | Timestamp | `serverTimestamp()`, resolved to the batch's one commit timestamp |
| `origin` | string | `'generation'` or `'restore'` (D9). Anything else makes the document unreadable |
| `fileCount` | number | ≥ 1 (D27). Rendered, **and** checked against the subcollection on restore (D8) |
| `totalBytes` | number | ≥ 0, the sum of the copied files' `size`. Rendered only |

**New collection: `users/{uid}/projects/{projectId}/snapshots/{snapshotId}/files/{fileId}`, where
`fileId` *is* the path** (D13).

| Field | Type | Note |
|---|---|---|
| `path` | string | Equal to the document id; the same `filePathSchema` the live collection uses |
| `content` | string | The bytes as they were stored at snapshot time |
| `size` | number | UTF-8 byte length, copied from the live document rather than recomputed |

No timestamps here: the snapshot document carries the one time that means anything about a copy.

**Caps.** ≤ 20 files per snapshot (by construction — `FILE_LIMIT` bounds the project), ≤ 20
snapshots per project with the oldest pruned on write (D6). A snapshot's subcollection is deleted
with it.

**Rules.** Two new deny-all blocks, with L3 tests in the same commit (D15):

```
match /users/{uid}/projects/{projectId}/snapshots/{snapshotId} {
  allow read, write: if false;
}
match /users/{uid}/projects/{projectId}/snapshots/{snapshotId}/files/{fileId} {
  allow read, write: if false;
}
```

Rules do not cascade, so the second block is required and is the one a reader must not assume the
first covers. Nothing else in the file changes.

**Indexes.** Unchanged (D16). `orderBy('seq')` in either direction is a single-field order;
`snapshots/{id}/files` is read without an order.

**The project document is not touched by a snapshot or a restore** — Slice 6's D31, unchanged.

**What a live file document loses on the way in:** an unreadable one (Slice 6, D13) is invisible to
`readStoredFiles`, so it is absent from the snapshot exactly as it is absent from the tree and from
a `GET`. A copy of a document nothing can read would be a copy of nothing.

## API contracts

Every error body is the existing envelope: `{ "error": "<user-facing message>", "code": "<machine
code>" }`. Both routes require an ID token with `email_verified`; the project is ownership-checked
before the collection is addressed, so absent, soft-deleted, unreadable and someone else's project
all collapse into one **404 `not_found`** (Slice 3, D14).

### `GET /api/projects/:projectId/snapshots` — new

Not attested (a plain authenticated read, the rule since Slice 2).

- **200** → `{ "snapshots": [ { "id": "aB3…", "seq": 2, "createdAt": "2026-08-18T09:12:04.113Z",
  "origin": "generation", "fileCount": 4, "totalBytes": 14022 } ] }` — ordered by `seq` descending,
  at most `SNAPSHOT_LIMIT` entries, **no file content on any entry**
- **200** → `{ "snapshots": [] }` for a project that has never generated
- **400** `invalid_id` · **404** `not_found` · **401** `unauthenticated` · **403** `email_unverified`

### `POST /api/projects/:projectId/snapshots/:snapshotId/restore` — new

**Attested** (a mutation). Body: none — parsed with `z.object({}).strict()`, so a body carrying
anything at all is a 400 rather than a payload we happened not to read.

- **200** → `{ "files": [ { "path": "app.js", "size": 4210, "createdAt": "…", "updatedAt": "…" } ],
  "changed": true }` — the project's file list as it now stands, ordered by path, no `content`
- **200** → `{ "files": […], "changed": false }` — the project already *was* this version; nothing
  was written (D10)
- **400** `invalid_id` — a malformed project id or snapshot id. No Firestore read
- **400** `invalid_body` — a request body was sent
- **404** `not_found` — the project or the snapshot is gone
- **409** `snapshot_unreadable` — the copy cannot be read whole; **nothing was written** (D8)
- **401** `unauthenticated` · **403** `email_unverified` · **401** `app_check_failed`

**Copy**, one sentence each:

| Condition | Copy |
|---|---|
| Unknown or unreadable **project** | `That project no longer exists.` (shared with every project route) |
| Unknown **snapshot** | `That version no longer exists.` |
| `snapshot_unreadable` | `That version could not be restored: part of it is unreadable. Nothing was changed.` |
| The batch failed | `That version could not be restored. Try again.` |

### `POST /generate` — unchanged

No frame, no payload and no field changes (D21). The only difference is behind it: a turn that
stores files now also stores a copy of the project's resulting file set, in the same commit.

## Edge cases and failure modes

| Situation | Behaviour | User sees | Retry? |
|---|---|---|---|
| First generation on an empty project | Files written; snapshot `seq: 1`, `origin: 'generation'`, holding those files | Nothing new until History is opened | n/a |
| A later generation rewriting **some** files | Snapshot holds the project's whole set — rewritten *and* untouched files (D1) | A version whose file count matches the tree | n/a |
| Prose-only reply (Slice 6, D17) | No files, **no snapshot** (D2) | The list is unchanged | n/a |
| Refused op set, unterminated block, duplicate path, over a cap | No files, **no snapshot** | Slice 6's `fileError`; the list unchanged | Retry |
| Truncated turn, mid-stream failure, refusal | No files, **no snapshot** | Slice 6's interrupted copy; the list unchanged | Retry |
| Client disconnects after a clean `end` | Files **and** snapshot commit (Slice 6, D10) | On return, the reply, its files and its version | n/a |
| The batch commit fails | Nothing written — message, files and snapshot together (D4) | "Something went wrong. Please try again." | Retry |
| The twenty-first version | The oldest snapshot **and its file documents** are deleted in the same batch (D6) | Twenty rows, the oldest gone | n/a |
| Restore of a version with a file the project no longer has | The file is recreated | It reappears in the tree | n/a |
| Restore of a version missing a file the project has (D7) | That file is **deleted** | It disappears from the tree | n/a |
| Restore of the version the project already is (D10) | Nothing written at all | The sheet closes; no new row | n/a |
| Restore into a project with no files | The snapshot's files are written; **no safety snapshot** (D9) | Files appear; one new row is not added | n/a |
| Restore with a dirty open tab | The buffer is replaced and it is announced (D22) | "Replaced by a newer version of this file." | n/a |
| Restore that deletes a file with an open tab | The tab is closed and its buffer dropped (D22) | The tab disappears | n/a |
| Restore while a generation is streaming (D18) | The action is disabled; the store refuses it even if reached another way | A disabled **Restore** with a reason | After the stream |
| Two restores clicked in quick succession | The second is refused while the first is in flight | Every **Restore** disabled until it settles | n/a |
| A snapshot whose files cannot be read whole (D8) | **409**, nothing written | "…part of it is unreadable. Nothing was changed." | n/a |
| Another user's project id, or a snapshot id from another project | **404** — the path composed from the token's uid names nothing | "That project no longer exists." / "That version no longer exists." | n/a |
| Two generations at once (D28) | Both commit; the `seq` may tie | Two rows labelled the same; restore still exact | n/a |
| The snapshot list request fails | The existing list is kept, not emptied | The message and **Try again** inside the sheet | Retry |
| The restore request fails | `files` untouched, no tab disturbed | The message inside the sheet, Restore available again | Retry |
| A client tries the `snapshots` collections directly | Denied by `firestore.rules`; there is no Firestore SDK in the frontend to try with | n/a | n/a |

## Acceptance criteria

**The pure boundary (D1, D5, D6, D10)**

- **AC-1** — Given a stored set `{a.js, index.html}` and writes `{index.html', about.html}`, when
  the resulting set is merged, then it holds three entries, `index.html` carries the **write's**
  content and size, `a.js` is unchanged, and the result is ordered by path; given writes only
  (an empty project), then the result is exactly the writes; given no writes, then the merge is not
  called at all (D2).
- **AC-2** — Given no existing snapshots, then the next `seq` is 1; given heads with a maximum
  `seq` of 7, then the next is 8; given heads whose `seq` values have gaps, then the next is still
  maximum + 1.
- **AC-3** — Given fewer than `SNAPSHOT_LIMIT` existing snapshots, then nothing is pruned; given
  exactly `SNAPSHOT_LIMIT`, then the single lowest-`seq` snapshot is pruned; given
  `SNAPSHOT_LIMIT + 2` (an invariant already broken), then the three lowest are pruned so the
  collection lands at the cap after the write.
- **AC-4** — Given two file sets with the same paths and byte-identical contents, then they compare
  equal; given one differing byte, one extra path, or one missing path, then they do not.
- **AC-5** — Given a valid snapshot document, then it parses; given `origin: 'manual'`, a `seq` of
  0, a `fileCount` of 0, or a missing `totalBytes`, then it is unreadable; given a snapshot file
  document whose `path` differs from its id, then it is unreadable.

**The write path — over the wire (D2, D4, D6)**

- **AC-6** — Given a completed generation that writes three files to an empty project, when the
  stream ends, then exactly one snapshot document exists with `seq: 1`, `origin: 'generation'`,
  `fileCount: 3` and `totalBytes` equal to the sum of the files' sizes, and its `files`
  subcollection holds three documents whose ids, paths, contents and sizes are byte-identical to
  the project's files.
- **AC-7** — Given a project holding three files, when a generation rewrites one of them and adds a
  fourth, then the new snapshot has `seq: 2` and `fileCount: 4`, and its copy of the **untouched**
  file is present and equal to the stored one.
- **AC-8** — Given `__no_files`, `__bad_path`, `__unterminated`, `__dup_files`, `__max_tokens` or
  `__fail_midstream`, then **no snapshot document is created** and the snapshot count is exactly
  what it was before the turn.
- **AC-9** — Given a turn with files and a snapshot, then the message, every file write, the
  snapshot document, its file documents and any prune are staged on **one** `WriteBatch` and
  committed **once** — asserted against a recording batch, so a second commit or an unstaged write
  fails the test rather than the reviewer's attention.
- **AC-10** — Given a project already holding `SNAPSHOT_LIMIT` snapshots, when another generation
  stores files, then the project holds exactly `SNAPSHOT_LIMIT` snapshots, the lowest-`seq` one is
  gone, **its file documents are gone**, and the newest carries the highest `seq`.

**Listing (D5, D11)**

- **AC-11** — Given a project with three snapshots, when the caller lists them, then they come back
  ordered by `seq` descending, each entry carries `id`, `seq`, `createdAt`, `origin`, `fileCount`
  and `totalBytes` and **no content**, and the list is capped at `SNAPSHOT_LIMIT`; given a project
  with none, then `{ snapshots: [] }`.

**Restore (D7, D8, D9, D10, D12)**

- **AC-12** — Given a project generated twice, where the second turn changed `index.html` and added
  `about.html`, when the caller restores the first snapshot, then every file's content is
  byte-identical to that snapshot's, `about.html` **no longer exists**, the response's `files`
  equals a fresh `GET …/files`, and `changed` is `true`.
- **AC-13** — Given the same restore, then a new snapshot exists with `origin: 'restore'` and the
  highest `seq`, holding the file set as it was **before** the restore — and restoring *that*
  snapshot returns the project to the later version.
- **AC-14** — Given a project whose files already equal a snapshot, when that snapshot is restored,
  then **no document is written**: no new snapshot, no file `updatedAt` advanced, and the response
  carries `changed: false`.
- **AC-15** — Given a project with no files at all, when a snapshot is restored, then its files are
  written and **no safety snapshot is created**.
- **AC-16** — Given a snapshot whose `files` subcollection holds fewer documents than its
  `fileCount`, or one of whose file documents fails to parse, then the restore answers **409
  `snapshot_unreadable`**, no file is created, deleted or modified, and no snapshot is written.
- **AC-17** — Given verified users alice and bob and a snapshot of bob's, when alice lists or
  restores it, then every answer is `404` and bob's files and snapshots are unchanged; the same for
  a soft-deleted project, a snapshot id from a different project of alice's own, and a
  never-existing id; given a malformed project id or snapshot id, then `400 invalid_id` and no
  Firestore read.
- **AC-18** — Given a restore of a 20-file snapshot over a project holding 20 **different** files,
  then the project ends with exactly the snapshot's 20 and `FILE_LIMIT` is never exceeded at any
  point.
- **AC-19** — Given no `Authorization` header, then both snapshot routes answer `401
  unauthenticated`; given `email_verified: false`, then `403 email_unverified`; given a request
  body on the restore route, then `400 invalid_body`; and the router table shows the restore route
  carrying the App Check guard while the list does not.

**Rules — the backstop (D15)**

- **AC-20** — Given any client — the owner, another signed-in user, an anonymous one — when it
  reads, lists, creates, updates or deletes either
  `users/{uid}/projects/{projectId}/snapshots/{snapshotId}` or that snapshot's
  `files/{fileId}`, then every operation is denied.
- **AC-21** — Given any client, when it touches `users/{uid}`, a project, its `messages`, its
  `files`, `hlConnections/{uid}` or `authThrottle/{key}`, then it is denied — re-asserted.

**The client library (D11, D12)**

- **AC-22** — Given `listSnapshots` and `restoreSnapshot`, then each issues the documented method
  and path with both ids percent-encoded, `restoreSnapshot` sends **no body**, and no
  `firebase/firestore` import exists anywhere under `frontend/src`.

**The store (D18, D21, D22)**

- **AC-23** — Given `loadSnapshots()`, then `snapshotsLoading` and `snapshotsLoaded` follow the
  request and the list is replaced on success; given a failure, then `snapshotsError` is set and
  any existing list is left in place.
- **AC-24** — Given `restoreSnapshot(id)`, then `restoringId` is set for the length of the request,
  `files` is replaced by the response's list, `restoringId` is cleared however it ends, and the
  snapshot list is refetched; given a failure, then `restoreError` is set and `files`, `openTabs`
  and every buffer are untouched.
- **AC-25** — Given open tabs on `index.html` and `about.html` and a restore whose set holds only
  `index.html`, then `index.html` is re-read from the server, `about.html`'s tab is closed and its
  buffer dropped, and if `index.html`'s buffer was dirty then its `replaced` flag is set.
- **AC-26** — Given `generating` is true, or a restore is already in flight, then
  `restoreSnapshot()` issues **no request**.
- **AC-27** — Given a `done` carrying written files, then the snapshot list is refetched **only if**
  it has been loaded this session; given a `done` with no files, then no snapshot request is issued
  at all.
- **AC-28** — Given `reset()` or another project being opened, then every snapshot field returns to
  its initial value, and a list or restore response in flight cannot repopulate it.

**The components — loading, empty and error on a new screen (D17, D19)**

- **AC-29** — Given the code panel, then its header renders a **History** trigger in both layouts;
  given the sheet is closed, then no snapshot request has been issued; given it is opened, then
  `loadSnapshots()` is called and the loading state renders; given a loaded empty list, then "No
  versions yet."; given a failure, then the message and a **Try again** that calls
  `loadSnapshots()`; given three snapshots, then three rows newest-first, each showing *Version N*,
  its origin label, its file count, its size and its date and time.
- **AC-30** — Given a row's **Restore**, then it becomes a two-step confirm; **Cancel** returns the
  row unchanged and issues nothing; confirming calls `restoreSnapshot(id)`; while one is in flight
  every row's Restore is disabled and the row being restored says so; given `restoreError`, then it
  renders inside the sheet; given `generating`, then every Restore is disabled with a reason and
  the list still renders.
- **AC-31** — Given a buffer a restore replaced, then `FileEditor`'s notice renders and its text
  names neither a generation nor a restore specifically.

**End to end**

- **AC-32** — Given a verified account, when the user generates, generates again with a reply that
  changes one file and adds another, opens **History**, and restores version 1, then the sheet
  lists two versions before the restore and three after, the editor shows version 1's `index.html`,
  the file version 2 added is gone from the tree, and all of it survives a page reload.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1 | L1 | `functions/src/snapshots/plan.spec.ts` | The resulting-set merge: writes win, untouched files kept, ordered |
| AC-2, AC-3 | L1 | `functions/src/snapshots/plan.spec.ts` | Next `seq`; what the prune selects at, under and over the cap |
| AC-4 | L1 | `functions/src/snapshots/plan.spec.ts` | Set equality, and each of the three ways to differ |
| AC-5 | L1 | `functions/src/snapshots/schema.spec.ts` | Stored shapes, the origin allowlist, the `id === path` invariant |
| AC-6, AC-7 | L4 | `tests/integration/snapshots.spec.ts` | One snapshot per storing turn, holding the project's whole set |
| AC-8 | L4 | `tests/integration/snapshots.spec.ts` | Six non-storing turns write no snapshot |
| AC-9 | L1 | `functions/src/messages/handlers.spec.ts` | One batch, one commit, everything staged on it |
| AC-10 | L4 | `tests/integration/snapshots.spec.ts` | The prune, including the pruned snapshot's file documents |
| AC-11 | L4 | `tests/integration/snapshots.spec.ts` | The list: order, fields, the cap, the empty case |
| AC-12, AC-13 | L4 | `tests/integration/snapshots.spec.ts` | Round-trip fidelity, deletion, and the safety snapshot restoring back |
| AC-14, AC-15 | L4 | `tests/integration/snapshots.spec.ts` | The no-op restore; a restore into an empty project |
| AC-16 | L4 | `tests/integration/snapshots.spec.ts` | A short and a corrupt subcollection: 409, nothing written |
| AC-17, AC-19 | L4 | `tests/integration/snapshots.spec.ts` | Cross-tenant, soft-deleted, malformed, unauthenticated, unverified, body |
| AC-18 | L4 | `tests/integration/snapshots.spec.ts` | A 20-file restore over 20 different files |
| AC-19 | L1 | `functions/src/index.spec.ts` | The deployment surface: which snapshot route is attested |
| AC-20, AC-21 | L3 | `tests/rules/firestore.spec.ts` | Both new collections denied to every client; prior denials re-asserted |
| AC-22 | L1 | `frontend/src/lib/snapshotsApi.spec.ts` | Method, path, encoding, absent body |
| AC-22 | L1 | `frontend/src/lib/no-firestore.spec.ts` | Existing scan, unchanged |
| AC-23, AC-24 | L1 | `frontend/src/stores/workspace.spec.ts` | List and restore lifecycles, success and failure |
| AC-25 | L1 | `frontend/src/stores/workspace.spec.ts` | Tab reconciliation after a restore |
| AC-26, AC-27, AC-28 | L1 | `frontend/src/stores/workspace.spec.ts` | The guards, the conditional refetch, reset and staleness |
| AC-29, AC-30 | L2 | `frontend/src/components/workspace/SnapshotSheet.spec.ts` | Trigger, loading, empty, error + Retry, rows, confirm, disabled states |
| AC-29 | L1 | `frontend/src/lib/snapshots.spec.ts` | The version, origin and `N files · X KB` labels |
| AC-29 | L2 | `frontend/src/components/workspace/EditorPanel.spec.ts` | The header renders the trigger |
| AC-31 | L2 | `frontend/src/components/workspace/FileEditor.spec.ts` | The origin-neutral replaced notice |
| AC-32 | L5 | `tests/e2e/snapshots.spec.ts` | Generate → generate → History → restore → reload |

## Definition of done

- [ ] Every acceptance criterion above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`,
      `test:e2e`
- [ ] **Both** new collections — `snapshots/{snapshotId}` and its `files/{fileId}` — have rules
      **and** L3 rules tests in the same commit as the first write
- [ ] `firestore.indexes.json` is unchanged, and the review checks that claim against the list and
      prune queries rather than against D16
- [ ] No path exists that writes a snapshot without its files, or files without their snapshot:
      one batch, one commit (AC-9)
- [ ] No path exists that restores **part** of a version (D8), and none that leaves a file a
      restored version does not hold (D7)
- [ ] The snapshot sheet ships with loading, empty and error states, and the code panel's existing
      states still pass
- [ ] `sheet` was added with `npx shadcn-vue@latest add sheet` and any deviation from upstream
      carries the comment `PRODUCT_SPEC.md` §7.2 requires
- [ ] `messages.stream()` is still the only LLM call shape, and the SSE protocol is byte-for-byte
      what Slice 6 left (D21)
- [ ] No `firebase/firestore` import anywhere under `frontend/src`; every snapshot read and write
      goes through a Cloud Function route scoped by the token's uid
- [ ] No secrets in source; no configuration added, so `.env.example` is unchanged — stated rather
      than assumed
- [ ] Runs clean on `npm run dev` (emulators) from a fresh clone: generate twice, restore the first
      version, reload, and the files are version one's
- [ ] `IMPLEMENTATION_PLAN.md` §0 status, §4 Slice 11 and §9's rows for F5.2, F5.3, F6.6 and the
      shadcn inventory updated; `PRODUCT_SPEC.md` §7.2's `sheet` row marked shipped
- [ ] PR opened with demo evidence: two versions listed, one restored, a file deleted by the
      restore; **human approves before merge**

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Snapshotting the turn's writes instead of the project's file set.** It is the smaller, more obvious implementation — the writes are right there in the plan — and it passes any test that generates once. It fails the first time a turn rewrites a subset, and the symptom is a restore that produces an app missing files, which looks like a restore bug rather than a snapshot bug. | D1 makes the merge a **pure function with its own tests** (AC-1) rather than an expression inside the terminal handler, and AC-7 asserts the untouched file is in the copy — over the wire, on a second generation. The design companion draws the two shapes side by side, because this is the decision the slice turns on. |
| R2 | **The 1 MiB document limit.** An inline map of files is the tidier-looking model and it is writable for every small project, so it would pass every test and every manual check — and fail in production on exactly the projects with the most code in them. | D3, with the arithmetic in the decision itself (20 × 100,000 > 1,048,576). The subcollection is also what makes the copy structurally identical to the live collection, so the merge, the equality check and the restore each loop over one shape. A reviewer tempted to simplify it back has the number in front of them. |
| R3 | **A restore that does not delete** leaves a hybrid of two versions: version one's `index.html` beside version two's extra file. It is the same class of failure as Slice 6's half-applied op set, and it is invisible in the tree — the app just breaks in the preview. | D7 makes the delete part of the definition, and AC-12 asserts the negative (`about.html` no longer exists) rather than only the positive. `__alt_files` (D24) exists so that negative is assertable at all — with one fixture, both versions are identical and a no-op restore passes. |
| R4 | **Unbounded snapshot growth**, made worse by the safety snapshot: every restore writes a version, so a user exploring their history multiplies storage while looking at it. | D6's cap and prune, in the same batch as the write that causes it, with AC-10 asserting the **file documents** of the pruned snapshot are gone too — deleting the parent alone leaves an orphaned subcollection, which is the mistake this row exists to name. |
| R5 | **A snapshot committed outside the turn's batch.** It is the easy refactor: `planFileWrites` already returns a plan, and writing the snapshot in its own commit afterwards is one line shorter. It leaves a crash window in which the files moved and the history did not. | D4 keeps `appendAssistantMessage` as the single owner of the batch and AC-9 asserts it against a recording batch, so a second `commit()` is a red test rather than a review catch. |
| R6 | **A missing composite index is this project's recurring production-only failure** — Slices 3 and 4 both paid for one and the emulator does not enforce them. | D16: every snapshot query orders by one field or by nothing. The claim is in the definition of done as something the review verifies against the queries. |
| R7 | **Two writers for one file document again** — a restore and a generation's batch. Slice 6 closed the editor-versus-generation window (D21); this opens a new one. | D18 disables Restore for the length of a stream and the store re-checks `generating`, so the component and the boundary say the same thing. The residue is last-write-wins, consistent with D23, and the failure is loud rather than silent: the tree refetches either way. |
| R8 | **The nested collection could ship without rules.** A block on `snapshots/{snapshotId}` reads like coverage, and the documents that actually hold the generated code live one level below it, where rules do not cascade. | D15 names both blocks explicitly, AC-20 tests both, and the definition of done asks for both by name. It is the same trap `messages` and `files` each carried; this is the first slice where one block could plausibly be mistaken for two. |
| R9 | **`npx shadcn-vue@latest add sheet` needs the network**, and the unattended session may not have it. Hand-writing the primitive from memory would break §7.2's provenance rule. | If the CLI cannot run, the component is vendored from the pinned upstream source with the deviation comment §7.2 requires and the **build log says so explicitly**, so the review checks provenance by diff rather than by trust. `reka-ui` is already a dependency, so no new runtime package is involved either way. |
| R10 | **Changing `appendAssistantMessage`'s signature** touches tests written in Slices 4, 5 and 6, and a wide mechanical diff is where a review stops reading. | The change is one grouping — four positional arguments become one `AssistantTurn` object — made in its own commit, before any snapshot behaviour lands on it. The build order in D29 puts it after the pure boundary and before the routes, so it is a small, self-contained diff a reviewer can dismiss in one pass. |
| R11 | **The extra read.** `readStoredFiles` pulls up to 2 MB per generation where `readFilePaths` pulled 20 references, on the hottest and most expensive path in the product. | Measured against what it replaces rather than against zero: it is the same round trip, on a request that has just spent seconds and real money on an LLM call, for the data F5.2 requires by name. The alternative — a second read only when a snapshot is due — moves the same bytes one round trip later (D14). If it ever needs bounding, the lever is `FILE_BYTES_MAX`, not the snapshot. |

## Blocked

Nothing. Every question this slice raises is answered above.
