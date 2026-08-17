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

---

## T4 — `GET /api/projects/:projectId`

**Red:** `describe('GET /api/projects/:projectId')` — 11 cases.

The first draft of the four 404 cases **passed before the route existed**, because the app's
terminal catch-all also answers `404 { code: 'not_found' }`. That is a test proving nothing,
so an `expectNotFound(res)` helper was added that also asserts the user-facing message
(`That project no longer exists.`), which only the handler produces. All 11 then failed.

**Green:** `requireProjectId(req)` as each handler's first statement, `notFound()` as the one
404 factory, and `handleGetProject`.

**ACs:** AC-5, AC-12 (read), AC-17 (L4), AC-20 (by id), AC-10/AC-11 (GET by id).

**P7 resolved — `a%2Fb` does reach the route.** The plan hedged that the emulator might
normalise it. It does not: `fetch` leaves `%2F` percent-encoded in the path, the router
matches it as a single segment, and Express decodes `req.params['projectId']` to `a/b`, which
the id schema refuses with 400 `invalid_id`. So AC-17's most interesting case is covered at
L4 after all. `..` remains L1-only, as the plan predicted — the WHATWG URL parser removes
double-dot segments before the request is sent. `has%20space` was added alongside, since it
is the same class of case and free.

**Deviations from the plan:** none.

---

## T5 — `PATCH /api/projects/:projectId`

**Red:** `patchJson` added to `tests/integration/helpers.ts`, then
`describe('PATCH /api/projects/:projectId')` — 22 cases.

**Green:** `handlePatchProject` — id, then body, then read, then a patch built with
present-versus-absent semantics, then a re-read for the committed timestamps. No transaction
(P2): one writer per document.

**ACs:** AC-6, AC-7, AC-12 (update), AC-16, AC-17 (PATCH), AC-20 (PATCH), AC-14/AC-15 (PATCH),
AC-10/AC-11 (PATCH).

**Deviations from the plan:** none. The cross-tenant case compares bob's whole stored document
before and after with `toEqual`, which covers "including its `updatedAt`" without naming
fields one at a time.

---

## T6 — `DELETE /api/projects/:projectId`

**Red:** `describe('DELETE /api/projects/:projectId')` — 10 cases.

**Green:** `handleDeleteProject`, which reads `snapshot.get('deletedAt')` off the raw snapshot
and never parses (P3). It treats both `null` and `undefined` as live, so a document written
before the field existed can still be deleted. `updatedAt` advances alongside `deletedAt`
(P4); a second delete writes nothing at all.

**ACs:** AC-8, AC-9, AC-12 (delete), AC-17 (DELETE), AC-10/AC-11 (DELETE).

**Deviations from the plan:** none. One case beyond the plan's list — a corrupt document is
deletable — because that is the whole reason P3 says this handler does not parse, and it was
otherwise untested.

---

## T7 — Rules and index

**The red step here cannot fail against the file as it stood, and that is stated rather than
skipped.** `users/{uid}/projects/{projectId}` matched no block, so it was already denied by
default and every `assertFails` passed before the change. To prove the cases are meaningful
rather than vacuous, the block was first added as
`allow read, write: if request.auth != null` and the suite run: **6 of the 7 new cases
failed** (the anonymous one still passed, since that rule denies it too). The permissive rule
was then replaced by the deny-all the PRD prints verbatim, and all 19 cases pass.

That is also the standing value of these tests: they are what would catch a later rule
granting `users/{uid}/{document=**}` recursively.

**Red/Green:** `tests/rules/firestore.spec.ts` gains
`describe('users/{uid}/projects/{projectId}')` — owner read, list, create, update and delete;
a different verified user doing all five; an anonymous client reading and writing. Seeded past
the rules with `withSecurityRulesDisabled`, so update and delete have a document to be denied
on. The suite still has no `assertSucceeds` import.

`firestore.rules` gains the deny-all block with its comment; `firestore.indexes.json` gains
the `projects` COLLECTION-scope entry, `deletedAt` ASCENDING + `updatedAt` DESCENDING.

**Not test-covered by construction (R2, D7):** the index. The emulator serves any query, so no
test at any level can catch it missing. Verified by reading the entry against
`handleListProjects`'s `where('deletedAt','==',null).orderBy('updatedAt','desc')` — field for
field, in that order.

**ACs:** AC-21, AC-22, AC-23 (the existing suites are untouched and still pass).

---

## T8 — `projectsApi.ts`

**Red:** `frontend/src/lib/projectsApi.spec.ts` — 9 cases, mocking `@/lib/apiClient` as
`profileApi.spec.ts` does. Failed on the missing module.

**Green:** `frontend/src/lib/projectsApi.ts` — `Project`, `CreateProjectInput`,
`PatchProjectInput`, and the four functions over `request`, with `encodeURIComponent` on
every id-bearing path.

**ACs:** AC-33 (paths, verbs, bodies).

**Deviations from the plan:** none.

---

## T9 — `stores/projects.ts`

**Red:** `frontend/src/stores/projects.spec.ts` — 22 cases against a stubbed `fetch`, so the
assertions are about the requests that would go on the wire, plus one new case in
`frontend/src/stores/auth.spec.ts` (sign-out empties the project list).

**Green:** `frontend/src/stores/projects.ts` with the `loading`/`loaded`/`error` triple copied
from `stores/profile.ts`, a `busy` flag for mutations, and a private `mutate()` that awaits
the call, awaits `load()`, and rethrows without touching `error` (P6).
`stores/auth.ts`'s `signOutNow` gains `useProjectsStore().reset()`.

**ACs:** AC-29 (refetch), AC-31 (refetch), AC-32 (refetch), AC-33 (headers).

**Deviations from the plan:** none. The three mutations share one `describe.each`, since
"issue the call, then refetch; on failure rethrow and do neither" is one behaviour tested
three times rather than three behaviours.

---

## T10 — Vendor the dialog

**No red step, as the plan states.** `npx shadcn-vue@latest add dialog` wrote ten files under
`frontend/src/components/ui/dialog/`. There is no behaviour of ours to assert; T11–T13
exercise them.

**Two things the CLI touched outside `ui/dialog/`, both reverted (P-R1):** it added
`@lucide/vue` to `frontend/package.json` and the lockfile. Nothing imports it — the generated
files import `X` from `lucide-vue-next`, which was already a dependency — so both files were
restored with `git checkout` and `npm install` re-run. The plan's "no new npm packages" holds.

**Hand-adjusted, as the plan predicted.** Five of the ten files failed `vue-tsc` under
`exactOptionalPropertyTypes`, all with the same TS2379: upstream's forwarding produces an
object whose optional keys may be `undefined`, and "absent" and "present but undefined" are
different types.

- `DialogTitle.vue`, `DialogDescription.vue` — `reactiveOmit` + `useForwardProps` replaced by
  the omit-undefined computed `ui/label/Label.vue` already documents.
- `DialogTrigger.vue`, `DialogClose.vue` — same, over `props` directly.
- `DialogContent.vue`, `DialogScrollContent.vue` — `useForwardPropsEmits` **kept**, because
  dropping it would stop the wrapper forwarding its declared emits (declared emits do not fall
  through), and its result filtered for undefined values instead.

Everything else is upstream's, reformatted by Prettier to the repo's single quotes. Typecheck
and lint are clean; the whole frontend suite (313) still passes.

**Committed as `build:`, on its own,** so a reviewer can diff the vendored code against
upstream without slice code mixed in.

---

## T11 — `ProjectFormDialog.vue`

**Red:** `frontend/src/components/ProjectFormDialog.spec.ts` — 15 cases across creating,
renaming and reopening. Failed on the missing component.

Reka UI teleports dialog content to `document.body`, so the spec queries the document through
a `DOMWrapper` rather than the mounted wrapper. That is recorded here because it is the first
component in the codebase where `wrapper.find` is the wrong tool.

**Green:** `frontend/src/components/ProjectFormDialog.vue`, with `patchPayload()` as a
computed from the start (the plan's refactor step), so "only the changed fields" is one
expression rather than two branches — and the same expression is what disables submit when
nothing has changed, which is how the empty-patch 400 is never issued from the UI.

**One correction during green:** `data-testid` on `<DialogContent>` never reached the DOM.
That component's root is `DialogPortal`, which renders an overlay *and* the content — a
multi-root fragment, so Vue drops fallthrough attributes on it. The id moved to an inner
`<div>`, with a comment saying why.

**ACs:** AC-29, AC-30, AC-31.

**Deviations from the plan:** none. Two cases beyond the plan's list: an empty description is
sent as `null` rather than `''`, and reopening clears a previous error as well as re-seeding
the fields.

---

## T12 — `ProjectDeleteDialog.vue`

**Red:** `frontend/src/components/ProjectDeleteDialog.spec.ts` — 6 cases.

**Green:** `frontend/src/components/ProjectDeleteDialog.vue`. Same portal/test-id note as T11.

**ACs:** AC-32.

**Deviations from the plan:** none. One case beyond the plan's list — `project: null` renders
nothing to confirm — because the card nulls its selection as the dialog closes, so the
component sees `null` for at least one render.

---

## T13 — `ProjectsCard.vue`

**Red:** `frontend/src/components/ProjectsCard.spec.ts` — 13 cases: mount fetches; loading with
no rows; loading before the request has started; rows with name, description and "Updated
17 Aug 2026"; no description line when there is none; rows are not links (D12); empty state
with a **New project** button and no error; error with a working **Try again**; error takes
precedence over both loading and stale rows; and the three dialog-opening paths.

**Green:** `frontend/src/components/ProjectsCard.vue`, branches in `AccountCard`'s order —
error → `loading || !loaded` → rows → empty.

**Refactor, as the plan left it to be decided here:** the `Intl.DateTimeFormat` was an *exact*
duplicate of `AccountCard`'s — same locale, same options, same UTC pin — so it is lifted to
`frontend/src/lib/date.ts` as `formatDay(iso)`, with `frontend/src/lib/date.spec.ts` covering
the format, the time-zone pin (23:30 UTC must not roll into the next day) and the unparseable
cases. `AccountCard.vue` now uses it too, and its own suite passes unchanged.

**ACs:** AC-24, AC-25, AC-26, AC-27.

**Deviations from the plan:** none.
