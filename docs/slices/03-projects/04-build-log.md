# Slice 03 — Projects · Build log

**Plan:** `docs/slices/03-projects/03-plan.md` · **PRD:** `docs/slices/03-projects/02-prd.md`
**Branch:** `slice/03-projects` · **Started:** 2026-08-17

Baseline before the first commit: `npm test` (typecheck, lint, test:unit, test:rules,
test:integration) and `npm run test:e2e` both green on `main` at `2deb1b7`.

---

## T1 — Project schemas

**Red:** `functions/src/projects/schema.spec.ts` — 52 cases across `projectsPath`,
`createProjectBodySchema`, `patchProjectBodySchema`, `projectIdSchema`,
`storedProjectSchema` and `toProject`. First run failed on the missing module, then on
nothing else.

**Green:** `functions/src/projects/schema.ts` exactly as the plan specifies — `PROJECTS`,
`NAME_MAX`, `DESCRIPTION_MAX`, `PROJECT_LIMIT`, `LIST_LIMIT`, `projectsPath(uid)` composed
from the imported `USERS`, the two `.strict()` body schemas, the id regex, the stored-document
schema with `.catch` on the three degradable fields only, and `toProject`.

**ACs:** AC-14, AC-15, AC-16, AC-17 (L1 half), AC-20 (stored half).

**Deviations from the plan:** none.

**Notes:**

- `storedProjectSchema` gained two cases the plan did not name: a blank `name` is rejected
  (a row with an empty title is as unrenderable as one with no title), and an absent
  `deletedAt` parses to `null` rather than failing, so a document written before the field
  existed reads as live rather than as unreadable. Both are `.catch`/`min` behaviour the
  plan already specified; the tests just pin them.

---

## T2 — `GET /api/projects`

**Red:** `tests/integration/projects.spec.ts`, `describe('GET /api/projects')` — seven cases.
All seven failed on the catch-all 404, since no route existed.

**Green:** `functions/src/projects/handlers.ts` (`handleListProjects`),
`functions/src/projects/index.ts` (`projectsRouter`), and the mount at `/` and `/api` in
`functions/src/api/index.ts`.

**Refactor:** the parse-or-log-and-drop step is `readProjectFrom(snapshot)` from the start,
which is where T4's `readProject` will read from.

**ACs:** AC-3, AC-4, AC-10 (GET list), AC-11 (GET list), AC-13, AC-20 (list half).

**Deviations from the plan:** none. One case beyond the plan's list — a soft-deleted project
is excluded — because the `deletedAt` filter is R3's other half and deserved its own
assertion rather than riding on the corrupt-document case.

---

## T3 — `POST /api/projects`

**Red:** `describe('POST /api/projects')` — 19 cases. All 19 failed on the catch-all 404.

**Green:** `handleCreateProject`, with `liveProjectCount(uid)` and `resolveLocationId(uid)`
extracted from the start so the handler reads as its five steps. Route added with `attested`.

**Refactor:** `readProjectFrom` split into `parseStored(snapshot)` plus two readers, because
`readProject(uid, id)` — which T3 needs for the post-write re-read, since `serverTimestamp()`
is a sentinel until it commits — has to see `deletedAt`, and `Project` deliberately has no
such field. `parseStored` also returns `null` for an absent document without logging
`project.unreadable`, since absence is not corruption.

**ACs:** AC-1, AC-2, AC-14 (POST), AC-15 (POST), AC-18, AC-19, AC-10/AC-11 (POST).

**Deviations from the plan:** none. `readProject` arrives one task earlier than the plan
placed it (T4), because T3's re-read is its first caller.
