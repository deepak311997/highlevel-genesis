# Slice 13 — Deliverables · PRD
**Spec:** F9.1–F9.5 (+ F7.3, and the emulator NFR in `PRODUCT_SPEC.md` §5) · **Branch:** `slice/13-deliverables` · **Depends on:** 12 · **Date:** 2026-08-18

> **Design companion:** `02-prd.html`, beside this file. It is **not published** — this
> session has no `Artifact` tool, so there is no URL to link. Open the file locally; the
> ship stage should not go looking for one.

## Problem

Twelve slices of working product are documented by a README that describes Slice 1. It
names two scripts that do not exist (`scripts/seed-sandbox.ts`, `scripts/set-verified.mjs`),
a command that does not exist at the root (`npm run dev:emulator`), says the live URLs are
"not deployed yet" when both have been answering `200` since the deploy pipeline landed,
and states as architecture decision #1 that "the SPA subscribes to Firestore directly" —
which the API-only decision of 2026-08-17 reversed and which `scripts/check-no-firestore.mjs`
now actively prevents. The sandbox has no seed data, so the demo the whole assignment is
graded on has nothing real to render. A reviewer cloning this repository today is
mis-instructed on the first page.

## The demo

A reviewer clones the repo, runs three commands from the README and has Genesis running on
emulators; opens the live URL from the same table and signs in against the real deployment;
and watches the ≤5-minute Loom linked one row above it walk the golden path against a
sandbox that the repo's own seed script filled.

## Decisions

Fast mode: no interview. Every row below was decided from `docs/IMPLEMENTATION_PLAN.md` §4
(Slice 13), §7, §8 and §9, `docs/PRODUCT_SPEC.md` §4 (F9) and §5, `docs/HIGHLEVEL_PLATFORM.md`
§4 and §6, and from the code and the live deployment as they stand at `b834b61`.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | This slice's checklist says "deploy frontend and functions". Does the slice deploy? | **No — it is already deployed, continuously.** `.github/workflows/deploy.yml` deploys on every green CI run against `main` and smoke-tests `/api/health` afterwards. Verified live at `b834b61`: `https://hl-genesis-app.web.app/` → 200, `https://hl-genesis-app.web.app/api/health` → `{"ok":true,…roundTripMs:132}`, `https://asia-south1-hl-genesis-app.cloudfunctions.net/api/health` → 200. This slice **records** the URLs and proves they are derived from `.firebaserc`, it does not run a deploy. | F9.1 asks for "deployed, live URLs in README". The deploy half shipped in the deploy-pipeline PR (#18); what is genuinely owed is the README half. Running `firebase deploy` by hand here would also be a second, untested path to production beside the one that has a smoke test. |
| D2 | Which deliverables can this slice actually finish, and which end in a human's hands? | **Three owners, named per item.** (a) *Automated* — the deploy, on merge. (b) *This PR* — root `.env.example` parity, the README, the seed script, the Loom script, the release checklist, and the tests that keep all of it true. (c) *Human hands* — registering the deployed redirect URI on the marketplace app, running the seed script against the real sandbox, recording and linking the Loom, and the two hand-checks §9 owes this slice. | An unattended session cannot open the HighLevel marketplace console, cannot record a video, and must not spend a real sandbox's write quota. Pretending otherwise produces a checklist that lies. Naming the owner per item makes the residue explicit and finishable in one sitting — that is what `04-release-checklist.md` is for (D12). |
| D3 | Root `.env.example` — the plan says it is owed. Is it? | **It exists** (added by the deploy-pipeline PR) but is **four variables short**: `HL_API_BASE`, `HL_AUTHORIZE_BASE`, `HL_VERSION_ID`, `HL_ALLOW_MESSAGE_SEND`. Complete it, and add a parity test so the next variable cannot land in one file only. | The gap is exactly the failure mode the root file exists to close — "where is it?" answered wrongly. A test is cheaper than remembering, and this file has already drifted once. |
| D4 | How is F9.2 ("secrets in Secret Manager only, verify nothing is a plain env var") proven? | **By test, not by hand.** Seven values are `defineSecret`s (`ANTHROPIC_API_KEY`, `OAUTH_STATE_SECRET`, `HL_CLIENT_ID`, `HL_CLIENT_SECRET`, `HL_VERSION_ID`, `HL_REDIRECT_URI`, `ALLOWED_ORIGINS`); the only plain environment variable the deploy writes is `FIRESTORE_DATABASE_ID`. The check asserts each `defineSecret` name is documented in the root `.env.example` **and** that no `defineSecret` name appears on a line `deploy.yml` writes into `functions/.env`. | The plan's line is "verify nothing is a plain env var on the Cloud Run service". A `gcloud run services describe` by hand verifies today and nothing tomorrow; a grep over the two files that decide it verifies every commit. The console reading stays in the checklist as a one-time confirmation, not as the mechanism. |
| D5 | How much of the README can a test hold true? | **Its structure and every mechanical claim it makes.** `scripts/check-readme.mjs` asserts: the seven brief-named sections exist; ≤10 architecture bullets and ≤5 improvement bullets; every `npm run <script>` named resolves in a `package.json`; every repo-relative path named exists; the Live URLs are the ones `.firebaserc` + `firebase.json` imply; the local-setup section names `firebase emulators:start`; and the file contains no claim of client-side Firestore access. Prose quality stays a review judgement. | Every stale line found on `main` today — two missing scripts, one missing npm script, a stale Firestore claim — is in that list. This is `check-no-firestore.mjs`'s pattern applied to the one artefact the assignment grades directly. |
| D6 | Does the README carry the HighLevel allowlist? | **Yes, all thirteen rows, and a test asserts it matches `HL_ROUTES` row-for-row** (method, path, version, and the send row marked disabled). | `functions/src/hl/routes.ts` was written for three consumers — the proxy, Slice 9's cheat-sheet, and "Slice 13's README". Rendering it a third time by hand without a check is how the third copy becomes the wrong one. It is also the concrete answer to F7.1 for a reviewer. |
| D7 | Where does each check live? | **Split by what it needs to import.** The structural README/env/secret checks are `scripts/check-*.mjs` with `.spec.mjs` beside them, picked up by the existing `vitest.scripts.config.mts` and `npm run test:scripts`. The allowlist comparison lives in `functions/` as `src/hl/readme.spec.ts`, because only there can `HL_ROUTES` be imported with its types. | Parsing `routes.ts` from an `.mjs` checker to avoid one file in the other package would be a parser standing where an import belongs. Two homes, each where its data is. |
| D8 | `scripts/seed-sandbox.ts` or `.mjs`? | **`.mjs`.** `scripts/` holds three `.mjs` scripts, each with a `.spec.mjs`, run by a config that globs `scripts/**/*.spec.mjs`; the root `tsconfig` excludes `scripts/`. | The `.ts` name comes from our own plan, not the brief, and honouring it would mean either an untypechecked `.ts` or a new runner dependency for one file. Matching the directory's established shape costs nothing and gets the script a test suite for free. The README names the real filename, and D5's path check enforces that. |
| D9 | What does the seed script create, and how does it authenticate? | **20 contacts and 8 appointments**, against a location the operator names: `HL_SEED_TOKEN` (a Private Integration Token or an OAuth access token — the API is identical) and `HL_SEED_LOCATION_ID`, with `--calendar-id` and `--assigned-user-id` resolved from `GET /calendars/` when omitted. It calls HighLevel **directly**, not through the Genesis proxy, and touches no Firestore. | The proxy deliberately does not allowlist `POST /calendars/events/appointments` (Slice 8 D4), so seeding through it is impossible by design; and an operator script authenticating as a Genesis *user* would need a browser OAuth round trip to do a one-off chore. `HIGHLEVEL_PLATFORM.md` §2 keeps a PIT "in your back pocket" for exactly this. The script creates **no calendar** — `calendars.write` is a deliberately skipped scope (§4), so the calendar is made once in the sandbox UI. |
| D10 | How is a re-run made idempotent, given `/contacts/search`'s filter grammar is unverified? | **By treating HighLevel's duplicate-contact refusal as success**, carrying the returned contact id forward. No search, no delete. | `HIGHLEVEL_PLATFORM.md` §6.1 flags the search DSL as the one thing most needing live verification; hanging idempotency off it would make a re-run's correctness depend on the least-verified call in the platform. The duplicate response already carries the existing contact's id, which is all the appointment step needs. |
| D11 | Time format for the appointments the script creates? | **ISO 8601 with offset in the create body**, and the README/`04-release-checklist.md` state plainly that the epoch-milliseconds finding (§6.3) is about the `GET /calendars/events` **query**, not the body. Appointments are spread over the next 14 days in business hours. | The epoch-ms finding cost a day once already, and it is one sentence away from being over-generalised into "HighLevel uses epoch ms everywhere". Writing down which half it applies to is the cheap half of that lesson. The creating format is a real hand-check (D2c) because only a live sandbox can settle it. |
| D12 | Where do the human items live so they are not lost when this session ends? | **`docs/slices/13-deliverables/release-checklist.md`** — one file, every remaining item with its owner, its exact procedure, and an evidence slot. It also carries the two hand-checks §9 owes this slice: the server-side SSE disconnect (F6.5) and the client-disconnect partial-persistence trigger (F8.2). A test asserts every checkbox line names an owner. | These items are precisely the ones no test can close, which is why they need a written procedure rather than a note in a PR body — a session that ends is not a session that hands off. |
| D13 | The stage documents are numbered `02`–`05`. What number do the two new docs take? | **`docs/slices/13-deliverables/loom-script.md` and `release-checklist.md`, unnumbered.** | The numbers mark the five stages; a sixth and seventh number would imply stages that do not exist. Names that say what they are read better in a directory listing anyway. |
| D14 | Does the slice ship a new screen or endpoint? | **No.** No route, no collection, no rules change, no component. The definition of done requires that to be **measured** — `git diff --stat` shows `frontend/src/` and `firestore.rules` untouched. | Slices 10 and 12 set the precedent that a slice which should not touch the server proves it rather than asserting it. It is also what keeps this PR reviewable. |
| D15 | Is there an L5 walk? | **No new one.** The existing e2e suite is the regression gate; the demo is the Loom, and the Loom is a human recording. | `IMPLEMENTATION_PLAN.md` §2's one-walk-per-slice rule presumes a new user-facing path. This slice has none. Spending an e2e on "the README file exists" would be the wrong level for that assertion. |
| D16 | The README's "Testing the verification gate" section documents a deleted script. Restore the script or delete the section? | **Delete the section**, replacing it with the two lines that are true: the Auth emulator issues the verification links and the e2e suite reads them from the emulator's `oobCodes` endpoint. | Restoring `set-verified.mjs` is new code in a documentation slice, for a workflow the emulator UI already supports. Slice 1's review already recorded the file as existing only inside branch history. |
| D17 | `scripts/bootstrap-github.sh` — §7 says "leave it or delete it in Slice 13's cleanup". | **Delete it.** Nothing references it but that sentence. | It bootstrapped a repository that exists. Keeping a script whose preconditions can never recur is keeping a trap for whoever runs it next. |
| D18 | The architecture-decision list is capped at 10 and currently has 12, two of them false. What are the ten? | The plan's own candidates, corrected: `srcdoc`+shim over Sandpack · files-in-Firestore making snapshots a copy · the proxy as the confused-deputy fix · transactional token refresh against rotation-on-use · date-pinned HL API versions · **API-only data access** with rules as the deny-all backstop · the `<genesis:file>` tag pair over fenced blocks · the cheat-sheet behind a `cache_control` breakpoint · two functions, not one (`generate`'s runtime profile) · vertical slices, one PR each. | Ten is a hard cap the brief sets, so the two false entries are not a fix, they are the budget. "The SPA subscribes to Firestore directly" and "fenced code blocks with path headers" are both reversed decisions; keeping either would tell a reviewer we do not know our own architecture. |
| D19 | Does the API-only rule bear on this slice? | **Yes, twice, and both are enforced.** The seed script uses no Firestore SDK at all, and the README is scanned for any claim of client-side Firestore access (D5). | The standing rule requires the check to be recorded rather than assumed. This slice is also the one that *describes* the architecture to a reviewer, so a stale sentence here is the same error as a stale import. |
| D20 | Anything in the plan's checklist deliberately left undone? | **No line is dropped.** Every one of the twelve is either done in this PR, already true and now tested, or listed in `release-checklist.md` with an owner and a procedure. | The plan says this slice "is graded on a literal checklist". A checklist with a silent omission is worse than one with an honest *pending, owned by a human*. |

## In scope

- **Root `.env.example`** completed to full parity with both package files, with a test.
- **README**, rewritten against `main` at `b834b61`: status line, Live URLs (Hosting, Functions
  base, Loom), local setup on emulators walked from a fresh clone, HighLevel setup including
  the deployed redirect URI, the thirteen-row allowlist, architecture decisions (≤10),
  improvements (≤5), deployment notes, repository layout, seed-script usage.
- **`scripts/check-readme.mjs`** + spec — the README conformance checker (D5).
- **`scripts/check-secrets.mjs`** + spec — the F9.2 check (D4), including the `.env.example`
  parity assertion (D3).
- **`functions/src/hl/readme.spec.ts`** — README allowlist table vs `HL_ROUTES` (D6).
- **`scripts/seed-sandbox.mjs`** + spec — 20 contacts, 8 appointments, `--dry-run`,
  duplicate-tolerant, HighLevel stubbed in tests (D9–D11).
- **`docs/slices/13-deliverables/loom-script.md`** — the ≤5-minute shot list.
- **`docs/slices/13-deliverables/release-checklist.md`** — every human-owned item, with
  procedure and evidence slot, plus the two owed hand-checks (D12).
- **Deleting `scripts/bootstrap-github.sh`** (D17).

## Out of scope

| Not here | Where it goes |
|---|---|
| Running `firebase deploy` | Already automated on merge to `main` (D1); the orchestrator owns the merge |
| Registering the deployed redirect URI on the marketplace app | `release-checklist.md`, human-owned (F9.3) |
| Creating the sandbox calendar; running the seed script against the real sandbox | `release-checklist.md`, human-owned (F7.3) |
| Recording the Loom and pasting its URL into the README and the email | `release-checklist.md`, human-owned (F9.5) |
| The two hand-checks §9 owes (server-side SSE disconnect; client-disconnect partial) | `release-checklist.md`, human-owned, procedure written |
| HighLevel API v3 migration | Named as a README follow-up; no slice |
| Stretch slices S1–S4 (refinement, cancellation, diff view, rate limiting) | Not started; listed under "what I would improve" |
| Any new screen, route, collection or rules change | Nothing needs one (D14) |
| CI workflow changes | The pipeline is green and unchanged |

## User flow

The "user" of this slice is a reviewer with the repository URL and nothing else.

1. Opens the README. The status line says what is shipped; the **Live URLs** table gives the
   Hosting origin, the Functions base URL, and the Loom link.
2. Watches the Loom (≤5 min): sign up → verify → connect HighLevel → create project → prompt →
   watch the stream → real HL data in the preview → edit a file → restore a snapshot → one
   architecture decision.
3. Wants to run it. Follows **Local setup**: `npm run install:all`, copies the two `.env`
   examples, `npm run dev` — emulators and the SPA together, no Firebase project needed —
   and lands on `http://localhost:5173`.
4. Runs `npm test` from the same clone and gets a green suite.
5. Reads **Architecture decisions** (ten bullets) and **What I would improve** (five), then
   **Deployment** for how the live URLs in step 1 got there.
6. Opens the live URL and signs in against the real deployment, where the seeded sandbox has
   twenty contacts and eight appointments to render.

## Data model

**No change.** No collection is created, read or written by this slice. `firestore.rules` and
`firestore.indexes.json` are untouched, and D14 requires that to be shown with `git diff --stat`
rather than asserted. The seed script writes to **HighLevel**, not to Firestore, and imports no
Firebase package.

## API contracts

**No Genesis endpoint is added or changed.** The seed script is the only new caller of anything,
and it calls HighLevel directly:

| | |
|---|---|
| `POST https://services.leadconnectorhq.com/contacts/` | `Version: 2021-07-28` · body `{locationId, firstName, lastName, email, phone, tags}` · 200/201 → `{contact:{id}}` · **400 duplicate → success**, id read from the response (D10) |
| `GET  …/calendars/?locationId=` | `Version: 2021-04-15` · used only when `--calendar-id` is omitted; first calendar wins, its `teamMembers[0].userId` supplies `--assigned-user-id` |
| `POST …/calendars/events/appointments` | `Version: 2021-04-15` · body `{locationId, calendarId, contactId, assignedUserId, startTime, endTime, title}` · ISO 8601 with offset (D11) |

Headers on every call: `Authorization: Bearer $HL_SEED_TOKEN`, the row's `Version`,
`Accept: application/json`. `POST /conversations/messages` is never called — it sends a real
message and costs money (Slice 8 D5).

## Edge cases and failure modes

| Condition | What happens | Retry? |
|---|---|---|
| `HL_SEED_TOKEN` or `HL_SEED_LOCATION_ID` unset | Exits `1` before any request, naming the missing variable and the file it belongs in | Operator sets it |
| `--dry-run` | Prints the full plan — every contact and appointment it would create — and issues **zero** requests | n/a |
| Contact already exists (HighLevel 400 duplicate) | Counted as `existing`, its id carried into the appointment step, run continues | Not needed — this *is* the re-run path |
| A single create fails 4xx/5xx | Reported with the item that failed, the run continues to the end, exit code `1` with a summary | Re-run; created items become `existing` |
| No calendar in the location, or `--calendar-id` names one that 404s | Exits `1` naming the sandbox-UI step that creates one (`calendars.write` is not a granted scope, D9) | Operator creates it |
| Upstream unreachable / network error | Same as a failed create: reported per item, non-zero exit | Re-run |
| README names an `npm run` script, a path, or a URL that does not resolve | `npm run test:scripts` fails with the offending line | Fix the README |
| A variable is added to one package `.env.example` only | The parity test fails, naming the variable and the file missing it | Add it to the root file |
| A `defineSecret` value is written into `functions/.env` by the deploy | The secrets check fails, naming the variable | Move it back to Secret Manager |
| A README allowlist row drifts from `HL_ROUTES` | `functions`' unit suite fails, naming the differing row | Re-render the table |

No new screen, so no loading/empty/error states are owed (D14).

## Acceptance criteria

**Configuration and secrets**

- **AC-1** — Given a variable documented in `frontend/.env.example` or `functions/.env.example`,
  when the scripts suite runs, then it fails unless that variable also appears in the root
  `.env.example`; at `HEAD` the four currently missing (`HL_API_BASE`, `HL_AUTHORIZE_BASE`,
  `HL_VERSION_ID`, `HL_ALLOW_MESSAGE_SEND`) are present and the check passes.
- **AC-2** — Given every `defineSecret('NAME')` in `functions/src`, when the check runs, then
  each name is documented in the root `.env.example`, and none of those names appears on a line
  that `.github/workflows/deploy.yml` writes into `functions/.env`.

**README (F9.4)**

- **AC-3** — Given every `npm run <script>` named in the README, when the check runs, then each
  resolves to a script in the root, `frontend` or `functions` `package.json`; a README naming
  `npm run dev:emulator` at the root fails it.
- **AC-4** — Given every repo-relative path the README names (markdown links and `scripts/…`
  references), when the check runs, then each exists on disk; a README naming
  `scripts/set-verified.mjs` fails it.
- **AC-5** — Given the README, when the check runs, then it has all seven brief-named sections:
  Live URLs, Local setup, HighLevel setup, Architecture decisions, What I would improve,
  Deployment, Repository layout.
- **AC-6** — Given the README, when the check runs, then the architecture-decision list has at
  most 10 items and the improvement list at most 5; an eleventh bullet fails it.
- **AC-7** — Given `.firebaserc`'s project id and `firebase.json`'s pinned region, when the
  check runs, then the README's Live URLs table carries `https://<project>.web.app` and the
  `asia-south1` functions base URL built from that same id; changing the project id in
  `.firebaserc` alone fails it.
- **AC-8** — Given the README's local-setup section, when the check runs, then it names
  `firebase emulators:start` (the brief names it explicitly) and the command it tells the
  reader to run is the root `dev` script, whose definition contains `emulators:exec`.
- **AC-9** — Given `HL_ROUTES`, when `functions`' unit suite runs, then the README's allowlist
  table has one row per route with the same method, path and `Version`, and the
  `POST /conversations/messages` row is marked disabled by default; adding a route without
  touching the README fails it.
- **AC-10** — Given the README, when the check runs, then it contains no claim of client-side
  Firestore access — no `onSnapshot`, `getDoc`, `setDoc`, or "subscribes to Firestore".

**Seed script (F7.3)**

- **AC-11** — Given a stubbed HighLevel and `--dry-run`, when the script runs, then it prints
  the 20 contacts and 8 appointments it would create and issues **zero** requests.
- **AC-12** — Given a stubbed HighLevel answering success, when the script runs, then it issues
  20 `POST /contacts/` and 8 `POST /calendars/events/appointments` calls, each carrying the
  seed location id, `Authorization: Bearer <token>`, and the row's `Version` header
  (`2021-07-28` for contacts, `2021-04-15` for calendars), with ISO-8601 start and end times
  inside the next 14 days, and exits `0`.
- **AC-13** — Given a stub that answers every contact create with HighLevel's duplicate refusal,
  when the script runs, then it reports 20 existing and 0 created, still creates the
  appointments using the ids from those responses, and exits `0`.
- **AC-14** — Given `HL_SEED_TOKEN` or `HL_SEED_LOCATION_ID` unset, when the script runs, then
  it exits non-zero naming the missing variable and issues zero requests.
- **AC-15** — Given a stub that fails one contact create with a 500, when the script runs, then
  the remaining items are still attempted, the failure is reported with the item that caused it,
  and the exit code is non-zero.
- **AC-16** — Given the script's source, when the check runs, then it imports no Firebase or
  Firestore package, never targets the Genesis proxy, and never calls
  `POST /conversations/messages`.

**Deliverable documents**

- **AC-17** — Given `loom-script.md`, when the scripts suite runs, then it names all nine beats
  of the brief's golden path in order and its per-beat timings sum to at most 5:00.
- **AC-18** — Given `release-checklist.md`, when the scripts suite runs, then every checkbox
  line carries exactly one owner tag — `(automated)`, `(this PR)` or `(human)` — so no item can
  be added without saying who closes it.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1 | L1 | `scripts/check-secrets.spec.mjs` | Package `.env.example` variables ⊆ root; a fixture missing one fails |
| AC-2 | L1 | `scripts/check-secrets.spec.mjs` | Every `defineSecret` name documented; disjoint from `deploy.yml`'s `functions/.env` writes |
| AC-3 | L1 | `scripts/check-readme.spec.mjs` | `npm run` names resolve; a fixture naming a missing script fails |
| AC-4 | L1 | `scripts/check-readme.spec.mjs` | Referenced paths exist; a fixture naming a deleted script fails |
| AC-5 | L1 | `scripts/check-readme.spec.mjs` | Seven required headings present; removing one fails |
| AC-6 | L1 | `scripts/check-readme.spec.mjs` | Bullet caps 10 and 5; an eleventh fails |
| AC-7 | L1 | `scripts/check-readme.spec.mjs` | URLs derived from `.firebaserc` + `firebase.json`; a changed project id fails |
| AC-8 | L1 | `scripts/check-readme.spec.mjs` | `firebase emulators:start` named; root `dev` contains `emulators:exec` |
| AC-9 | L1 | `functions/src/hl/readme.spec.ts` | README table ≡ `HL_ROUTES` (method, path, version, disabled flag) |
| AC-10 | L1 | `scripts/check-readme.spec.mjs` | No client-Firestore claim; a fixture containing `onSnapshot` fails |
| AC-11 | L1 | `scripts/seed-sandbox.spec.mjs` | `--dry-run` plans 20 + 8, request count is 0 |
| AC-12 | L1 | `scripts/seed-sandbox.spec.mjs` | Call count, headers, location id, ISO times inside 14 days, exit 0 |
| AC-13 | L1 | `scripts/seed-sandbox.spec.mjs` | Duplicate refusal → `existing`, ids reused, exit 0 |
| AC-14 | L1 | `scripts/seed-sandbox.spec.mjs` | Missing env → non-zero, zero requests, variable named |
| AC-15 | L1 | `scripts/seed-sandbox.spec.mjs` | One 500 → rest attempted, failure reported, exit non-zero |
| AC-16 | L1 | `scripts/seed-sandbox.spec.mjs` | Source scan: no Firebase import, no proxy URL, no message send |
| AC-17 | L1 | `scripts/check-deliverables.spec.mjs` | Loom script: nine beats in order, timings ≤ 300s |
| AC-18 | L1 | `scripts/check-deliverables.spec.mjs` | Every checkbox line carries exactly one owner tag |

> **Corrected in review.** These two rows named `check-readme.spec.mjs` when written. The
> plan moved them to `check-deliverables.spec.mjs` (plan C2, build log D-B2) for lane
> disjointness and because a module should be named for what it checks; same level, same
> suite, same assertions. The matrix was never updated to match — it is now.
| — | L5 | *(none — D15)* | The existing e2e suite is the regression gate; the demo is the Loom |

Every check runs over the **real** README, root `.env.example`, `deploy.yml` and checklist —
not over fixtures alone. The fixtures exist to prove each check can fail; the real files prove
it passes today.

## Definition of done

- [ ] Every acceptance criterion maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`, `test:e2e`
- [ ] No new Firestore collection — and `git diff --stat` shows `firestore.rules`,
      `firestore.indexes.json`, `frontend/src/` and `tests/rules/` untouched (D14)
- [ ] No new screen, so no loading/empty/error states owed
- [ ] No secrets in source; root `.env.example` at full parity and tested (AC-1, AC-2)
- [ ] `npm run dev` walked from a **fresh clone** of this branch, following only the README,
      and the walk's output recorded in the build log
- [ ] README delta: the whole README is the delta
- [ ] `release-checklist.md` lists every remaining item with an owner and a procedure (AC-18)
- [ ] PR opened with demo evidence; **human approves before merge**

## Risks

| Risk | Mitigation |
|---|---|
| The seed script cannot be run against the real sandbox from this session, so its correctness against live HighLevel is unproven — particularly the appointment create body (D11) and the duplicate-refusal shape (D10) | Both are stubbed from `HIGHLEVEL_PLATFORM.md` §6's verified paths, and both are named as hand-checks in `release-checklist.md` with the exact command and the response to record. The script is `--dry-run`-first so the first live run costs nothing |
| A README conformance test can be satisfied by a technically-true, badly-written README | The checks are a floor, not the bar. Prose accuracy is a stage-4 review item, and the review is instructed to read the README against `main` rather than against the checks |
| The Live URLs pass a derivation test while the deployment is broken | The deploy workflow's own smoke test calls `/api/health` after every deploy and fails the run if it does not answer; the checklist adds one manual open of the live URL before the Loom |
| The Loom link is the one deliverable no test can force, and the session that records it is not this one | `release-checklist.md` carries it as a human item with the README line number to edit, and the PR body repeats it. The README's Live URLs row exists and says *pending* rather than being absent, so the gap is visible rather than silent |
| The checklist doc becomes the place work goes to be forgotten | Every item names an owner and a procedure, and the ship stage's PR body links it. It is a hand-off, not a backlog |
