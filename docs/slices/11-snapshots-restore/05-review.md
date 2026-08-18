# Slice 11 — Snapshots & restore · Review

**Reviewed:** 2026-08-18 · **Branch:** `slice/11-snapshots-restore` · **Base:** `main` at `e6dd2d9`
· **Diff:** 51 files, ~9,000 insertions (of which ~3,000 are the slice's own docs and ~1,400 the
published PRD companion)

Reviewed as another author's PR. The diff was read in full first, then six axes were run
concurrently — correctness, security, architecture, performance, readability/test-quality, and one
lane whose only job was to open every test the build log's AC table names and check it asserts what
it claims. Every finding below was re-verified against the code before it was written down;
the ones that could not be reproduced are listed under *Claims dropped*.

## Suite

Baseline counts are the orchestrator's `gate-post-build.1.log` on `0778bc5`. The "after" column is
this session's own run, following the fixes.

| Check | Before | After | Result |
|---|---|---|---|
| `typecheck` (functions, frontend, root) | clean | clean | ✅ |
| `lint` (functions, frontend, `--max-warnings 0`) | clean | clean | ✅ |
| `prettier --check` on the slice's files | **9 files failing** | clean | ✅ fixed |
| `test:unit` — functions | 42 files / 1000 | 42 files / **1007** | ✅ +7 |
| `test:unit` — frontend | 63 files / 843 | 63 files / **848** | ✅ +5 |
| `test:unit` — scripts | 3 files / 21 | 3 files / 21 | ✅ |
| `test:rules` | 1 file / 52 | 1 file / **52** | ✅ |
| `test:integration` | 16 files / 373 | 16 files / **374** | ✅ +1 |
| `test:e2e` | 17 | **17** | ✅ |

`firestore.indexes.json` unchanged — verified against the queries, not against D16: every snapshot
query is `orderBy` on one field (`seq` desc in the list), a plain unordered collection read (the
copies, the heads after this review's fix), or a document `get`. No composite index is implied.
`.env.example`, `package.json` and both lockfiles are unchanged — the shadcn CLI's stray
`@lucide/vue` install was reverted as the build log claims, confirmed by an empty diff.

## AC coverage

The AC-audit lane opened every test named in `04-build-log.md`. **All 32 criteria map to tests that
assert them.** Four had unasserted clauses; three are fixed here (F5, F6, F7) and one is recorded
as accepted below.

| AC | Verdict | Note |
|---|---|---|
| AC-1 … AC-12, AC-14, AC-15, AC-19, AC-21 … AC-32 | Covered | Verified by reading the tests, not the matrix |
| AC-13 | Covered — **strengthened** | The undo-of-the-undo asserted the restored *paths* only; wrong bytes would have passed. Now asserts contents byte for byte |
| AC-16 | Covered — **strengthened** | The corrupt-document path asserted files unchanged but not "no snapshot written"; the missing-document path did. Now both do |
| AC-17 | Covered — **strengthened** | The `400 invalid_id` case was *named* "before any read" and asserted only the status. Now asserted at L1 with `getDb` throwing, for a malformed project id, a malformed version id and a request body |
| AC-18 | Covered — **strengthened** | "`FILE_LIMIT` is never exceeded at any point" rested on the restore being one batch, which **nothing tested**. Now asserted against a recording batch (F2) |
| AC-20 | Covered, with a caveat worth recording | The L3 cases pass against a rules file with both blocks deleted, because Firestore default-denies. They prove the behaviour, not that the blocks exist. The build log says so and verified it by reverting the file. R8 was closed by review, not by test — and this review re-checked both blocks are present |

## Findings

Ordered by leverage. Severity is mine: an axis lane has no view of the PRD's decisions table, and
several of its "defects" are deliberate trade-offs recorded there.

| # | Severity | Finding | Action taken |
|---|---|---|---|
| **F1** | **Required** | **A snapshot document that loses its `seq` is invisible to the prune forever.** `readSnapshotHeads` read `orderBy('seq','asc').select('seq')`, and Firestore omits documents that do not carry the ordered field — so such a head was returned by neither that read nor `readSnapshotList`. It was never listed, never counted toward the prune's excess, never selected, and it and its up-to-20 file documents (≤2 MB) were paid for forever. That is exactly the orphan `PrunedSnapshot`'s own doc comment exists to prevent, reached from the one direction it does not cover. The function's comment claimed the opposite in as many words — *"A document whose `seq` is missing … is read as `0`, which sorts it to the front of the prune"* — which is true only for a wrong-*typed* `seq`, never an absent one. Found independently by the correctness, security and architecture lanes. | **Fixed.** The `orderBy` is gone; neither consumer needs it (`planSnapshotSeq` takes a maximum, `planSnapshotPrune` sorts its input), and its only effect was to filter out the row that mattered. Test-first at two levels: an L1 case pinning the unordered projection and the `seq → 0` fallback pruning first, and an **L4 case** — the only level that can show it, since the exclusion happens inside Firestore. The L4 case was confirmed red against the old query and green against the fix |
| **F2** | **Required** | **Nothing tested that the restore is one batch, one commit.** The PRD's definition of done says "no path exists that writes a snapshot without its files, or files without their snapshot: one batch, one commit", and AC-18 rests on it — but AC-9's recording-batch test covers `appendAssistantMessage` only, there was no unit test for `handleRestoreSnapshot` at all, and the L4 case for AC-18 inspects the end state. Splitting the restore into a write commit and a delete commit — R5's shortcut, one collection over — would have left the entire suite green while a full project passed transiently through 40 files, with a crash between the two leaving it there | **Fixed.** A `handleRestoreSnapshot` unit suite against a recording Firestore: the safety snapshot, its copies, the version's writes and the deletes are asserted on **one** batch with **one** commit, and the no-op opens none. Verified by mutation — splitting the commit turns it red |
| **F3** | **Required** | **A failed *refetch* wiped the version list the store had deliberately kept.** The store keeps the existing list on a failed `loadSnapshots` (AC-23) precisely so the sheet never says "this project has no versions" when it means "we could not reach the server" — and the sheet's `v-if="snapshotsError"` branch then rendered the error *instead of* the rows, throwing that away at the last step. Reachable without any error path: sheet open on a loaded list, a generation finishes behind it, its `done` refetch fails, and twenty rows the user was reading disappear | **Fixed.** The failure now renders **above** the list, exactly as a failed restore already did, and the list stays. The loading and empty branches are guarded on `snapshotsLoaded`/`snapshotsError` so a failed *first* load still shows neither a skeleton that never resolves nor a false empty state. Two L2 cases, both red first |
| **F4** | **Required** | **`send()` had no guard against an in-flight restore, so a stale file list could be applied over newer state.** D18 refuses a restore while a generation is streaming, because the two are writers for one set of documents. The reverse was open: the composer stays live during a restore, and a generation committing after the restore's server-side read leaves the restore's response a version behind. Applying it drops the file the generation just wrote out of the tree and closes the tab opened for it, while the file sits on the server. `current(gen)` cannot catch this — `generation` is bumped only by `open()`/`reset()`. Server state is unharmed (the generation's batch commits last); the damage is the client disagreeing with Firestore until something refetches | **Fixed.** `restoringId` joins `generating` in both the `send()` guard and `canSend`, so the composer shows a visible cause rather than swallowing the submit. The draft is kept, exactly as the `generating` guard keeps it. One L1 case, verified red without the guard |
| **F5** | **Required** | **A restore never cleared `filesError` / `filesLoaded`.** D12 makes the restore's response *be* the refetch, so it wrote `files` directly — but `loadFiles` is the tree's only other writer and it sets all three, and `FileTree.vue` renders on `filesError` first. A project whose initial `GET /files` failed therefore kept showing **Try again** over a tree a successful restore had just rewritten: every file changed on the server and the panel said the files could not be loaded | **Fixed**, test-first. Three flags, not one |
| **F6** | **Required** | **`RESTORE_FAILED` was written and never wired.** The PRD's copy table specifies *"That version could not be restored. Try again."* for a failed batch; an uncaught rejection reached `errorHandler` as a generic `{error:'Internal error',code:'internal'}`. The sentence matters because the batch is all-or-nothing: the one thing worth telling the caller is that nothing was written and retrying is safe | **Fixed**, test-first. `batch.commit()` is wrapped, the cause is logged through the same `describeError` redaction `errorHandler` uses, and the caller gets the PRD's sentence. The response *code* stays `internal`, so the route's documented code set does not grow |
| **F7** | Required (tests only) | Three negative clauses the tests claimed but did not assert: AC-17's "and no Firestore read", AC-16's "no snapshot is written" on the corrupt-parse path, AC-13's undo-of-the-undo asserting paths but not bytes | **Fixed.** See the AC table above |
| **F8** | Required (hygiene) | **Nine of the slice's files failed `prettier --check`.** `CLAUDE.md` gives Prettier ownership of formatting and ESLint does not enforce it, so CI could not catch this. Confirmed a regression, not a pre-existing repo state: `main` fails on a disjoint set of eight older files | **Fixed** on the slice's files only. `main`'s eight are not this slice's to touch |
| **F9** | Optional | Dead code: `RESTORE_FAILED` (unreferenced), `snapshotFilesPath` (referenced only by its own test, while `readSnapshotFiles` composed the same path inline), `readSnapshot` returning a `seq` no caller reads | **Fixed** — see step 9 below |
| **F10** | Consider | **The restore's delete set comes from `readStoredFiles`, which is capped at `FILE_LIMIT` and drops unparseable documents.** A project holding more than 20 file documents — reachable only through the concurrent-writer race D28 already accepts — would have files outside the read window that the restore cannot delete, producing the hybrid D7 forbids; and a corrupt live document is immune to the delete loop and invisible to `filesEqual`, so a restore can answer `changed: false` with it still there | **Recorded, not changed.** Both halves need an already-broken invariant that only the accepted D28 race can produce, and the remedy (a second, uncapped id read on the hottest path) trades a real cost for an unreachable case. Named here so a future change to `FILE_LIMIT` or to the write path revisits it rather than inherits it |
| **F11** | Consider | **`planSnapshotPrune` is unbounded, and the batch it feeds is not.** Worst case is `42 + 21P` ops against Firestore's 500, so the batch overflows at 41 heads — and the only code path that prunes is the batch that would overflow, so a project past that point could never generate or restore again. Not reachable at the current config (`maxInstances: 10` with CPU < 1 forcing concurrency 1 caps the collection at ~29 heads), but the bound is a deploy knob rather than a designed one | **Recorded, not changed.** A `MAX_PRUNE_PER_TURN` cap needs a second `orderBy('seq','desc').limit(1)` read for `planSnapshotSeq`, which is new behaviour beyond this slice's brief. F1's fix shrinks the exposure — a seq-less head is now counted and pruned instead of accumulating silently |
| **F12** | Consider | **After a restore the client re-fetches up to 20 open tabs one at a time**, for bytes `handleRestoreSnapshot` held in memory one request earlier: 20 invocations, ~40 reads, 20 serial round trips. The largest avoidable cost in the slice | **Recorded, not changed.** Removing it means putting `content` on the restore response, which contradicts D12's shape and is a wire change. Worth a slice if restore latency is ever measured as a problem |
| **F13** | Consider | **`frontend/src/stores/workspace.ts` is 1,299 lines** (615 excluding comments; its spec is 3,108), exposing ~40 members and 13 actions over five concerns. This slice added 253 lines to an already-large file. `clearFileState`/`clearSnapshotState` are the seam | **Recorded, not changed.** Extracting composables under `stores/workspace/` keeps D24's single store id and the public surface; it is a refactor, and a change that refactors *and* adds behaviour is two changes. Flagged for whoever opens this file next |
| **F14** | Consider | **`files/handlers.ts` imports `mergeSnapshotFiles` from `snapshots/plan.ts`**, while `snapshots/` imports `files/` — a module-level cycle, and the older collection module now cannot be read without the feature built on it. The function is not snapshot arithmetic: it is "the project's file set after these writes" | **Recorded, not changed.** Moving it to `files/schema.ts` as `applyFileWrites` deletes the edge and is a rename plus an import change — but it touches a hot path with no behavioural gain, so it belongs in its own commit, not in a review |
| **F15** | Consider | **`FileWriteOutcome` is optional-field soup.** `{writes, resulting, error|null}` permits nine combinations where three are legal, and three of five return sites must now remember `writes: [], resulting: []` in lockstep. `generate.ts` then tests `plan.writes.length > 0` where it means "this turn stored files" | **Recorded, not changed.** The discriminated union (`rejected` / `none` / `written`) is right and is what `typescript-vue.md` asks for; it is also a refactor of Slice 6's type touching four call sites |
| **F16** | Consider | **21× storage multiplier**: at both caps a project holds 40 MB of snapshot copies against 2 MB of live files, in ~420 extra documents. Also: `content` is auto-indexed on every copy, ~800 dead index entries per project | **Recorded, not changed.** The storage is D3 and R4 working as designed and dedup is listed *Not planned*; the index exemption is a `fieldOverrides` config change that applies equally to the pre-existing live `files.content` and belongs with that decision, not this slice |
| **F17** | FYI | **The restore is a batch, not a transaction**, so two concurrent API calls (the store guard is not a server control) can exceed `FILE_LIMIT` or tie a `seq` | Deliberate and documented: D28 makes the same trade as `liveProjectCount`, `messageCount` and `readFilePaths`, and R7 states the residue. Impact is confined to the caller's own project, and the `seq` tie is cosmetic because restore addresses by document id |
| **F18** | FYI | **`snapshotIdSchema` admits Firestore's reserved `__x__` ids**, which the Admin SDK accepts client-side (verified) and the backend rejects — a 500 where every other malformed id is a 404 | Pre-existing in `projectIdSchema` too, so fixing it here would leave the codebase inconsistent by one segment. It is a log-noise and error-shape wart, not an access-control one. Recorded for whoever tightens both |
| **F19** | FYI | **Restoring the oldest version while at the cap prunes that version**, because the safety snapshot pushes it out. The restore itself is unaffected — the copy is read into memory first — but the version the user just restored to disappears from the list | An inherent consequence of D6's cap. Correct, surprising, and worth knowing |
| **F20** | FYI | The PRD's edge-case table says a no-op restore closes the sheet. It does not; the row's spinner simply stops, which is indistinguishable from a click that did nothing | **Decided: keep the implementation, and the PRD row is stale.** Closing the sheet is *less* informative than leaving it open — the user would get no explanation at all. The honest fix is a toast, and `sonner` is Slice 12's by this slice's own out-of-scope table. No AC covers it |
| **F21** | Nit | Several assertions are tautological: `expect(SNAPSHOT_LIMIT).toBe(20)` (should be `toBe(FILE_LIMIT)`, which its own comment names as the invariant); `expect(SNAPSHOT_LIMIT + 2 - pruned.length + 1).toBe(SNAPSHOT_LIMIT)`; `not.toBe('')` against a hard-coded sentence; `planFileWrites`'s `resulting` compared against `mergeSnapshotFiles` itself. Also 25 `?? ''` snapshot-id fallbacks in the integration spec that turn a broken fixture into a passing 404 | **Recorded, not changed.** None weakens a real assertion — each sits beside a literal one with teeth — and rewriting 25 call sites in a green suite trades review risk for tidiness |
| **F22** | Nit | `Math.max(1, …)` in `formatBytes` is unreachable behind its own `bytes < 1000` guard, and the doc comment concedes it mid-paragraph | **Decided: keep.** It states the invariant the branch above relies on, and the comment already says it cannot fire today. Deleting it makes the 1000 threshold load-bearing in two places instead of one |

### Claims dropped

Reported by a lane, checked, and not reproduced or not defects:

- **Path traversal through a snapshot file's stored `path` on restore.** `filePathSchema` excludes
  `/` by character class and `..` by an explicit refine, and `parseSnapshotFile` additionally
  requires `id === path`. Verified: `collection.doc(path)` and `getDb().doc(...)` cannot have their
  segment count changed by any input that reaches them.
- **Cross-tenant reachability.** Every path is composed from the token's uid; there is no
  `ownerUid` field and no equality check to get wrong. The L4 suite proves another user's version,
  a soft-deleted project, and a version id from a different project of the caller's own all 404.
- **`select()` is cheap.** The lane is right that Firestore bills per document returned regardless
  of projection, so `readSnapshotHeads` is 20 billed reads and not a free ref-scan — but the code's
  comment claims bandwidth, not cost, and the same phrasing predates this slice in `messageCount`
  and `liveProjectCount`. Not a defect in this diff.
- **`SnapshotHead.id` is dead.** It is populated by `readSnapshotHeads` and is the natural shape of
  a head; only the accompanying test's *reason* ("the id is what the batch deletes") is wrong — the
  batch deletes `ref`. Left alone.
- **The sort in `SnapshotSheet`'s `rows` computed.** ≤20 metadata rows, re-run only on array
  identity change. The component documents why a rendering rule should not depend on a query it
  cannot see.

## Genesis-specific checks

- **API-only data access.** No `firebase/firestore` import anywhere under `frontend/src` — the
  existing `no-firestore.spec.ts` scan covers the new files automatically and was re-run. Both
  routes verify the ID token *and* `email_verified` via `withVerifiedUser`, parse with Zod, and
  scope every query by the token's uid.
- **No user identifier in a route.** `/api/projects/:projectId/snapshots` and
  `…/:snapshotId/restore` name resources only; `index.spec.ts` asserts the absence of `:uid` and
  `/me` structurally.
- **Rules for both new collections**, in the same commit as the first write, with L3 denial tests
  for the owner, another verified user and an anonymous client across get/list/create/update/delete
  on **both** paths — including the nested one that rules do not cascade into (R8). The nested
  create cases carry hostile JavaScript, which is the point of the block.
- **Attestation.** The restore — the only route in the codebase that deletes a user's files —
  carries `requireAppCheck`; the list does not, matching every read route since Slice 2. Both
  asserted structurally, because `requireAppCheck` short-circuits under the emulator.
- **Nothing partial is persisted.** One batch per turn and one per restore, both now proven by a
  recording batch. A 409 is raised before any batch is opened.
- **Streaming untouched.** No frame, payload or field changed; `messages.stream()` is still the only
  LLM call shape.
- **Secrets.** None in source; no configuration added, so `.env.example` is correctly unchanged.
- **States.** The new screen ships loading, empty and error — and after F3, an error that does not
  destroy the list behind it.
- **Scope.** The diff matches the PRD's in-scope list file for file. No unrequested behaviour.

## Dead code (step 9 — decided, not asked)

There is no one to ask, so these are decided and recorded:

- `RESTORE_FAILED` (`snapshots/schema.ts`) — **kept and wired** (F6). It was not dead by intent, it
  was unfinished: the PRD specifies the sentence.
- `snapshotFilesPath` (`snapshots/schema.ts`) — **kept and now used** by `readSnapshotFiles`, which
  had rebuilt the same path inline. The module header claims one place composes each path; it now
  does.
- `readSnapshot`'s `seq` — **removed.** The return is narrowed to `{ fileCount }`, which is the only
  field a restore uses it for.
- `Math.max(1, …)` in `formatBytes` — **kept**, with the reasoning in F22.
- `SnapshotHead.id` — **kept**, with the reasoning under *Claims dropped*.

## Change sizing

~9,000 lines is far past the 1,000-line guidance, but the shape is right: ~4,900 are the slice's own
documents and the published PRD companion, ~2,700 are tests, and the production diff is roughly
1,400 lines across one new module, one changed read, one changed batch owner, two rules blocks and
one component plus a vendored primitive. D29 called it "at the edge" and put the pure boundary
first so everything hazard-bearing is reviewable before a `.vue` file changes; that ordering held
and is what made the review tractable. The one real sizing concern is F13 — the store, not the diff.

## Manual verification

Not performed: this session is unattended with no browser to drive. The demo line is walked
mechanically by `tests/e2e/snapshots.spec.ts` against real routes, real Firestore documents and a
real SSE stream, including the three claims that live only there — the list renders rows a user can
act on, **Restore** reaches real documents (`about.html` gone from the tree, version 1's bytes back
in the editor), and all of it survives a reload. That test captures version 1's editor contents and
asserts they *changed* after the second generation, so "it came back" cannot pass by never having
moved.

## Deliberately deferred

F10, F11, F12, F13, F14, F15, F16 above, each with the reason at the row. Two are worth repeating
because they are the ones a later change could walk into:

- **F11** — the prune is unbounded and the batch it feeds is capped at 500. Safe today only because
  of a deploy-time concurrency setting. If `maxInstances`, memory, or CPU on the `api` function is
  ever raised, re-derive `42 + 21P ≤ 500` before shipping it.
- **F10** — the restore's delete set is bounded by `FILE_LIMIT`. If that constant moves, or if the
  write path ever becomes transactional, this is the line to revisit.

## Verdict

**Approve.** The slice does what its PRD says, in the shape its PRD argued for: the snapshot is the
project's whole file set and not the turn's writes (R1), the copies hang off a subcollection because
20 × 100,000 does not fit in a document (R2), the restore deletes as well as writes (R3), and the
prune takes the pruned version's file documents with it (R4). The tests are unusually strong —
negative assertions on nearly every claim, a fixture built specifically so a do-nothing restore
cannot pass, and a recording batch behind the atomicity claim. Eight required findings were fixed
here, each behavioural one test-first with the failing test verified red before the change.
