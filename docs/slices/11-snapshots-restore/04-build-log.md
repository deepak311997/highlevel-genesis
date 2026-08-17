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

