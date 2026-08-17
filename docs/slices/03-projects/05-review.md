# Slice 03 — Projects · Review

Reviewed as another author's PR: the whole of `git diff main...HEAD` — 45 files, ~4,970
insertions, of which ~955 are the slice's own docs and ~2,700 are tests. Production code is
roughly 1,300 lines across `functions/src/projects/` (534), `frontend/src/{lib,stores}` (206),
three new components (456) and the vendored `ui/dialog` block (287).

Two findings, both fixed. Neither is a security or data-loss defect; the slice's structural
claim — that another user's project is not addressable rather than merely refused — holds
under inspection and is asserted from the wire.

## Suite

Baseline from `.autopilot/logs/03/gate-post-build.1.log`, the orchestrator's run on `455cc74`.
The "after" column is what I re-ran on `1f7393a`; a dash means the suite was not re-run,
because nothing in the fixes reaches it.

| Check | Baseline (455cc74) | After fixes (1f7393a) |
|---|---|---|
| `typecheck` | 0 errors | 0 errors — re-run, both packages |
| `lint` | 0 warnings | 0 warnings — re-run, both packages |
| `test:unit` | 602 (239 functions · 352 frontend · 11 scripts) | 596 + 11 scripts = **607** (243 · 353 · 11) |
| `test:rules` | 19 passed | — |
| `test:integration` | 155 passed | `projects` suite re-run: 69 passed |
| `test:e2e` | 6 passed | — |

Both unit suites were re-run in full (243 + 353). The projects integration suite was re-run
against the emulators because the schema fix changes what reaches Firestore on the write path;
the other eight integration files and the rules and e2e suites touch nothing the fixes altered,
and the orchestrator re-runs all six after this stage regardless.

## AC coverage

Every AC in `02-prd.md` §Acceptance criteria, against the test that actually asserts it.

| AC | Test | Verified |
|---|---|---|
| AC-1 | `tests/integration/projects.spec.ts` — "creates a project, returns 201, and stores an explicit null deletedAt" | ✅ asserts the *stored* `deletedAt`, not only the response |
| AC-2 | same — "trims a description on the way in" | ✅ wire and stored |
| AC-3 | same — "returns the live projects, updatedAt descending, in the wire shape" | ✅ |
| AC-4 | same — "answers 200 with an empty array rather than 404" | ✅ |
| AC-5 | same — "returns a project by its id" | ✅ |
| AC-6 | same — "renames, preserving createdAt and advancing updatedAt" | ✅ |
| AC-7 | same — "clears a description with an explicit null, and leaves it alone when absent" | ✅ both halves |
| AC-8 | same — "soft-deletes: the document remains, and the list and GET stop seeing it" | ✅ |
| AC-9 | same — "is idempotent, and does not overwrite the first deletedAt" / "answers 200 for an id that never existed, creating nothing" | ✅ |
| AC-10 | same — a 401 case on each of the five routes | ✅ all five |
| AC-11 | same — a 403 case on each of the five routes | ✅ all five |
| AC-12 | same — three "bob's project" cases, each asserting his document is byte-identical after | ✅ the byte comparison is what makes this more than a 404 test |
| AC-13 | same — "returns only alice's projects, with bob's seeded alongside" | ✅ |
| AC-14 | `schema.spec.ts` + integration, five forbidden keys each | ✅ and nothing written |
| AC-15 | `schema.spec.ts` + integration, six malformed bodies | ✅ |
| AC-16 | integration — "refuses an empty body, and does not move updatedAt" | ✅ the second assertion is the one that matters |
| AC-17 | `schema.spec.ts` (incl. `..`) + integration (`a%2Fb`, 65 chars, illegal characters) | ✅ the split is explained: WHATWG strips `..` before the wire |
| AC-18 | integration — "refuses a 101st live project with 409" + "allows a create when half of a full collection is soft-deleted" | ✅ |
| AC-19 | integration — "takes locationId from the connection, and null when there is none" | ✅ |
| AC-20 | integration (omitted from list, 404 by id) + `handlers.spec.ts` (the log line, and that no field of the document reaches it) | ✅ |
| AC-21 | `tests/rules/firestore.spec.ts` — owner denied read, list, create, update, delete | ✅ five separate `assertFails` |
| AC-22 | same — stranger and anonymous client denied | ✅ |
| AC-23 | same — the pre-existing `users/{uid}` denials re-asserted | ✅ |
| AC-24 | `ProjectsCard.spec.ts` — loading in flight, and before the request starts | ✅ |
| AC-25 | same — "renders one row per project…" | ✅ |
| AC-26 | same — "shows the empty state and a New project button, and no error" | ✅ |
| AC-27 | same — "shows the error with a Retry that re-issues the request" | ✅ |
| AC-28 | `DashboardView.spec.ts` — **was untested; now covered** (finding 1) | ✅ after fix |
| AC-29 | `ProjectFormDialog.spec.ts` + `stores/projects.spec.ts` | ✅ |
| AC-30 | `ProjectFormDialog.spec.ts` — "stays open with the server's message and the entered values" | ✅ incl. no refetch |
| AC-31 | same — "pre-fills from the project and says Rename" | ✅ |
| AC-32 | `ProjectDeleteDialog.spec.ts` — names the project, confirms, cancels | ✅ |
| AC-33 | `projectsApi.spec.ts` + `stores/projects.spec.ts` (both headers on the wire) + `no-firestore.spec.ts` | ✅ |
| AC-34 | `tests/e2e/projects.spec.ts` — create → rename → delete → empty, each step across a reload | ✅ |

## Findings

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | Required | **AC-28 was asserted by nothing.** `02-prd.md`'s test matrix maps it to `DashboardView.spec.ts`, but that file stubbed all three cards, so its only failure case was a failed *profile* — the projects card never rendered inside the view at all, let alone in its error state. `ProjectsCard.spec.ts` renders the failure in isolation, where a card that threw on that path would fail only its own suite; the e2e's "leaves the rest of the dashboard working" exercises a *successful* create. The claim "the dashboard survives a failed project list" had no test at any level. | Fixed in `1f7393a`. `DashboardView.spec.ts` now mocks the projects store, mounts the real `ProjectsCard` inside the real view with `error` set, and asserts the account card and connection panel are still there. Verified non-vacuous: clearing the error makes it fail with `Cannot call text on an empty DOMWrapper`. |
| 2 | Required | **"No description" had two representations.** `description: z.string().trim().max(500).nullable()` turns `''` and `'   '` into `''`, which is then written to Firestore — while the store, the card's `v-if` and the rename dialog's changed-fields diff all read "none" as `null`. The card hides a falsy description either way, so the two are indistinguishable on screen and unequal in the data: open Rename on a project stored with `''` and `trimmedDescription` (`null`) ≠ `current.description` (`''`), so the dialog reports an unchanged project as changed and enables a Save that alters nothing. Reachable through the API today; the browser never produces it, which is exactly why it would have gone unnoticed. This is the "silent fallback papering over an unclear invariant" case — one state, decided once at the boundary rather than re-decided by four readers. | Fixed test-first in `b306d1d` / `8f8bbc9`: the schema now transforms empty-after-trim to `null`, with four L1 cases across the create and patch schemas. The trim still runs before the limit. All 69 projects integration cases still pass. |
| 3 | Consider | **Which routes carry App Check is untested.** `requireAppCheck` short-circuits under the emulator, so no emulator-backed test can observe it, and dropping `attested` from `POST /projects` would be silent. `03-plan.md` says so plainly rather than pretending otherwise. | No change. This is a codebase-wide gap — `authRouter`, `hlRouter` and `usersRouter` mount `attested` the same way with the same absence of a test — and fixing it for one router is worse than fixing it for none. Recorded under *Deliberately deferred*. |
| 4 | Nit | `ProjectsCard.vue:120,124` calls `updatedLabel(project.updatedAt)` twice per row, once in the `v-if` and once in the interpolation. | No change. `formatDay` reuses one module-scope `Intl.DateTimeFormat`, so the second call is a formatter invocation and nothing more; restructuring rows into a view model to save it would cost more clarity than it buys. |
| 5 | FYI | `logAuthEvent` now carries `project.unreadable`, a non-auth event. The helper's name has outgrown its scope — `hl.callback` got there first. | No change. Renaming a shared logger is its own change, not this slice's. |

### What I checked and found nothing wrong with

Stated explicitly, because a review that reports two findings on a 4,970-line diff should say
what it looked at to be able to claim that.

- **The ownership argument.** `projectsPath(uid)` is composed from the token's uid in one place;
  there is no `ownerUid` field, no equality check, and no route segment naming a user. `:projectId`
  is parsed against `/^[A-Za-z0-9_-]{1,64}$/` as the **first statement** of every handler that takes
  one, before any Firestore call, which closes the `getDb().doc()` string-concatenation hazard at
  the type boundary rather than relying on Express's single-segment `:param`.
- **The token boundary.** `resolveLocationId` reads exactly one field of `hlConnections/{uid}` and
  parses it; no access or refresh token is read, returned or logged. `handlers.spec.ts` asserts the
  `project.unreadable` line contains no field of the document, with the user's own description as
  the probe.
- **Rules.** The new block is deny-all, and all seven L3 cases are `assertFails` — including the
  verified owner, which is the one people skip. The comment correctly notes rules do not cascade
  into subcollections, so the block is required rather than decorative.
- **The composite index.** `where('deletedAt','==',null) + orderBy('updatedAt','desc')` needs one;
  it is declared in `firestore.indexes.json`, and `firebase.json` wires that file to the
  `hl-genesis` database, so it actually deploys. `liveProjectCount`'s query needs only the automatic
  single-field index. The emulator does not enforce indexes, so this could only be caught by reading.
- **Nothing partial is persisted.** Both write paths parse the body before touching Firestore, and
  every "refuses X" case asserts the collection is unchanged afterwards, not merely the status code.
- **`deletedAt` written explicitly as `null` on create** — omitting it would produce a project
  invisible to its own list, and AC-1 asserts the stored value rather than the response.
- **Dependencies.** None added. `reka-ui`, `@vueuse/core` and `lucide-vue-next` were already
  direct dependencies; `package.json` and the lockfiles are untouched by this diff.
- **Frontend boundary discipline.** `projectsApi.ts` follows `profileApi.ts` and `hlApi.ts` exactly
  — same `request<T>` client, same typed envelope, same absence of client-side Zod. That is a
  pre-existing codebase-wide choice, not a deviation introduced here.
- **Change sizing.** No file crosses the inspection boundary: the largest new production file is
  `handlers.ts` at 333 lines, over half of it comment. The diff is large but is one logical slice
  with no refactor riding along — the `formatDay` extraction is the single exception, and it is a
  genuine de-duplication with its own spec.

## Dead code

Step 9 has nobody to ask, so the call is recorded here.

```
DEAD CODE IDENTIFIED:
- ui/dialog/DialogClose.vue        — no importer (DialogContent.vue imports reka-ui's directly)
- ui/dialog/DialogTrigger.vue      — no importer (both dialogs are driven by an `open` prop)
- ui/dialog/DialogScrollContent.vue — no importer
→ Decision: KEEP.
```

These are upstream shadcn-vue block files, vendored whole. The repo's established convention is to
vendor the block as published and use the parts a slice needs: `ui/card/` already ships an unused
`CardDescription.vue` and `CardFooter.vue`, and `ui/alert/` an unused `AlertTitle.vue`. Deleting
three of nine files here would make `dialog` the one block that diverges from its upstream, and the
next slice that wants a `DialogTrigger` would have to re-vendor it and reconcile the drift. The cost
of keeping them is three files nothing imports; the cost of removing them is a convention with an
exception in it.

## Manual verification

None beyond the automated suites, and none needed: there is no third party in this slice, so the
e2e walks the entire demo path against real Cloud Function routes, a real ID token and real
Firestore documents with nothing stubbed. Every step is asserted across a page reload, which is
what proves a row came back from `GET /api/projects` rather than from component state.

## Deliberately deferred

- **App Check route coverage** (finding 3) — codebase-wide, and worth one change of its own that
  covers all four routers rather than a fourth of the fix here.
- **The create limit is not transactional** (`03-plan.md` D8). Two simultaneous creates at 99 live
  projects can both land. That is a guard-rail missing by one, not a boundary being crossed, and
  the handler says so where it reads the count.
- **A patch whose values equal the stored ones still advances `updatedAt`**, reordering the list for
  a request that changed nothing. `{}` is refused, and the dialog diffs before sending, so this is
  only reachable by a direct API call. Making the server diff would mean a read-compare-write where
  a read-then-write does; not worth it at this size.
- **The PRD's out-of-scope rows stand**: no workspace screen, no clickable rows, no restore surface,
  no pagination, no `locationId` change after create.

## Commits added by this review

```
b306d1d test: a blank description is a null description
8f8bbc9 fix: normalise an emptied description to null
1f7393a test: cover AC-28 with the projects card actually mounted
```

Ready to ship.
