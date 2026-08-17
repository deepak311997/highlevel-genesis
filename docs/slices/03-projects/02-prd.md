# Slice 03 — Projects · PRD

**Spec:** F2.1, F2.2, F2.3 · **Branch:** `slice/03-projects` · **Depends on:** 2b · **Date:** 2026-08-17

## Problem

Genesis has an account, a HighLevel connection, and a dashboard whose Projects card says
"Creating them arrives in the next slice." There is nowhere to put a generated app. Every
slice from 4 on hangs off a project — chat messages, files, snapshots and the workspace
route all need a project id to belong to — so until a user can create one, name it, change
their mind about the name, and throw it away, nothing downstream has an owner.

This is also the first collection created *under* the API-only architecture rather than
migrated into it, and the first with a document id in its URL. Slice 2b closed the
"trust a uid from the body" trap by making another user's id inexpressible at `/users/me`.
A project route cannot do that — it needs `:projectId` — so this slice has to decide how
ownership is enforced when the request is allowed to name a document.

## The demo

Sign in, create a project called "Contact dashboard", watch it appear in the dashboard
list, rename it, delete it, and see the empty state come back — every read and write over
`/api/projects`, with `firestore.rules` denying the browser the collection outright.

## Decisions

No interview was run: this slice ships under the unattended loop, so every question below
was answered from `PRODUCT_SPEC.md` §4 (F2), `IMPLEMENTATION_PLAN.md` §0/§4/§8,
`CLAUDE.md`'s non-negotiables, and the merged code of Slices 1, 2 and 2b. Load-bearing
decisions carry the alternative that was rejected, because a decision with no rejected
alternative was not a decision.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Where do projects live — a top-level `projects/{id}` with an `ownerUid` field, or a subcollection under the owner? | **`users/{uid}/projects/{projectId}`.** The uid segment is always the one `withVerifiedUser` read off the ID token. | Ownership becomes **structural instead of procedural**. `getDb().doc(\`users/${uid}/projects/${id}\`)` cannot reach another user's project, and the list query `collection(\`users/${uid}/projects\`)` is scoped before a `where` clause is written — there is no `ownerUid` comparison to forget, and no `where('ownerUid','==',uid)` that a later route can be copied without. That is the same argument that made the profile route `/users/me` (2b D2), applied to a resource that *must* carry an id in its path. Rejected: top-level `projects/{id}` + `ownerUid` + an equality check in every handler. It works, and it is one forgotten line away from a cross-tenant read — in a slice whose successor slices will copy these handlers four more times. |
| D2 | Does F2.2 — "strict per-user scoping via Firestore security rules" — still hold? | **No, and the contradiction is deliberate.** Scoping is enforced in the API routes; `firestore.rules` denies the collection to every client and is proven by L3 denial tests. | `PRODUCT_SPEC.md` F2.2 predates the 2026-08-17 API-only decision recorded in `IMPLEMENTATION_PLAN.md` §8 and restated in `CLAUDE.md`. Where they disagree, the architecture decision wins. What F2.2 actually asks for — a user can never see another user's projects — is delivered more strongly here: the browser cannot reach the collection at all, so there is no rule to get subtly wrong. |
| D3 | Which routes? | **Five.** `GET /api/projects`, `POST /api/projects`, `GET /api/projects/:projectId`, `PATCH /api/projects/:projectId`, `DELETE /api/projects/:projectId`. | Exactly F2.1's create / read / update / soft-delete plus F2.3's list. `/api/projects/**` is reserved here, the same reservation discipline Slice 2 applied to `/api/hl/proxy/**` and 2b to `/api/users/**`. |
| D4 | `PATCH` or `PUT` for update? | **`PATCH`.** | The update is genuinely partial — rename without touching the description, clear the description without resending the name. 2b used `PUT` because `ensureProfile` is a whole-document idempotent upsert; this is not that, and a `PUT` that only sometimes replaces the document is a lie about the verb. |
| D5 | Who generates the project id? | **The server**, via Firestore's auto-id (`collection.doc()`). Never a client-supplied id. | A client-chosen id lets a caller probe for collisions and pick ids that mean something. Auto-ids are opaque and free. Rejected: a slugified name, which would also make renaming either a no-op on the URL or a document move. |
| D6 | Is soft-delete a `deletedAt` timestamp or a boolean? | **`deletedAt: Timestamp \| null`, written as an explicit `null` on create.** | A timestamp answers "when", which a boolean cannot, and the field is what Slice 11's restore surface and any future undo would read. The explicit `null` is load-bearing rather than tidy: Firestore's `where('deletedAt','==',null)` matches documents whose field **is** null and skips documents where it is **absent**, so a create that omitted it would produce a project invisible to its own list. |
| D7 | Does the list need a composite index? | **Yes, and it is declared in `firestore.indexes.json`** — collection-scope on `projects`, `deletedAt` ASC + `updatedAt` DESC. | `where('deletedAt','==',null).orderBy('updatedAt','desc')` is a composite query. **The Firestore emulator serves any query without an index**, so no test at any level can catch this missing — it fails only in production, after deploy, on the dashboard's first load. Declaring it is the whole mitigation, and it gets a line in the definition of done rather than a test. |
| D8 | Is the list paginated? | **No. It is capped at 100, and creation is capped at 100 live projects per user** — a 101st create is `409 project_limit`. | An unpaginated list is only honest if it cannot truncate. Capping both ends makes "you are seeing all of your projects" a guarantee instead of a hope, for about eight lines. Rejected: cursors and a `nextPageToken`, which is real surface area for a product where a heavy user has ten projects; and an uncapped list, which is an unbounded response body decided by the caller. Soft-deleted projects do not count toward the cap. The count is read immediately before the write and is not transactional — two simultaneous creates at 99 can both land, which is a guard-rail missing by one, not a boundary being crossed. |
| D9 | Where does `locationId` come from? | **From `hlConnections/{uid}`, read server-side at create time, and `null` if the user is not connected.** Never from the request body, and never changed afterwards in this slice. | F2.1 names it as a project field. Reading it server-side keeps the same rule the profile's `email` follows (2b D6): a field the server owns is not accepted from a caller. Snapshotting at create is what "this project targets that location" means — reconnecting to a different location later does not silently repoint existing projects. Rejected: resolving it at read time from the current connection, which would make an old project's data source change under it. |
| D10 | Does creating a project require a HighLevel connection? | **No.** A project can be created before connecting; `locationId` is simply `null`. | Nothing in the brief gates project creation on F1.2, and blocking it would put an unnecessary ordering constraint on the demo. |
| D11 | Does the project store a file list, as F2.1's parenthetical says? | **No.** Files are their own collection in Slice 6. | An array of files on the project document would hit the 1 MiB document limit on a real generated app and would have to be unpicked in Slice 6 anyway. F2.1's "file list" is satisfied by the project *having* files, not by the document carrying them inline. Recorded as out of scope below. |
| D12 | What does a project row link to? | **Nothing.** Rows are not navigable in this slice. | The workspace route is Slice 4. A link to a screen that does not exist is either a dead link or a screen this slice has to build, and the second is how a reviewable PR stops being one. |
| D13 | Does this slice add a `/projects` route, or use the dashboard? | **The dashboard.** The existing placeholder Projects card is replaced in place. | F2.3 asks for a "project dashboard/list screen" and the dashboard is one. `DashboardView.vue`'s own comment already says Slice 3 replaces that card. A dedicated route buys nothing until there is a second screen to navigate between. |
| D14 | How does the list stay current after a create, rename or delete? | **Refetch `GET /api/projects`.** | `CLAUDE.md` is explicit: liveness is a refetch after a mutation or an existing SSE stream, never `onSnapshot`. Rejected: splicing the mutation's returned project into the local array, which saves a round trip and drifts — the list is ordered by `updatedAt` on the server, so a local edit has to re-derive the server's ordering and will eventually get it wrong. |
| D15 | Which HTTP status does a project the caller does not own produce? | **404 `not_found`** — and it is not a policy, it is a fact. | Under D1 the document path is `users/{token uid}/projects/{id}`, so another user's project does not exist at any path this request can name. There is no "403 vs 404 leaks existence" question to answer, because the handler genuinely cannot tell the two apart. |
| D16 | Is `DELETE` on an unknown or already-deleted project an error? | **No — 200 `{ ok: true }`, idempotent.** The first delete's `deletedAt` is not overwritten by a second. | The precedent is `handleDeleteConnection`: the UI cannot be certain of its own staleness — a second tab, a double click, a retry after a timeout — and answering 404 puts an error on screen for a user who already has what they asked for. Not overwriting `deletedAt` keeps "when was this deleted" true. |
| D17 | Is `PATCH` on a deleted project an error? | **Yes — 404.** | Unlike delete, a rename is not something the caller already has. Silently resurrecting a deleted project, or writing to it invisibly, are both worse than saying it is gone. |
| D18 | Is an empty `PATCH` body accepted? | **No — 400 `invalid_body`.** At least one of `name` or `description` must be present. | An accepted no-op would still advance `updatedAt`, which reorders the list for a request that changed nothing. |
| D19 | What validates `:projectId`? | **A Zod id schema — 1–64 characters of `[A-Za-z0-9_-]` — checked before Firestore is touched. Anything else is 400 `invalid_id`.** | Defence in depth against the one way a path parameter can hurt here: `getDb().doc()` composes a path by string concatenation, so an id containing `/` changes the *depth* of the path, and `.` / `..` are ids Firestore refuses outright. Express's single-segment `:param` already stops the slash case; this makes that a property rather than a dependency on routing behaviour. |
| D20 | How does a corrupt stored document read? | **Fail closed.** It is omitted from the list, `GET` by id answers 404, and `project.unreadable` is logged. A `PATCH` naming it also 404s. | The precedent runs through `handleGetConnection` and `readProfile`: parse, don't assert. A half-populated project rendered in a list is a row the user can click actions on and cannot fix. |
| D21 | Field limits? | **`name` 1–80 characters after trimming, required. `description` ≤ 500 characters after trimming, optional and nullable.** | 80 matches `DISPLAY_NAME_MAX` and is what the card's layout survives; 500 is a paragraph, which is what a description is. Enforced in the Zod schema at the boundary, not in the form — the form is not the boundary. |
| D22 | App Check on the new routes? | **On `POST`, `PATCH` and `DELETE`; not on the two `GET`s.** | One rule for the whole API, unchanged since Slice 2: mutations are attested, plain authenticated reads are not, because attestation buys nothing against a caller already holding a valid ID token. |
| D23 | How do timestamps cross the wire? | **ISO-8601 strings**, `createdAt` and `updatedAt`. `deletedAt` is never on the wire, because a deleted project is never returned. | The project's one convention, set by `connectedAt` in Slice 2 and restated in 2b D19. |
| D24 | Which shadcn-vue component, and how is it added? | **`dialog`, via `npx shadcn-vue@latest add dialog`** — used for the create/rename form and for the delete confirmation. | The brief names `dialog` explicitly (`PRODUCT_SPEC.md` §7 / `IMPLEMENTATION_PLAN.md` §4 for this slice). Added by the CLI rather than hand-written, so it matches the vendored `alert`/`card` and a reviewer can diff it against upstream. |
| D25 | Are the create and rename dialogs one component or two? | **One — `ProjectFormDialog.vue`,** parameterised by an optional project. | The two differ only in their title, their submit label and whether the fields start populated. Two components would be one component and a copy of it, and the copy is where the 80-character limit stops being enforced on one of the two paths. |
| D26 | Is a soft-deleted project restorable? | **Not in this slice.** `deletedAt` is written and nothing reads it back. | F2.1 asks for soft-delete, not for undo. Restore has a surface — where does it live, how long do you keep them — that belongs with Slice 11's snapshot sheet if it is ever wanted. Recorded as out of scope. |
| D27 | Is this one reviewable PR? | **Yes, and it is the largest so far.** Five routes in one new functions module, one rules block, one index, three new frontend components, one store, one typed client, plus tests. | Checked deliberately. What would have pushed it over — the workspace route (D12), a restore surface (D26), a file list (D11), pagination (D8) — is out of scope and named below. What remains is one collection's CRUD, which does not split into two demoable halves. |

## In scope

- `functions/src/projects/` — router, handlers, and the schemas for the body, the id and
  the stored document
- `GET /api/projects` — the caller's live projects, newest-updated first, capped at 100
- `POST /api/projects` — create; attested; `locationId` resolved server-side
- `GET /api/projects/:projectId` — one project, or 404
- `PATCH /api/projects/:projectId` — partial update of `name` and `description`; attested
- `DELETE /api/projects/:projectId` — soft delete; attested; idempotent
- `firestore.rules` — `users/{uid}/projects/{projectId}` deny-all, with L3 tests
- `firestore.indexes.json` — the `deletedAt` + `updatedAt` composite index
- `frontend/src/lib/projectsApi.ts` — typed client over `apiClient.request`
- `frontend/src/stores/projects.ts` — list state, mutations, refetch-after-mutation
- `frontend/src/components/ProjectsCard.vue` — loading, empty, error+retry, and the list
- `frontend/src/components/ProjectFormDialog.vue` — create and rename
- `frontend/src/components/ProjectDeleteDialog.vue` — confirmation naming the project
- `frontend/src/components/ui/dialog/` — vendored via the shadcn-vue CLI
- `DashboardView.vue` — the placeholder Projects card replaced by the real one

## Out of scope

| Not here | Picked up by |
|---|---|
| A workspace screen, a `/projects/:id` route, or clickable rows (D12) | Slice 4 |
| Chat messages on a project | Slice 4 |
| A `files` array or file documents (D11) | Slice 6 |
| Snapshots, restore, or any read of `deletedAt` (D26) | Slice 11 — and restore of a *project* is not planned at all |
| Pagination, cursors, search, sort controls (D8) | Not planned. The cap makes the flat list honest |
| Changing a project's `locationId` after create (D9) | Not planned |
| Hard delete, or a sweep of soft-deleted projects | Not planned. If retention becomes a question, it is a scheduled function like `cleanupUnverifiedUsers` |
| Rate limiting project creation | F10.4, a stretch slice. D8's cap is a correctness bound on the list, not a limiter |
| Responsive/mobile layout for the list | Slice 4 owns the workspace layout decision |

## User flow

1. A verified user lands on `/dashboard`. The Projects card shows its **loading** state
   while `GET /api/projects` is in flight.
2. With no projects, the card shows its **empty** state — "No projects yet" and a
   **New project** button.
3. Clicking **New project** opens `ProjectFormDialog` with an empty name and description.
   Submit is disabled until the name is non-empty.
4. Submitting issues `POST /api/projects`. On 200 the dialog closes and the store refetches
   the list; the new project is the first row.
5. Each row shows the project name, its description if it has one, and "Updated
   \<date\>", with **Rename** and **Delete** actions.
6. **Rename** opens the same dialog pre-filled. Submitting issues
   `PATCH /api/projects/:id` and refetches; the row moves to the top, because the list is
   ordered by `updatedAt`.
7. **Delete** opens `ProjectDeleteDialog`, which names the project. Confirming issues
   `DELETE /api/projects/:id` and refetches; the row is gone. With nothing left, the empty
   state returns.
8. If the list request fails, the card shows the server's message and a **Try again**
   button. The account card, the connection panel and sign-out are unaffected.

## Data model

**`users/{uid}/projects/{projectId}`** — a subcollection of the profile document (D1).
Written and read only by the Admin SDK inside `/api/projects*`; no client may read or
write it. The parent `users/{uid}` document does not have to exist for the subcollection to
work, so the project list does not depend on the profile ensure having landed.

| Field | Type | Note |
|---|---|---|
| `name` | string | 1–80 chars, trimmed (D21) |
| `description` | string \| null | ≤ 500 chars trimmed, `null` when absent |
| `locationId` | string \| null | from `hlConnections/{uid}` at create time, never from the body (D9) |
| `createdAt` | Timestamp | server clock, written once |
| `updatedAt` | Timestamp | server clock, advanced on every accepted mutation |
| `deletedAt` | Timestamp \| null | explicit `null` on create — see D6 |

`projectId` is a Firestore auto-id (D5).

**Wire shape** (`Project`):
`{ id: string, name: string, description: string | null, locationId: string | null,
createdAt: string, updatedAt: string }` — timestamps ISO-8601 (D23). `deletedAt` never
crosses the wire.

**Rules change.** One new block, matching the file's existing shape — every match block is
a denial and every one has an L3 test:

```
// --- projects -----------------------------------------------------
// A subcollection of the profile, so the owner's uid is part of the
// document path and the API scopes by the uid from the token alone.
match /users/{uid}/projects/{projectId} {
  allow read, write: if false;
}
```

Rules do not cascade to subcollections, so `match /users/{uid}` says nothing about this
path — the block is required, not decorative, even though the default is denial.

**Index.** `firestore.indexes.json` gains one entry (D7):

```json
{
  "collectionGroup": "projects",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "deletedAt", "order": "ASCENDING" },
    { "fieldPath": "updatedAt", "order": "DESCENDING" }
  ]
}
```

## API contracts

All five routes are mounted on the existing `api` function at both `/` and `/api` (the
emulator strips the function name, a Hosting rewrite does not), and all five go through
`withVerifiedUser` — ID token **and** `email_verified`, Slice 1's D26. Every error body is
the existing envelope: `{ "error": "<user-facing message>", "code": "<machine code>" }`.

Errors shared by every route: **401** `unauthenticated` (missing, malformed or expired
token) and **403** `email_unverified`. Routes with `:projectId` add **400** `invalid_id`
for an id outside `[A-Za-z0-9_-]{1,64}` and **404** `not_found` for a project that is
absent, soft-deleted, unparseable, or another user's — which are indistinguishable by
construction (D15).

### `GET /api/projects`

Auth: ID token. App Check: no.

- **200** → `{ "projects": [ { "id": "…", "name": "Contact dashboard", "description": null,
  "locationId": "loc_123", "createdAt": "2026-08-17T…Z", "updatedAt": "2026-08-17T…Z" } ] }`
  — live projects only, `updatedAt` descending, at most 100
- **200** → `{ "projects": [] }` when there are none

### `POST /api/projects`

Auth: ID token. App Check: **required**.

Request body, `.strict()`: `{ "name": string, "description"?: string | null }`.

- **201** → `{ "project": { … } }`
- **400** `invalid_body` — unknown key (including `id`, `ownerUid`, `locationId`,
  `createdAt`, `deletedAt`), missing or blank `name`, `name` over 80 chars,
  `description` over 500 chars, or a wrong type
- **409** `project_limit` — the caller already has 100 live projects (D8)

### `GET /api/projects/:projectId`

Auth: ID token. App Check: no.

- **200** → `{ "project": { … } }`
- **400** `invalid_id` · **404** `not_found`

### `PATCH /api/projects/:projectId`

Auth: ID token. App Check: **required**.

Request body, `.strict()`, at least one key (D18):
`{ "name"?: string, "description"?: string | null }`. An absent `description` leaves the
stored value alone; an explicit `null` clears it.

- **200** → `{ "project": { … } }` with `updatedAt` advanced and `createdAt` unchanged
- **400** `invalid_body` — unknown key, empty object, or a value outside D21's limits
- **400** `invalid_id` · **404** `not_found` (including a soft-deleted project, D17)

### `DELETE /api/projects/:projectId`

Auth: ID token. App Check: **required**.

- **200** → `{ "ok": true }` — whether or not the project existed, and whether or not it
  was already deleted (D16)
- **400** `invalid_id`

## Edge cases and failure modes

| Situation | Behaviour | User sees | Retry? |
|---|---|---|---|
| No projects yet | `GET` → `{ projects: [] }` | Empty state and a **New project** button | n/a |
| List request fails | Store records the error; the array is left alone | Card error with **Try again**; the rest of the dashboard still works | Retry button |
| Create fails (400, 409, network) | The dialog stays open, the list is not refetched | The server's message inside the dialog, fields still filled | Re-submit |
| Blank or whitespace-only name | Submit is disabled in the dialog; the server answers 400 if it arrives anyway | Disabled button | n/a |
| Name over 80 / description over 500 | 400 `invalid_body` with Zod's message naming the field | Message inside the dialog | Edit and re-submit |
| 100 live projects already | 409 `project_limit`, nothing written | "You have reached the limit of 100 projects." | Delete one |
| Body carries `ownerUid`, `id` or `locationId` | 400 `invalid_body`; nothing written | n/a — no UI sends one | n/a |
| Project id from another account | 404 — the path names nothing that exists (D15) | "That project no longer exists." | n/a |
| Rename a project deleted in another tab | 404; the store surfaces the error and refetches | Error, then a list without the row | n/a |
| Delete the same project twice | 200 both times; the first `deletedAt` stands | Nothing — the row is gone either way | n/a |
| Malformed `:projectId` (`..`, over 64 chars, illegal characters) | 400 `invalid_id` **before** any Firestore call | n/a — no UI produces one | n/a |
| Stored document fails to parse | Omitted from the list; 404 by id; `project.unreadable` logged | A shorter list, no broken row | n/a |
| No token / expired token | 401 `unauthenticated` | Card error; the router guard handles a genuinely dead session | Retry |
| Verified in Auth but stale token claim | 403 `email_unverified` | "Verify your email address first." | Retry after a token refresh |
| Network failure | `ApiError` with status 0 | "Check your connection and try again." | Retry |
| Not connected to HighLevel | `locationId` is `null`; create succeeds (D10) | Nothing different | n/a |
| A client tries the collection directly | Denied by `firestore.rules`, and the frontend has no Firestore SDK to try it with | n/a | n/a |

## Acceptance criteria

**Routes — the happy path**

- **AC-1** — Given a verified caller with no projects, when they `POST /api/projects` with
  `{ "name": "Contact dashboard" }`, then the response is 201 with a project carrying a
  server-generated `id`, that name, `description: null`, and ISO-8601 timestamps, and a
  document exists at `users/{uid}/projects/{id}` with `deletedAt` explicitly `null`.
- **AC-2** — Given a `POST` body with a description, when it is accepted, then the stored
  and returned `description` is the trimmed string.
- **AC-3** — Given a caller with three live projects, when they `GET /api/projects`, then
  all three are returned ordered by `updatedAt` descending, and each carries the wire shape
  with no `deletedAt` field.
- **AC-4** — Given a caller with no projects, when they `GET /api/projects`, then the
  response is 200 `{ "projects": [] }` — not 404.
- **AC-5** — Given a caller with a project, when they `GET /api/projects/:id`, then the
  response is 200 with that project.
- **AC-6** — Given a project, when the caller `PATCH`es `{ "name": "Renamed" }`, then the
  response is 200 with the new name, `createdAt` is byte-identical to the create response,
  and `updatedAt` is strictly later.
- **AC-7** — Given a project with a description, when the caller `PATCH`es
  `{ "description": null }`, then it is cleared; when they `PATCH` only `{ "name": … }`,
  then the stored description is unchanged.
- **AC-8** — Given a live project, when the caller `DELETE`s it, then the response is 200
  `{ "ok": true }`, the document still exists with `deletedAt` set to a server timestamp,
  it no longer appears in `GET /api/projects`, and `GET /api/projects/:id` answers 404.
- **AC-9** — Given an already-deleted project, and given an id that never existed, when the
  caller `DELETE`s either, then the response is 200 `{ "ok": true }`, no document is
  created, and an existing `deletedAt` is not overwritten.

**Routes — the boundary**

- **AC-10** — Given a request with no `Authorization` header, when it hits any of the five
  routes, then the response is 401 `unauthenticated` and no document is created or changed.
- **AC-11** — Given a valid ID token whose `email_verified` claim is false, when it hits any
  of the five routes, then the response is 403 `email_unverified` and nothing is written.
- **AC-12** — Given verified users alice and bob, and given bob owns a project, when alice
  calls `GET`, `PATCH` and `DELETE` on bob's project id with her own token, then every
  response is 404 `not_found` (200 for `DELETE`, per AC-9) and bob's document is byte-for-byte
  unchanged, including its `updatedAt`.
- **AC-13** — Given alice and bob each own projects, when alice calls `GET /api/projects`,
  then the response contains only alice's projects.
- **AC-14** — Given a `POST` or `PATCH` body carrying any key outside its schema —
  specifically `ownerUid`, `id`, `locationId`, `createdAt` and `deletedAt` — then the
  response is 400 `invalid_body` and no document is created or modified.
- **AC-15** — Given a `name` that is empty, whitespace-only, longer than 80 characters, or
  not a string, or a `description` longer than 500 characters, when it reaches `POST` or
  `PATCH`, then the response is 400 `invalid_body`.
- **AC-16** — Given a `PATCH` with an empty body `{}`, then the response is 400
  `invalid_body` and `updatedAt` does not move.
- **AC-17** — Given a `:projectId` of `..`, one of 65 characters, or one containing a
  character outside `[A-Za-z0-9_-]`, when it reaches `GET`, `PATCH` or `DELETE`, then the
  response is 400 `invalid_id` and no Firestore read or write is attempted.
- **AC-18** — Given a caller who already owns 100 live projects, when they `POST`, then the
  response is 409 `project_limit` and no document is written; given 100 projects of which
  some are soft-deleted, when they `POST`, then it succeeds, because deleted projects do not
  count.
- **AC-19** — Given a caller with a HighLevel connection, when they create a project, then
  its `locationId` is the `locationId` from `hlConnections/{uid}`; given a caller with no
  connection, then it is `null`.
- **AC-20** — Given a stored project document that fails to parse, when the owner lists,
  then it is omitted; when they `GET` or `PATCH` it by id, then the response is 404; and a
  `project.unreadable` event is logged.

**Rules — the backstop**

- **AC-21** — Given a verified owner using the Firestore client SDK, when they read, create,
  update or delete `users/{uid}/projects/{projectId}`, then every operation is denied.
- **AC-22** — Given a different signed-in user, and given an unauthenticated client, when
  either reads or writes `users/{uid}/projects/{projectId}`, then it is denied.
- **AC-23** — Given any client, when it reads or writes `users/{uid}`,
  `hlConnections/{uid}`, `authThrottle/{key}` or a collection with no `match` block, then it
  is denied — re-asserted, since the rules file changed.

**Frontend**

- **AC-24** — Given the list request is in flight on first load, when the Projects card
  renders, then it shows its loading state and no rows.
- **AC-25** — Given the request resolves with projects, when the card renders, then there
  is one row per project showing its name, its description when it has one, and an "Updated"
  date derived from `updatedAt`.
- **AC-26** — Given the request resolves with an empty list, when the card renders, then it
  shows its empty state and a **New project** button, and no error.
- **AC-27** — Given the request rejects, when the card renders, then it shows the server's
  message with a **Try again** button, and clicking it re-issues `GET /api/projects`.
- **AC-28** — Given the project list request has failed, when the dashboard renders, then
  the account card, the connection panel and the sign-out control are still present and
  functional.
- **AC-29** — Given the create dialog is open, when the name field is empty or whitespace,
  then submit is disabled; when a name is entered and submitted, then `POST /api/projects` is
  issued, the dialog closes, and the store refetches `GET /api/projects`.
- **AC-30** — Given the create request rejects, when the dialog re-renders, then it stays
  open, shows the server's message, keeps the entered values, and no refetch is issued.
- **AC-31** — Given the rename action on a project, when the dialog opens, then the name and
  description fields are pre-filled from that project; submitting issues
  `PATCH /api/projects/:id` with only the changed fields and then refetches.
- **AC-32** — Given the delete action on a project, when the confirmation opens, then it
  names that project; confirming issues `DELETE /api/projects/:id` and then refetches;
  cancelling issues no request.
- **AC-33** — Given any projects store call, when it issues its request, then the request
  carries an `Authorization: Bearer` header and an App Check header, and no `firebase/firestore`
  import exists anywhere under `frontend/src`.

**End to end**

- **AC-34** — Given a new account that signs up and verifies, when it creates a project
  named "Contact dashboard", renames it to "Contacts", and deletes it, then the row appears,
  changes name, and disappears — ending in the empty state — with each step surviving a page
  reload.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1 | L4 | `tests/integration/projects.spec.ts` | `POST` creates, returns 201, stores `deletedAt: null` |
| AC-2 | L4 | `tests/integration/projects.spec.ts` | Description round-trips, trimmed |
| AC-3 | L4 | `tests/integration/projects.spec.ts` | List ordering by `updatedAt` desc; no `deletedAt` on the wire |
| AC-4 | L4 | `tests/integration/projects.spec.ts` | Empty list is 200 `{ projects: [] }` |
| AC-5 | L4 | `tests/integration/projects.spec.ts` | `GET` by id returns the project |
| AC-6 | L4 | `tests/integration/projects.spec.ts` | Rename advances `updatedAt`, preserves `createdAt` |
| AC-7 | L4 | `tests/integration/projects.spec.ts` | Explicit `null` clears; absent key preserves |
| AC-8 | L4 | `tests/integration/projects.spec.ts` | Soft delete: document remains, list and `GET` stop seeing it |
| AC-9 | L4 | `tests/integration/projects.spec.ts` | Delete is idempotent; `deletedAt` not rewritten; unknown id creates nothing |
| AC-10 | L4 | `tests/integration/projects.spec.ts` | All five routes, no header → 401 |
| AC-11 | L4 | `tests/integration/projects.spec.ts` | All five routes, unverified token → 403 |
| AC-12 | L4 | `tests/integration/projects.spec.ts` | Cross-tenant: alice cannot see, change or delete bob's project |
| AC-13 | L4 | `tests/integration/projects.spec.ts` | Two seeded users; each list contains only its owner's projects |
| AC-14 | L4 | `tests/integration/projects.spec.ts` | Forbidden keys → 400, nothing written |
| AC-14, AC-15, AC-16 | L1 | `functions/src/projects/schema.spec.ts` | `.strict()` create and patch schemas: unknown key, blank name, over-length, wrong type, empty patch |
| AC-15, AC-16 | L4 | `tests/integration/projects.spec.ts` | The same refusals over the wire |
| AC-17 | L1 | `functions/src/projects/schema.spec.ts` | The id schema rejects `..`, `a/b`, 65 characters, and illegal characters |
| AC-17 | L4 | `tests/integration/projects.spec.ts` | Malformed id → 400 `invalid_id` |
| AC-18 | L4 | `tests/integration/projects.spec.ts` | 100 live → 409; deleted ones do not count |
| AC-19 | L4 | `tests/integration/projects.spec.ts` | Seeded `hlConnections/{uid}` → `locationId`; none → `null` |
| AC-20 | L4 | `tests/integration/projects.spec.ts` | Seeded corrupt document: omitted, 404 by id, logged |
| AC-20 | L1 | `functions/src/projects/schema.spec.ts` | Stored-document schema rejects a missing `name` / missing timestamps |
| AC-21, AC-22 | L3 | `tests/rules/firestore.spec.ts` | Owner, stranger and anonymous client all denied every operation on the subcollection |
| AC-23 | L3 | `tests/rules/firestore.spec.ts` | Existing denials re-asserted after the rules edit |
| AC-24, AC-25, AC-26, AC-27 | L2 | `frontend/src/components/ProjectsCard.spec.ts` | Loading, loaded rows, empty, error + Retry re-issues |
| AC-28 | L2 | `frontend/src/views/DashboardView.spec.ts` | A failed project list leaves the rest of the dashboard rendered |
| AC-29, AC-30, AC-31 | L2 | `frontend/src/components/ProjectFormDialog.spec.ts` | Disabled submit, create path, error keeps the dialog open, rename pre-fills |
| AC-32 | L2 | `frontend/src/components/ProjectDeleteDialog.spec.ts` | Names the project; confirm calls through; cancel does not |
| AC-29, AC-31, AC-32 | L1 | `frontend/src/stores/projects.spec.ts` | Each mutation refetches the list; a failed mutation does not |
| AC-33 | L1 | `frontend/src/lib/projectsApi.spec.ts` | Paths, verbs, bodies and response parsing through `apiClient` |
| AC-33 | L1 | `frontend/src/lib/no-firestore.spec.ts` | Existing scan, unchanged, still finds no `firebase/firestore` import |
| AC-34 | L5 | `tests/e2e/projects.spec.ts` | Create → appears → rename → delete → empty state, across reloads |

## Definition of done

- [ ] Every acceptance criterion above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`,
      `test:e2e`
- [ ] `users/{uid}/projects/{projectId}` has a deny-all rules block **and** L3 tests proving
      every client operation is denied
- [ ] The composite index is declared in `firestore.indexes.json` — no test can catch its
      absence (D7), so it is verified by reading the file against the query in the handler
- [ ] Error paths from `PRODUCT_SPEC.md` F8 handled for this surface: every failure mode in
      the table above has a user-facing message
- [ ] Loading, empty and error states exist for the Projects card
- [ ] `dialog` added with `npx shadcn-vue@latest add dialog`, not hand-written
- [ ] No secrets in source; no `.env` change expected — confirm at review
- [ ] Runs clean on `npm run dev` (emulators) from a fresh clone
- [ ] No `firebase/firestore` import anywhere under `frontend/src`
- [ ] `IMPLEMENTATION_PLAN.md` §0 status table and §9 conformance row for F2.1–2.3 updated
- [ ] README delta: none expected — no setup step changes. Confirm at review
- [ ] PR opened with demo evidence; **human approves before merge**

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **A route that authenticates the caller and then trusts an id it was handed.** The named trap for the API-only architecture, and this is the first slice whose routes take an id at all. | Structural: the document path is `users/{token uid}/projects/{id}` (D1), so another user's project is not addressable, not merely refused. AC-12 and AC-13 assert it from the wire; there is no `ownerUid` comparison anywhere to review. |
| R2 | **The composite index is missing in production and no test can see it.** The Firestore emulator serves any query, so L3, L4 and L5 all pass against an index-free project; the dashboard's first load after deploy is where it fails. | Declared in `firestore.indexes.json` in the same commit as the query, called out in the definition of done, and re-checked at review by reading the index entry against the handler's query. |
| R3 | A create that omits `deletedAt` produces a project invisible to its own list, because `where('deletedAt','==',null)` does not match documents where the field is absent. | D6 makes the explicit `null` part of the create path, and AC-1 asserts the stored value rather than only the response. |
| R4 | The slice is the largest so far and quietly grows a workspace screen, a restore surface, or pagination. | Each is a numbered out-of-scope row with its owning slice (D11, D12, D26, D8). The rows are not navigable on purpose — the moment one becomes a link, Slice 4 has started. |
| R5 | `PRODUCT_SPEC.md` F2.2 asks for enforcement in security rules, which this slice deliberately does not do. A reviewer reading the spec alone will read the rules block as a regression. | Recorded as D2, and the rules block carries a comment saying where enforcement actually lives. The property F2.2 wants is delivered more strongly: the browser cannot reach the collection at all. |
| R6 | Three new components and five routes in one PR means the review is long enough that something is skimmed. | The build order puts the boundary first — schemas, then routes, then rules, then UI — so the security-relevant half is reviewable before any component exists. The 100-project cap (D8) and the id schema (D19) are small on purpose. |
| R7 | Refetching after every mutation is two round trips and will look wasteful under review. | It is `CLAUDE.md`'s stated liveness rule (D14), and the alternative — reconciling server ordering client-side — is the bug this avoids. Named here so it is judged as a decision rather than found as an oversight. |

## Blocked

Nothing. Every question this slice raises is answered above.
