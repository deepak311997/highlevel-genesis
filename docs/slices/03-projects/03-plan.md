# Slice 03 — Projects · Technical plan

**PRD:** `docs/slices/03-projects/02-prd.md` (approved, treated as the contract)
**Branch:** `slice/03-projects` · **Mode:** fast · **Date:** 2026-08-17

## Approach

`functions/src/projects/` is a new module built to the exact shape `functions/src/users/`
already has — `schema.ts` for the boundary, one handler file, `index.ts` for the router —
so five new routes arrive as a copy of a pattern a reviewer has already read rather than as
a new one. The document path is `users/{uid}/projects/{projectId}` with the uid coming from
`withVerifiedUser`, which makes ownership structural: there is no `ownerUid` field and no
equality check anywhere in the slice, so PRD R1's trap is not guarded against, it is
inexpressible (D1). `USERS` is imported from `../users/schema` rather than re-declared, so
the two halves of the path cannot drift.

Every handler reads the stored document through `storedProjectSchema.safeParse` and treats
a parse failure as absence — the precedent runs through `readProfile` and
`handleGetConnection`. The one deliberate exception is `DELETE`, which never parses: it
reads the raw `deletedAt` field off the snapshot, because D16 promises delete is always
200 and a corrupt document must still be deletable.

On the frontend, `stores/projects.ts` copies `stores/profile.ts`'s `loading`/`loaded`/
`error` triple (it is the only shape that separates "not asked yet" from "asked, and there
is nothing") and adds mutations that refetch on success and **rethrow** on failure, so a
failed create renders inside the dialog rather than in the card's error slot (AC-30). The
Projects card replaces the dashboard placeholder in place (D13).

Alternatives rejected, one line each: top-level `projects/{id}` + `ownerUid` — one
forgotten `where` from a cross-tenant read (D1); splicing the mutation's returned project
into the local array instead of refetching — re-derives server ordering client-side and
eventually gets it wrong (D14); a Firestore transaction around `PATCH` — buys nothing the
read-then-update does not, on a single-writer document; `count()` aggregation for the
100-project cap — `select().limit(100)` is equally cheap and has no emulator-support
question attached.

## Plan-level decisions the PRD left to this stage

| # | Question | Decision |
|---|---|---|
| P1 | How is the 100-project cap counted? | `query.where('deletedAt','==',null).limit(PROJECT_LIMIT).select().get()` and compare `snapshot.size`. `select()` with no arguments returns document references with no fields, so it is ~100 refs and no field data. Avoids depending on the emulator's aggregation support. |
| P2 | Does `PATCH` run in a transaction? | No. Read → parse → check `deletedAt` → `update()` → re-read for committed timestamps, mirroring `handlePutProfile`'s re-read. The document has one writer (its owner), and D8 already records that this slice does not buy transactional guarantees it does not need. |
| P3 | Does `DELETE` parse the stored document? | No — it reads `snapshot.get('deletedAt')` directly. Parsing would make a corrupt project undeletable, which contradicts D16's "always 200". |
| P4 | Does `DELETE` advance `updatedAt`? | Yes, alongside `deletedAt`, since the data model says `updatedAt` advances on every accepted mutation. A second delete writes nothing at all, so D16's "the first `deletedAt` stands" holds. |
| P5 | What renders the description field? | A plain `<textarea>` carrying the same Tailwind classes as `ui/input/Input.vue`. The PRD's in-scope file list names only `ui/dialog/`; vendoring shadcn-vue's `textarea` as well would add a component the slice was not scoped for, and a 500-character description in a single-line `<input>` is worse than both. |
| P6 | Where do mutation errors live? | The store's `create`/`rename`/`remove` rethrow and never set `error`. `error` belongs to the list request and is what the card renders; a create failure belongs to the dialog (AC-30). |
| P7 | Can `..` as a `:projectId` be tested over the wire? | No, and the plan says so rather than pretending. The WHATWG URL parser removes double-dot path segments — including percent-encoded `%2e%2e` — before the request is sent, so `..` is covered at L1 only. L4 covers the reachable malformed ids: an over-length id, an id with illegal characters, and `a%2Fb`, which arrives at the route as the single segment `a%2Fb` and is decoded by Express into `a/b` — the one case that proves the schema catches a separator that routing let through. If the emulator normalises `%2F` too, that case drops to L1 and the build log says so. |
| P8 | Does the e2e helper get extracted? | Yes. `signUpAndVerify`, `freshEmail` and `activationLinkFor` are already duplicated verbatim between `tests/e2e/auth.spec.ts` and `tests/e2e/highlevel.spec.ts`; a third copy is not defensible. T15 moves them to `tests/e2e/helpers.ts` and points both existing specs at it — a pure move, no behaviour change. This is one file beyond the PRD's in-scope list, recorded here because it is a refactor of existing test code rather than new scope. |

## File map

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/projects/schema.ts` | New | `PROJECTS`, `NAME_MAX`, `DESCRIPTION_MAX`, `PROJECT_LIMIT`, `LIST_LIMIT`, `projectIdSchema`, `createProjectBodySchema`, `patchProjectBodySchema`, `storedProjectSchema`, `Project`, `toProject`, `projectsPath(uid)` |
| `functions/src/projects/schema.spec.ts` | New | L1 — every schema, from both directions |
| `functions/src/projects/handlers.ts` | New | `handleListProjects`, `handleCreateProject`, `handleGetProject`, `handlePatchProject`, `handleDeleteProject`, plus the private `readProject` and `requireProjectId` |
| `functions/src/projects/index.ts` | New | `projectsRouter` — five routes, middleware attached per route |
| `functions/src/api/index.ts` | Edit | Mount `projectsRouter` at `/` and `/api` |
| `firestore.rules` | Edit | One `match /users/{uid}/projects/{projectId}` deny-all block |
| `firestore.indexes.json` | Edit | The `deletedAt` ASC + `updatedAt` DESC composite index |
| `tests/rules/firestore.spec.ts` | Edit | L3 — owner, stranger and anonymous denied every operation on the subcollection |
| `tests/integration/helpers.ts` | Edit | Add `patchJson`; extend `postJson` to accept the existing header argument (it already does) |
| `tests/integration/projects.spec.ts` | New | L4 — the whole route surface |
| `frontend/src/lib/projectsApi.ts` | New | `Project`, `CreateProjectInput`, `PatchProjectInput`, `listProjects`, `createProject`, `patchProject`, `deleteProject` |
| `frontend/src/lib/projectsApi.spec.ts` | New | L1 — paths, verbs, bodies, envelope unwrapping |
| `frontend/src/stores/projects.ts` | New | List state, mutations, refetch-after-mutation, `reset` |
| `frontend/src/stores/projects.spec.ts` | New | L1 — against a stubbed `fetch`, as `stores/profile.spec.ts` does |
| `frontend/src/stores/auth.ts` | Edit | `signOutNow` also calls `useProjectsStore().reset()` |
| `frontend/src/stores/auth.spec.ts` | Edit | Assert the new reset |
| `frontend/src/components/ui/dialog/**` | New | Vendored by `npx shadcn-vue@latest add dialog` |
| `frontend/src/components/ProjectsCard.vue` | New | Loading, empty, error+retry, rows |
| `frontend/src/components/ProjectsCard.spec.ts` | New | L2 — all four states |
| `frontend/src/components/ProjectFormDialog.vue` | New | Create and rename, one component (D25) |
| `frontend/src/components/ProjectFormDialog.spec.ts` | New | L2 |
| `frontend/src/components/ProjectDeleteDialog.vue` | New | Confirmation naming the project |
| `frontend/src/components/ProjectDeleteDialog.spec.ts` | New | L2 |
| `frontend/src/views/DashboardView.vue` | Edit | Placeholder card → `<ProjectsCard />` |
| `frontend/src/views/DashboardView.spec.ts` | Edit | `dashboard-empty` assertions → the stubbed `ProjectsCard` |
| `tests/e2e/helpers.ts` | New | The shared sign-up/verify helper (P8) |
| `tests/e2e/auth.spec.ts` | Edit | Import the helper instead of declaring it |
| `tests/e2e/highlevel.spec.ts` | Edit | Same |
| `tests/e2e/projects.spec.ts` | New | L5 — the demo path |
| `docs/IMPLEMENTATION_PLAN.md` | Edit | §0 status table, §9 conformance rows |
| `docs/slices/03-projects/04-build-log.md` | New | Written by the build stage |

## Task list

Boundary first, UI last — R6's mitigation, so the security-relevant half is reviewable
before any component exists.

### T1 — Project schemas → AC-14, AC-15, AC-16, AC-17, AC-20 (stored half)

- **Red:** `functions/src/projects/schema.spec.ts`
  - `createProjectBodySchema` — accepts `{ name: 'Contact dashboard' }`; accepts a
    description; trims both; rejects each of `ownerUid`, `id`, `locationId`, `createdAt`,
    `deletedAt` as an unknown key; rejects a missing, blank, whitespace-only, non-string
    and 81-character `name`; accepts an 80-character one; rejects a 501-character
    description and accepts a 500-character one; accepts `description: null`.
  - `patchProjectBodySchema` — rejects `{}` with a message naming what is required;
    accepts `{ name }` alone, `{ description }` alone, `{ description: null }`; rejects
    unknown keys and the same length/type violations.
  - `projectIdSchema` — accepts `'abc123_-'` and a 64-character id; rejects `''`, `'..'`,
    `'.'`, `'a/b'`, `'a b'`, `'a.b'`, `'a!b'` and a 65-character id.
  - `storedProjectSchema` — parses a complete document; rejects one missing `name`,
    `createdAt` or `updatedAt`; `toProject` emits ISO-8601 strings and **no `deletedAt`
    key**.
- **Green:** `functions/src/projects/schema.ts`.
  - `import { USERS } from '../users/schema'` and `export function projectsPath(uid: string)
    { return \`${USERS}/${uid}/${PROJECTS}\` }` — one place composes the path.
  - `NAME_MAX = 80`, `DESCRIPTION_MAX = 500`, `PROJECT_LIMIT = 100`, `LIST_LIMIT = 100`.
  - `const name = z.string().trim().min(1).max(NAME_MAX)` and
    `const description = z.string().trim().max(DESCRIPTION_MAX).nullable()`.
  - `createProjectBodySchema = z.object({ name, description: description.optional() }).strict()`.
  - `patchProjectBodySchema = z.object({ name: name.optional(), description:
    description.optional() }).strict().refine((body) => Object.keys(body).length > 0,
    { message: 'Send a name or a description to change.' })` — `parseBody` surfaces
    `issues[0].message`, so the copy is the 400's body.
  - `projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'That project could not be
    found.')`.
  - `firestoreTimestamp` imported from `../users/schema` — it is already exported there.
  - `storedProjectSchema = z.object({ name: z.string().min(1), description:
    z.string().nullable().catch(null), locationId: z.string().nullable().catch(null),
    createdAt: firestoreTimestamp, updatedAt: firestoreTimestamp,
    deletedAt: firestoreTimestamp.nullable().catch(null) })` — `name` and the two
    timestamps are what the row is made of and get no `.catch`; the rest degrade, matching
    `storedProfileSchema`'s split.
  - `toProject(id, stored): Project` returns `{ id, name, description, locationId,
    createdAt, updatedAt }` — `deletedAt` is deliberately not in the `Project` interface,
    so it cannot reach the wire by accident.
- **Refactor:** file-level doc comment stating what each schema guards and from which
  direction, as `users/schema.ts` does.

### T2 — `GET /api/projects` → AC-3, AC-4, AC-10, AC-11, AC-13, AC-20 (list half)

- **Red:** `tests/integration/projects.spec.ts` — `describe('GET /api/projects')`:
  three seeded live projects come back `updatedAt` descending with no `deletedAt` key on
  any of them; no projects → 200 `{ projects: [] }`; no `Authorization` header → 401
  `unauthenticated`; unverified token → 403 `email_unverified`; alice's list contains only
  alice's projects with bob's seeded alongside; a seeded corrupt document (no `name`) is
  omitted while its siblings are returned.
- **Green:**
  - `functions/src/projects/handlers.ts` — `handleListProjects` queries
    `getDb().collection(projectsPath(uid)).where('deletedAt','==',null)
    .orderBy('updatedAt','desc').limit(LIST_LIMIT)`, maps each doc through
    `storedProjectSchema.safeParse`, drops failures after
    `logAuthEvent('project.unreadable', { outcome: 'invalid' })`, and answers
    `{ projects }`.
  - `functions/src/projects/index.ts` — `projectsRouter` with
    `projectsRouter.get('/projects', asyncHandler(withVerifiedUser(handleListProjects)))`.
    Doc comment: middleware per route, never `router.use`, because the router is mounted
    twice; `/api/projects/**` is reserved here.
  - `functions/src/api/index.ts` — mount at `/` and `/api`, after `usersRouter`.
- **Refactor:** pull the parse-or-log-and-drop step into a private
  `readProjectFrom(snapshot)` that both the list and the by-id read use.

### T3 — `POST /api/projects` → AC-1, AC-2, AC-14, AC-15, AC-18, AC-19

- **Red:** `describe('POST /api/projects')`: 201 with a server-generated id, the name,
  `description: null` and ISO-8601 timestamps, **and** a stored document whose `deletedAt`
  is explicitly `null` (`snapshot.get('deletedAt')` is `null`, not `undefined` — R3);
  a padded description round-trips trimmed; each forbidden key (`ownerUid`, `id`,
  `locationId`, `createdAt`, `deletedAt`) → 400 `invalid_body` with the caller's collection
  still empty; blank/over-length/non-string `name` and an over-length `description` → 400;
  a seeded `hlConnections/{uid}` puts its `locationId` on the project and no connection puts
  `null` there; 100 seeded live projects → 409 `project_limit` with nothing written, and
  100 seeded projects of which 50 carry a `deletedAt` → 201.
- **Green:** `handleCreateProject`:
  1. `parseBody(createProjectBodySchema, req)` — before anything touches Firestore.
  2. Cap check, P1's query, `409 project_limit` via `new HttpError(409, 'You have reached
     the limit of 100 projects.', 'project_limit')`.
  3. `locationId` — `getDb().doc(\`${CONNECTIONS}/${uid}\`).get()` (`CONNECTIONS` imported
     from `../hl/connection`), then `z.string().min(1).safeParse(snapshot.get('locationId'))`,
     falling back to `null`. Never from the body.
  4. `const ref = getDb().collection(projectsPath(uid)).doc()` — D5's auto-id — then
     `ref.set({ name, description: body.description ?? null, locationId, createdAt:
     FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), deletedAt: null })`.
  5. Re-read through `readProject`, because `serverTimestamp()` is a sentinel until it
     commits; a null re-read logs `project.unreadable` and throws a 500, as
     `handlePutProfile` does.
  6. `res.status(201).json({ project })`.
  - Route: `projectsRouter.post('/projects', attested, asyncHandler(withVerifiedUser(handleCreateProject)))`.
- **Refactor:** extract `resolveLocationId(uid)` and `liveProjectCount(uid)` as named
  private functions, so the handler reads as its five steps.

### T4 — `GET /api/projects/:projectId` → AC-5, AC-12 (read), AC-17, AC-20 (by id)

- **Red:** `describe('GET /api/projects/:projectId')`: a created project is returned by id;
  bob's project id with alice's token → 404 `not_found`; a soft-deleted project → 404; a
  corrupt document → 404; a 65-character id, `bad!id` and `a%2Fb` → 400 `invalid_id`; no
  header → 401; unverified → 403.
- **Green:**
  - `requireProjectId(req)` — `projectIdSchema.safeParse(req.params['projectId'])`,
    throwing `new HttpError(400, 'That project could not be found.', 'invalid_id')`. Called
    as the handler's first statement, so no Firestore call happens on a malformed id.
  - `readProject(uid, id)` — `getDb().doc(\`${projectsPath(uid)}/${id}\`).get()`, returns
    `null` when absent, when the parse fails (logging `project.unreadable`), or when
    `deletedAt !== null`. One function is what makes 404 mean the same thing in three
    handlers (D15, D17, D20).
  - `handleGetProject` — `null` → `new HttpError(404, 'That project no longer exists.',
    'not_found')`, otherwise `{ project }`.
  - Route: `projectsRouter.get('/projects/:projectId', asyncHandler(withVerifiedUser(handleGetProject)))`.
- **Refactor:** the 404 becomes a single `notFound()` factory shared by `GET` and `PATCH`.

### T5 — `PATCH /api/projects/:projectId` → AC-6, AC-7, AC-12 (update), AC-16, AC-17, AC-20

- **Red:** first add `patchJson` to `tests/integration/helpers.ts` (same body as `putJson`
  with `method: 'PATCH'`), then `describe('PATCH /api/projects/:projectId')`: renaming
  returns 200 with the new name, a `createdAt` string identical to the create response's and
  a strictly later `updatedAt` (with the 50 ms sleep `users-profile.spec.ts` uses, for the
  same reason); `{ description: null }` clears it; `{ name }` alone leaves the stored
  description alone; `{}` → 400 `invalid_body` **and** the stored `updatedAt` has not moved;
  unknown keys and over-length values → 400; bob's id with alice's token → 404 with bob's
  document byte-for-byte unchanged including `updatedAt`; a soft-deleted project → 404; a
  corrupt one → 404; malformed ids → 400; 401 and 403 cases.
- **Green:** `handlePatchProject` — `requireProjectId`, then
  `parseBody(patchProjectBodySchema, req)`, then `readProject` (404 if null), then build the
  patch with present-versus-absent semantics exactly as `handlePutProfile` does
  (`if ('name' in body) …`, `if ('description' in body) patch['description'] = body.description ?? null`),
  always setting `updatedAt: FieldValue.serverTimestamp()`, then `ref.update(patch)`,
  then re-read and answer `{ project }`.
  Route: `projectsRouter.patch('/projects/:projectId', attested, asyncHandler(withVerifiedUser(handlePatchProject)))`.
- **Refactor:** comment on why the body is parsed before the read — a refused body must
  cost no Firestore call and write nothing.

### T6 — `DELETE /api/projects/:projectId` → AC-8, AC-9, AC-12 (delete)

- **Red:** `describe('DELETE /api/projects/:projectId')`: deleting a live project answers
  200 `{ ok: true }`, the document still exists with a non-null `deletedAt`, the project is
  gone from `GET /api/projects`, and `GET` by id answers 404; deleting again answers 200 and
  the first `deletedAt` is unchanged to the millisecond; deleting an id that never existed
  answers 200 and creates no document; deleting bob's id with alice's token answers 200 and
  bob's document is unchanged, `deletedAt` still absent; malformed id → 400; 401 and 403.
- **Green:** `handleDeleteProject` — `requireProjectId`, `ref.get()`; if the document does
  not exist, or `snapshot.get('deletedAt')` is a value other than `null`/`undefined`, answer
  `{ ok: true }` with no write; otherwise `ref.update({ deletedAt:
  FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })` and answer
  `{ ok: true }`. **No `storedProjectSchema` here** — P3.
  Route: `projectsRouter.delete('/projects/:projectId', attested, asyncHandler(withVerifiedUser(handleDeleteProject)))`.
- **Refactor:** comment recording D16 and P3 on the handler.

### T7 — Rules and index → AC-21, AC-22, AC-23

- **Red:** `tests/rules/firestore.spec.ts` — a new
  `describe('users/{uid}/projects/{projectId}')` with `assertFails` on: the verified owner
  reading, creating, updating and deleting their own project; a different verified user
  doing the same; an anonymous client reading and writing. Seeded past the rules with
  `withSecurityRulesDisabled`, as `seedProfile` is, so update and delete have a document to
  be denied on. The existing suites stay untouched and are AC-23's re-assertion.
- **Green:** `firestore.rules` gains the block the PRD prints verbatim, with its comment
  saying enforcement lives in the API and that rules do not cascade, so this block is
  required rather than decorative.
- **Also in this commit, and not test-covered by construction (R2, D7):**
  `firestore.indexes.json` gains the `projects` COLLECTION-scope entry, `deletedAt`
  ASCENDING + `updatedAt` DESCENDING. The emulator serves any query, so no test at any
  level can catch its absence — it is verified by reading the file against
  `handleListProjects`'s query, and that check is a line in the definition of done.

### T8 — `projectsApi.ts` → AC-33 (paths, verbs, bodies)

- **Red:** `frontend/src/lib/projectsApi.spec.ts`, mocking `@/lib/apiClient` as
  `profileApi.spec.ts` does: `listProjects` GETs `/api/projects` and unwraps `{ projects }`;
  `createProject` POSTs `/api/projects` with a JSON content type and a serialised body;
  `patchProject` PATCHes `/api/projects/<id>` with only the keys it was given;
  `deleteProject` DELETEs `/api/projects/<id>`; the id is percent-encoded into the path; a
  rejection propagates with the server's message.
- **Green:** `frontend/src/lib/projectsApi.ts` — the `Project` interface mirroring the
  server's wire shape, `CreateProjectInput` / `PatchProjectInput`, and the four functions
  over `request`. `encodeURIComponent(id)` on every path.
- **Refactor:** doc comment recording that this is the whole of the browser's access to the
  collection, because `firestore.rules` denies it outright.

### T9 — `stores/projects.ts` → AC-29, AC-31, AC-32 (refetch), AC-33 (headers)

- **Red:** `frontend/src/stores/projects.spec.ts`, stubbing `fetch` as
  `stores/profile.spec.ts` does — so the assertion is about the request that would go on
  the wire: `load` issues `GET /api/projects` with `Authorization: Bearer` and
  `X-Firebase-AppCheck`; it fills `projects`, sets `loaded`, clears `loading`; a failure
  records the server's message and leaves `projects` alone; `loading` is true for the first
  request only. `create` issues the POST **and then** a GET (two calls, in that order); a
  failed `create` rejects, issues no GET, and does not set `error`. Same pair for `rename`
  (PATCH) and `remove` (DELETE). `reset` empties everything.
  Also `frontend/src/stores/auth.spec.ts` — signing out resets the projects store.
- **Green:** `frontend/src/stores/projects.ts` — `projects`, `loading`, `loaded`, `error`,
  `busy`, `load`, `create`, `rename`, `remove`, `reset`, typed through an exported
  `ProjectsStore` interface as the other two stores are. Mutations set `busy`, `await` the
  API call, `await load()` on success, and rethrow on failure without touching `error` (P6).
  `frontend/src/stores/auth.ts` — add `useProjectsStore().reset()` to `signOutNow`.
- **Refactor:** doc comment on why liveness is a refetch (D14, `CLAUDE.md`) and why
  mutation errors do not land in `error` (P6).

### T10 — Vendor the dialog → no AC (scaffolding)

**This task has no red step, and that is stated rather than skipped.** It runs
`npx shadcn-vue@latest add dialog`, which writes `frontend/src/components/ui/dialog/`. There
is no behaviour of ours to assert; the components are exercised by T11–T13.

Expect to hand-adjust the generated files: `ui/label/Label.vue` and `ui/input/Input.vue`
both carry comments recording that upstream's `reactiveOmit` forwarding does not type-check
under `exactOptionalPropertyTypes`, and the dialog components forward props the same way.
The fix is the one `Label.vue` already documents — build the forwarded object omitting
`undefined` keys. Typecheck and lint must be clean before the commit; a generated file is
not exempt from the zero-warning rule. Commit as `build:`, separately, so the review can
diff the vendored code against upstream.

### T11 — `ProjectFormDialog.vue` → AC-29, AC-30, AC-31

- **Red:** `frontend/src/components/ProjectFormDialog.spec.ts`, mocking `@/stores/projects`
  with a plain-value object as `ConnectionPanel.spec.ts` does: with `project: null` the
  fields are empty and submit is disabled; typing whitespace keeps it disabled; typing a
  name enables it and submitting calls `create({ name, description })`, then emits
  `update:open` with `false`; when `create` rejects, the dialog does not emit `update:open`,
  renders the server's message, and the entered values are still in the fields; with a
  `project` prop the fields are pre-filled and the title/submit label say "Rename"/"Save";
  submitting a changed name calls `rename(project.id, { name })` with no `description` key;
  changing only the description sends only `description`; with nothing changed submit is
  disabled (so the empty-patch 400 is never issued from the UI).
- **Green:** `frontend/src/components/ProjectFormDialog.vue` — props `{ open: boolean;
  project?: Project | null }`, emits `update:open`. `Dialog`/`DialogContent`/`DialogHeader`/
  `DialogTitle`/`DialogFooter` from `@/components/ui/dialog`, `Input` for the name, a
  `<textarea>` for the description (P5), `Label` for both, `Alert variant="destructive"` for
  the error. Local `name`/`description` refs re-seeded by a `watch` on `open` so a reopened
  dialog is not showing the last edit. Test ids: `project-form-dialog`, `project-form-name`,
  `project-form-description`, `project-form-submit`, `project-form-cancel`,
  `project-form-error`.
- **Refactor:** extract the changed-fields diff into a `patchPayload()` computed, so
  "only the changed fields" is one expression rather than two branches.

### T12 — `ProjectDeleteDialog.vue` → AC-32

- **Red:** `frontend/src/components/ProjectDeleteDialog.spec.ts`: the body contains the
  project's name; confirming calls `remove(project.id)` and emits `update:open` `false`;
  cancelling calls nothing; a rejected `remove` keeps the dialog open and shows the message.
- **Green:** `frontend/src/components/ProjectDeleteDialog.vue` — props `{ open: boolean;
  project: Project | null }`, emits `update:open`. Test ids: `project-delete-dialog`,
  `project-delete-name`, `project-delete-confirm`, `project-delete-cancel`,
  `project-delete-error`.
- **Refactor:** none expected.

### T13 — `ProjectsCard.vue` → AC-24, AC-25, AC-26, AC-27

- **Red:** `frontend/src/components/ProjectsCard.spec.ts`, store mocked as above: it calls
  `load` on mount; with `loading` true it shows `projects-loading` and no rows; with
  `loaded` and two projects it renders two `project-row`s, each with its name, its
  description when it has one and an "Updated <date>" line derived from `updatedAt`; with
  `loaded` and an empty array it shows `projects-empty` and a `projects-new` button and no
  error; with `error` set it shows `projects-error` and a `projects-retry` that calls `load`
  again — and error takes precedence over the other three branches, as `AccountCard` orders
  them.
- **Green:** `frontend/src/components/ProjectsCard.vue` — the four states in `AccountCard`'s
  order (error → `loading || !loaded` → rows → empty), a pinned
  `Intl.DateTimeFormat('en-GB', { …, timeZone: 'UTC' })` for the date exactly as
  `AccountCard` pins it, and local `formOpen` / `deleteOpen` / `selected` refs driving the
  two dialogs. Rows are **not** links (D12).
- **Refactor:** the date formatter is now duplicated between `AccountCard` and this card —
  lift it to `frontend/src/lib/date.ts` with a one-line test if the duplication is exact;
  leave both alone if the formats differ. Decide when the code exists, not before.

### T14 — Dashboard wiring → AC-28

- **Red:** `frontend/src/views/DashboardView.spec.ts` — replace the two `dashboard-empty`
  assertions: the dashboard renders `ProjectsCard`, and when the profile ensure rejects it
  still renders both `ConnectionPanel` and `ProjectsCard`. `ProjectsCard` is stubbed
  alongside the other two, since it owns a store and an endpoint call of its own.
- **Green:** `DashboardView.vue` — the placeholder `Card` is replaced by `<ProjectsCard />`
  and the stale "Slice 3 replaces the projects card" comment is corrected.
- **Refactor:** none expected.

### T15 — End to end → AC-34

- **Red:** `tests/e2e/projects.spec.ts` — sign up, verify, land on the dashboard; the
  Projects card shows its empty state; **New project**, type "Contact dashboard", submit;
  the row appears; reload and it is still there; **Rename** to "Contacts", submit, the row
  shows the new name; reload; **Delete**, confirm, the empty state returns; reload and it is
  still empty. The emulator-build guard from the other two specs is kept.
- **Green:** whatever the run exposes — the expectation is that T1–T14 already satisfy it,
  and any change here is a bug the lower levels missed.
- **Refactor:** P8's extraction — `tests/e2e/helpers.ts` gains `freshEmail`,
  `activationLinkFor` and `signUpAndVerify`; `auth.spec.ts` and `highlevel.spec.ts` import
  them instead of declaring their own copies. Both suites must still pass unchanged
  otherwise.

### T16 — Documentation → no AC

`docs/IMPLEMENTATION_PLAN.md` §0's status table gains a row for slice 3 and marks 2b
merged; §9's "Project CRUD incl. soft-delete" row goes to ✅ and the shadcn-vue row moves
`dialog` from owed to in. No test; it is prose. Commit as `docs:`.

## AC coverage

Every acceptance criterion maps to at least one task:

| AC | Task | AC | Task | AC | Task |
|---|---|---|---|---|---|
| AC-1 | T3 | AC-13 | T2 | AC-25 | T13 |
| AC-2 | T3 | AC-14 | T1, T3, T5 | AC-26 | T13 |
| AC-3 | T2 | AC-15 | T1, T3, T5 | AC-27 | T13 |
| AC-4 | T2 | AC-16 | T1, T5 | AC-28 | T14 |
| AC-5 | T4 | AC-17 | T1, T4, T5, T6 | AC-29 | T9, T11 |
| AC-6 | T5 | AC-18 | T3 | AC-30 | T11 |
| AC-7 | T5 | AC-19 | T3 | AC-31 | T9, T11 |
| AC-8 | T6 | AC-20 | T1, T2, T4, T5 | AC-32 | T9, T12 |
| AC-9 | T6 | AC-21 | T7 | AC-33 | T8, T9 |
| AC-10 | T2–T6 | AC-22 | T7 | AC-34 | T15 |
| AC-11 | T2–T6 | AC-23 | T7 | | |
| AC-12 | T4, T5, T6 | AC-24 | T13 | | |

**AC-33's second half** — "no `firebase/firestore` import exists anywhere under
`frontend/src`" — is covered by the existing `frontend/src/lib/no-firestore.spec.ts`, which
scans the tree and needs no change. It is listed as a definition-of-done item rather than a
task because this slice adds nothing to it.

**Two things carry no test, by construction, and both are called out rather than hidden:**

1. **The composite index (D7, R2).** The Firestore emulator serves any query without an
   index, so L3, L4 and L5 all pass against an index-free project. Verified by reading
   `firestore.indexes.json` against `handleListProjects`'s query at review.
2. **App Check on the three mutations (D22).** `requireAppCheck` short-circuits under
   `isEmulator()` — deliberately, and keyed on `FUNCTIONS_EMULATOR` alone — so no
   emulator-backed test can observe it. Verified by reading the route definitions: `POST`,
   `PATCH` and `DELETE` carry `attested`, the two `GET`s do not.

## Firestore rules changes

```
// --- projects -----------------------------------------------------
// A subcollection of the profile, so the owner's uid is part of the
// document path and the API scopes by the uid from the token alone.
// Enforcement lives in /api/projects*, not here — PRODUCT_SPEC.md F2.2
// predates the API-only decision; see the slice PRD's D2.
//
// Rules do not cascade into subcollections, so `match /users/{uid}`
// above says nothing about this path. This block is required, not
// decorative, even though the default is denial.
match /users/{uid}/projects/{projectId} {
  allow read, write: if false;
}
```

**L3 tests (T7), all `assertFails` — the file has no `assertSucceeds` import and must not
gain one:**

| Case | Why it is not redundant |
|---|---|
| Verified owner `getDoc` on their own project | The owner is the most privileged client there is; the claim buys the API, not the database |
| Verified owner `setDoc` creating a project | The exact payload the API writes, so it fails on the rule and not on its shape |
| Verified owner `updateDoc` on a seeded project | Seeded past the rules, so the denial is on a document that exists |
| Verified owner `deleteDoc` on a seeded project | Soft-delete belongs to the endpoint |
| A different verified user reading, writing and deleting | Cross-tenant, at the rules layer |
| An anonymous client reading and writing | The unauthenticated case |

The existing `describe('unknown collections')` already asserts `projects/anything` — the
**top-level** path, which stays unmatched and stays denied. It is left as it is; the new
block is at `users/{uid}/projects/{projectId}` and does not touch it.

## Dependencies

**No new npm packages.** `zod` is already a functions dependency, `reka-ui` (which the
vendored dialog builds on) is already a frontend dependency, and the shadcn-vue CLI is run
with `npx` and vendors source rather than adding a runtime dependency.

## Manual verification

On the emulators, from a fresh clone:

1. `npm run install:all && npm run dev`
2. Sign up at `http://localhost:5173/signup`, sign in, follow the verification link from the
   Auth emulator UI at `http://localhost:4000`, land on `/dashboard`.
3. The Projects card shows **No projects yet** and a **New project** button.
4. **New project** → name "Contact dashboard", description "Lists and filters contacts" →
   **Create**. The dialog closes and the row appears with its description and an "Updated"
   date.
5. Reload. The row is still there — it came from the API, not component state.
6. Create a second project. It appears above the first, because the list is `updatedAt`
   descending.
7. **Rename** the first one to "Contacts" → **Save**. The name changes and the row moves to
   the top.
8. **Delete** it → confirm. The row goes. Delete the second. The empty state returns.
9. In the Firestore emulator UI, open `users/{uid}/projects` — both documents are still
   there with a `deletedAt` timestamp. Soft, not hard.
10. Connect HighLevel from the connection panel, create a third project, and confirm its
    stored `locationId` matches `hlConnections/{uid}`'s. Disconnect and create a fourth —
    its `locationId` is `null`.
11. In devtools, Network: every projects request is to `/api/projects*` and carries an
    `Authorization: Bearer` header. There is no Firestore traffic at all.
12. Read `firestore.indexes.json` next to `handleListProjects` and confirm the composite
    index matches the query field for field. This is R2's only check.

## Estimate

| Task | Estimate |
|---|---|
| T1 — schemas | 45 min |
| T2 — list route | 45 min |
| T3 — create route | 1 h |
| T4 — get by id | 30 min |
| T5 — patch route | 45 min |
| T6 — delete route | 30 min |
| T7 — rules + index | 30 min |
| T8 — projectsApi | 30 min |
| T9 — projects store | 45 min |
| T10 — vendor dialog | 30 min (⚠ see below) |
| T11 — ProjectFormDialog | 1 h |
| T12 — ProjectDeleteDialog | 30 min |
| T13 — ProjectsCard | 1 h |
| T14 — dashboard wiring | 15 min |
| T15 — e2e + helper extraction | 45 min |
| T16 — docs | 15 min |
| **Total** | **≈ 9.5 h** |

Nothing over half a day individually. The **total is over a day**, which is what D27
already records — this is the largest slice so far, and the PRD checked deliberately that
it does not split into two demoable halves.

**The one task most likely to overrun is T10.** The vendored dialog is generated code
meeting a `strictTypeChecked` + `exactOptionalPropertyTypes` + zero-warnings bar that
upstream does not target, and both `Input.vue` and `Label.vue` carry comments recording
that exact fight. If the generated files need more than the documented
omit-undefined-keys fix, T10 is where the time goes.

## Risks this plan adds to the PRD's

| # | Risk | Mitigation |
|---|---|---|
| P-R1 | The shadcn-vue CLI overwrites `components.json` or reformats an existing vendored component while adding `dialog`. | T10 is its own commit with nothing else in it, so `git diff` after the CLI run shows exactly what it touched, and anything outside `ui/dialog/` gets reverted. |
| P-R2 | `a%2Fb` is normalised somewhere between `fetch` and Express, so AC-17's most interesting case never reaches the route. | P7 records it. The id schema is asserted at L1 regardless, and the build log states which L4 cases actually landed rather than quietly dropping one. |
| P-R3 | T15's helper extraction breaks the two existing e2e specs, and the breakage looks like a slice-3 failure. | It is the refactor step of a task whose red is already green, so both existing suites are run before and after the move; if they disagree, the move is reverted and the third copy is taken. |
