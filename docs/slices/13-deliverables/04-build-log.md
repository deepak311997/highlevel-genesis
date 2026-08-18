# Slice 13 — Deliverables · Build log

**Branch:** `slice/13-deliverables` · **Base:** `main` at `b834b61` · **Mode:** fast ·
**Plan:** `03-plan.md` (approved) · **PRD:** `02-prd.md`

## Baseline

`main` at `b834b61` was clean and green before the first commit:

| Suite | Result |
|---|---|
| `npm test` (typecheck · lint · unit · rules · integration) | exit 0 |
| — `functions` unit | 47 files, 1187 tests passed |
| — `frontend` unit | 73 files, 1062 tests passed |
| — `scripts` unit (`test:scripts`) | 3 files, 25 tests passed |
| — `test:rules` | 1 file, 52 tests passed |
| — `test:integration` | 17 files, 378 tests passed |

No pre-existing failure to surface.

## How this build was run — lanes, and one deviation from one-commit-per-task

The plan's *Lanes* section splits the seventeen tasks into four Phase-1 lanes over disjoint
file sets, a barrier (T10, the README), and two Phase-2 lanes. It was built that way:

| Lane | Tasks | Files owned exclusively |
|---|---|---|
| L-ENV | T1 → T2 | `scripts/check-secrets.{mjs,spec.mjs}`, `.env.example` |
| L-SEED | T3 → T4 → T5 → T6 → T7 | `scripts/seed-sandbox.{mjs,spec.mjs}`, three HighLevel fixtures |
| L-DOCS | T8 → T9 | `scripts/check-deliverables.{mjs,spec.mjs}`, `loom-script.md`, `release-checklist.md` |
| L-CLEAN | T17 | `scripts/bootstrap-github.sh`, `IMPLEMENTATION_PLAN.md`, `HIGHLEVEL_PLATFORM.md` |
| *(barrier)* | T10 | `README.md` |
| L-README | T11 → T12 → T13 → T14 → T15 | `scripts/check-readme.{mjs,spec.mjs}` |
| L-ALLOWLIST | T16 | `functions/src/hl/readme.spec.ts` |

**Deviation D-B1 — how per-task commits survive the fan-out.** A lane's tasks grow the same
two files, so a lane that simply ran to completion would leave one final state and no way to
commit T3 without T7. Each lane therefore snapshotted its owned files into
`/tmp/genesis-lanes/<task>/` after every green-and-refactored task, and the orchestrator
replayed those snapshots into the working tree in plan order, running the suite and
committing at each one. The history is one commit per task, in plan order, and each commit is
a state where that task's tests passed. No subagent ran git.

## Tasks

### T1 — Root `.env.example` parity → AC-1 · `78c8e80`

- **Red:** `it('every variable in a package example is in the root example')` in
  `scripts/check-secrets.spec.mjs`, run over the **real** root, `frontend` and `functions`
  example files. It failed naming exactly the four the root had drifted behind on —
  `HL_VERSION_ID`, `HL_AUTHORIZE_BASE`, `HL_API_BASE`, `HL_ALLOW_MESSAGE_SEND`.
- **Green:** `declaredVars(text)` and `missingFromRoot(rootText, packages)`; the four
  variables added to the root file's functions block with the gloss each package file gives,
  plus an **Operator scripts** block (`HL_SEED_TOKEN`, `HL_SEED_LOCATION_ID`) documented as
  read by `scripts/seed-sandbox.mjs` and by nothing that deploys.
- **Refactor:** the root file's header now records that parity is checked and that the check
  is one-directional — the root may carry more, which is where the operator variables live.
- **Tests:** 4 — `reads NAME= at the start of a line only, deduped, in order` ·
  `names the variable and the file that has it` (temp-file fixture pair) ·
  `does not complain that the root carries more than the packages` ·
  `every variable in a package example is in the root example` (real files).
- Failure path sanity-checked by removing `HL_API_BASE` from the root file in a scratch edit:
  exit `1`, `HL_API_BASE is documented in functions/.env.example but not in .env.example.`

### T2 — Secrets are Secret Manager's, not the deploy's → AC-2 · `1f14075`

- **Red:** five tests, of which the one that mattered was C5's heredoc — with
  `plainEnvVarsInDeploy` reading line-wise, `cat <<EOF > functions/.env` yields `[]`, and
  `[]` is this check's word for *the deploy writes no secrets*. `expected [Function] to throw`.
- **Green:** `definedSecrets(dir)` (walks `functions/src`, skips `*.spec.ts`, sorted uniques)
  and `plainEnvVarsInDeploy(text)`, which now throws on a heredoc redirect naming the line
  and the readable form. Guarded CLI `main` added.
- **Refactor:** one docblock naming the seven secrets with the function each binds to, and
  `FIRESTORE_DATABASE_ID` as the only plain variable the deploy writes.
- **Tests:** 5 more — all seven `defineSecret` names asserted literally, so the list is
  visible in the test; declarations read rather than the specs that mention them; the real
  `deploy.yml` writes no secret; a fixture workflow line writing `ANTHROPIC_API_KEY=` is
  reported; the heredoc throws.
- **Measured today:** 7 secrets, 1 plain variable, empty intersection. `node
  scripts/check-secrets.mjs` exits `0` printing all three findings.

### T3 — The seed plan, and the config guard → AC-11, AC-14 · `1421864`

- **Red:** the whole first spec failed at import — `Cannot find module './seed-sandbox.mjs'`.
- **Green:** `parseArgs`, `readConfig` (throws `SeedConfigError` naming the variable *and* the
  root `.env.example` block it belongs in), `plannedContacts` (20 frozen names, unique emails,
  555-prefixed phones), `isoWithOffset`, `plannedAppointments`, and a `seed()` that prints the
  plan and returns `{ dryRun: true, requests: 0 }`.
- **Refactor:** the twenty names as one `Object.freeze`d table, with a docblock on why a table
  beats a generator here (determinism a test can name).
- **Tests:** 20. `seed --dry-run — AC-11` ×4 (20 + 8 lines, zero requests,
  `<resolved at run time>` for an omitted id, every planned time inside 14 days);
  `readConfig — AC-14` ×4 and `seed — the config guard runs before any request (AC-14)` ×2,
  both asserting the fetch stub was called zero times; `parseArgs` ×4;
  `plannedContacts` ×3; `isoWithOffset — D11` ×3.

### T4 — Creating contacts and appointments → AC-12 · `2af7cba`

- **Red:** 4 failures, the load-bearing one `expected [] to have a length of 28 but got +0` —
  a run that planned everything and issued nothing.
- **Green:** `postJson` (returns status *and* parsed body rather than throwing on non-2xx), a
  counting `fetchImpl` wrapper so `requests` counts what actually went out, and the two loops.
- **Refactor:** one `postJson` shared by both loops.
- **Tests:** 8 — exactly 28 requests to the two pinned URLs, contacts before appointments,
  bearer/`Accept`/per-row `Version`, the location id in every body, bodies equal to
  `plannedContacts`, calendar and assignee and contact on each appointment, ISO-8601 times
  inside 14 days, `exitCodeFor === 0`.
- Fixtures `contact-create.json` and `appointment-create.json` added — recorded responses, so
  the shapes the script reads are HighLevel's rather than ours.

### T5 — A re-run is not an error → AC-13, AC-15 · `4a79a98`

- **Red:** 8 failures — `duplicateContactId is not a function` ×3,
  `expected {created: 20, existing: 0} to deeply equal {created: 0, existing: 20}`, and the
  network-rejection case escaping `seed()` outright as `TypeError: fetch failed`.
- **Green:** `duplicateContactId` (400 only; accepts `meta.contactId` and `contactId`), a
  private `SeedRequestError` carrying the status, and per-item `try`/`catch` recording
  `{ item, status, message }` and continuing — a rejected promise recorded with `status: null`.
- **Refactor:** stable item strings, verified as `contact 3 — Dana Ruiz`.
- **Tests:** 5 more — `seed — a re-run is not an error (AC-13)` ×2,
  `duplicateContactId — D10` ×3, plus `seed — one failure does not end the run (AC-15)` ×3.

### T6 — Resolving the calendar and the assignee · `1aac328`

- **Red:** 8 failures — `resolveCalendar is not a function`,
  `expected '…/contacts/' to contain '/calendars/?locationId='` (nothing resolved first), and
  `promise resolved instead of rejecting` for the empty-calendar case.
- **Green:** `resolveCalendar` — no request when both ids are given, otherwise
  `GET {apiBase}/calendars/?locationId=…` at `Version: 2021-04-15`, called before the contact
  loop through the counted wrapper (so a full run is 29 requests, not 28). Every failure names
  the fix: non-2xx → `--calendar-id`, empty `calendars` → the sandbox-UI step and
  `calendars.write`, no `teamMembers[0].userId` → `--assigned-user-id`.
- **Refactor:** the happy path reuses `tests/fixtures/highlevel/calendars.json`, whose first
  calendar really does carry `teamMembers: []` — which is what makes plan note C3's edge an
  observed case rather than an invented one.
- **Tests:** 8 more — `resolveCalendar — T6` ×6 and
  `seed — resolution comes first, and is counted (T6)` ×2.

### T7 — The script's own boundaries → AC-16 · `a3611a0`

- **Red:** 4 failures — `expected 0 to be greater than 0` (no imports to check yet), the CLI
  guard regex unmatched, `printSummary is not a function` ×2.
- **Green:** `printSummary`, the `node:url` import, and the guarded `main`.
- **Honest note:** the two source-scan assertions were green on their first run. The script
  has been written to plan note C4's constraint since T3 — its docblock says the forbidden
  surfaces are named in the spec and never names them — so the scan could not have gone red
  without first breaking the file on purpose. The spec-side `forbiddenMentions` helper is
  therefore asserted **two-sidedly**: a sample proves it can fail, the real source proves it
  passes. That is the PRD's own pattern for these checks, applied where the red step could
  not exist.
- **Tests:** 6 more — `the script's own boundaries — AC-16` ×4, `printSummary` ×2.
- **CLI, verified by hand:** `HL_SEED_TOKEN=x HL_SEED_LOCATION_ID=y node
  scripts/seed-sandbox.mjs --dry-run` prints the plan and exits `0`; with no environment it
  prints `HL_SEED_TOKEN is not set…  No request was issued.` and exits `1`.

### T8 — The Loom shot list → AC-17 · `1114104`

- **Red:** twice. First the spec alone — `Cannot find module './check-deliverables.mjs'`. Then,
  with the module written, the nine fixture tests passed and the three real-document tests
  failed with `ENOENT … loom-script.md`. Both the expected reason.
- **Green:** `LOOM_BEATS`, `LOOM_BUDGET_SECONDS = 300`, `loomShotList`, `loomProblems`, and
  `loom-script.md` itself. The parser finds the beat and length cells **by column heading, not
  by index**, so adding a column cannot break a check about beats; `loomProblems` checks order
  over the beats actually present, so one missing beat is reported once rather than again as
  every later beat being misplaced.
- **Refactor:** a *Before you record* section (seeded sandbox, throwaway account not
  pre-created, two tabs, signed out, ≥1440px at 100% zoom because the workspace collapses to
  tabs below 1024px, prompt in the clipboard) and an *After the take* section, so the
  recording is one take.
- **The nine beats, 4:50 total:** sign-up 0:30 · connect-highlevel 0:35 · create-project 0:20 ·
  prompt 0:25 · stream 0:45 · preview 0:45 · edit-file 0:25 · restore-snapshot 0:30 ·
  architecture-decision 0:35. Every *On screen* and *What you say* cell is drawn from strings
  read out of the code.
- **Tests:** 12 — `loomProblems — AC-17` ×6, `loomShotList` ×3, `the real loom-script.md` ×3.

### T9 — Every checklist line has an owner → AC-18 · `18577e3`

- **Red:** the appended checkbox tests failed to collect — `ENOENT … release-checklist.md`.
- **Green:** `OWNER_TAGS`, `checkboxLines` (reads tags **only** off the `- [ ]` line, and keeps
  repeats rather than deduping, so `(human) … (human)` is a problem too), `ownerProblems`, and
  the guarded CLI running both checks. Then `release-checklist.md` — **19 items: 2
  `(automated)`, 6 `(this PR)`, 11 `(human)`**, each human item with its exact procedure and an
  `Evidence: _____` slot.
- **Refactor:** a closing note that the epoch-millisecond finding is about the
  `GET /calendars/events` **query**, not any create body — with the reason it matters (ISO in
  that query answers `200` with an empty list, which reads as *no appointments* rather than as
  an error).
- **A test that was wrong, and was fixed rather than relaxed:** the first evidence-slot
  assertion counted `Evidence:` across the whole document and failed 13 vs 11 — the intro
  paragraph explaining the convention, and one `(automated)` item, both matched. It was made
  per-item (every `(human)` block must contain a slot, naming any that does not) and verified
  to discriminate by deleting one slot. The evidence slot was dropped from the automated
  deploy item, since *nothing to do here* and *paste your evidence* contradict each other.
- **Tests:** 13 more — `ownerProblems — AC-18` ×5, `checkboxLines` ×3,
  `the real release-checklist.md` ×5 (the 2/6/11 ledger, evidence slots, the two hand-checks,
  the redirect URI, the epoch-ms clarification).
- **CLI:** `node scripts/check-deliverables.mjs` → `loom-script.md — 9 beats in order, inside
  the budget.` / `release-checklist.md — 19 items, each with exactly one owner.` exit `0`.
  Failure path verified by stripping one owner tag: the offending line printed in full, exit `1`.

### T10 — The README, rewritten → AC-5 and the prose behind AC-3 … AC-10 · `8b1a9fe`

- **Red: none, deliberately.** The plan's *Ordering* section states why: five of the README
  checks are red against the file on `main`, and a check committed before the rewrite would
  leave the branch red until the rewrite landed — while the rewrite is one coherent document,
  not five surgical edits. The red steps for those checks are the fixtures in T11 … T15, each
  carrying exactly the offending line the old README carried.
- **Green:** the whole file. Status line; **Live URLs** with the two live origins, the health
  endpoint and a Loom row that says *pending* and points at `release-checklist.md`, so the gap
  is visible rather than absent; **Local setup** walked from a fresh clone —
  `npm run install:all` then `npm run dev`, no `.env`, no Firebase project, no credentials —
  with `firebase emulators:start` named for the standalone case; **HighLevel setup** with the
  deployed redirect URI, all nine scopes, the version-id trap, the thirteen-row allowlist and
  `### Seeding the sandbox`; ten architecture decisions; five improvements; **Deployment** as
  it actually runs, with the seven `defineSecret`s and `FIRESTORE_DATABASE_ID` named as the
  only plain variable; **Repository layout** matching what is on disk.
- **Deleted:** the *Testing the verification gate* section (D16) — it documented
  `scripts/set-verified.mjs`, which exists only in branch history. Replaced by the two lines
  that are true: the Auth emulator issues the links, and the e2e suite reads them from
  `oobCodes`.
- **Corrections found while writing, beyond the ones the PRD listed:**
  - The old README's surface table advertised *Hosting (built assets) http://localhost:5050*
    and a paragraph explaining the port choice. No hosting emulator is configured in
    `firebase.json` and `npm run emulators` starts only auth, firestore and functions, so the
    row was untrue. Both are gone.
  - `npm run dev` was documented as pointing at **real Firebase**. It has not since the deploy
    pipeline landed: it is `firebase emulators:exec` around `dev:emulator`. `npm run dev:cloud`
    is the real-Firebase path, and the README now says so.
  - The old *Deployment* section said "the six function values" and named three
    `defineSecret`s. There are **seven**, and `scripts/check-secrets.mjs` (T2) now proves it.
- **Two paths deliberately not named**, because they would make the T13 check pass locally and
  fail in CI: `frontend/.env` and `functions/.env` are gitignored and do not exist in a fresh
  clone. The prose says *the functions' `.env`* and *beside `frontend/.env.example`* instead.
- **Refactor:** `npx prettier --write README.md`; the file was prettier-clean on `main` and
  still is.

### T11 — Sections and bullet caps → AC-5, AC-6 · `ca8f0f6`

- **Red:** the whole new spec, headed by *the real README carries all seven brief-named
  sections*, failing at the import — `Cannot find module './check-readme.mjs'`.
- **Green:** `ROOT`, `README`, `REQUIRED_SECTIONS`, `BULLET_CAPS`, `sectionsOf`, `sectionBody`,
  `orderedItemCount`, `sectionProblems`.
- **Refactor:** `sectionBody` is the single place a heading is sliced (`## X` up to the next
  `^## `, keeping `###` children); T14's two section checks read through it.
- **Tests:** 8.

### T12 — Every `npm run` resolves → AC-3 · `656424b`

- **Red:** six tests, headed by *reports `npm run dev:emulator` at the root — the brief's own
  failing example*, all `TypeError: unresolvedNpmScripts is not a function`.
- **Green:** `npmScriptsNamed`, `scriptsOf`, `unresolvedNpmScripts`.
- **Refactor:** the prefix rule carries a comment naming AC-3's example as its reason.
- **Plan note C1, confirmed against the tree:** `dev:emulator` exists in
  `frontend/package.json` and not at the root, so *only* the prefix-aware rule makes AC-3's own
  failing example fail. A resolver pooling every package's scripts would let the exact line
  that broke a fresh clone pass. All three sides are pinned: the real README is clean, a bare
  `npm run dev:emulator` is reported, and `npm --prefix frontend run dev:emulator` is not.
- **Tests:** 6 more.

### T13 — Every path exists → AC-4 · `96bb3eb`

- **Red:** seven tests, all `TypeError: pathsNamed is not a function`.
- **Green:** `PATH_ROOTS`, `pathsNamed` (markdown link targets less `http(s):`, `mailto:`,
  `#…` and absolute `/…`, fragment stripped; plus `(scripts|docs|functions|frontend|tests|
  brand)/…` tokens over a path-safe character class, trailing punctuation and backticks
  trimmed, deduped) and `missingPaths`.
- **Refactor:** the docblock records the known limitation — a bare root filename with no slash
  is only seen when it is a markdown link target (`CLAUDE.md` is checked; `firestore.rules` in
  the layout block is not) — and why widening it would make the check noisy enough to be
  switched off.
- **Measured today:** 29 distinct paths in the README, all present.
- **Tests:** 7 more.

### T14 — Live URLs are derived, and setup names the emulator → AC-7, AC-8 · `81deb6c`

- **Red:** eight tests, `TypeError: liveUrls is not a function` — including the throw-test,
  which failed on the wrong error, so it was rewritten to assert the region message.
- **Green:** `liveUrls` (project from `.projects.default`; region as the single distinct
  `hosting.rewrites[].function.region`, tolerating the `destination`-only rewrite, throwing and
  naming both when two appear), `liveUrlProblems`, `scriptCommand`, `localSetupProblems`.
- **Refactor:** a docblock on why the URLs are derived rather than matched literally — the
  project id is committed in exactly one place, so a literal comparison would agree with itself
  forever while every link died.
- **Tests:** 8 more.

### T15 — No claim of client-side Firestore → AC-10 · `e66956c`

- **Red:** five tests, `TypeError: firestoreClaims is not a function`.
- **Green:** `FIRESTORE_CLAIMS`, `firestoreClaims`, and the guarded CLI `main` running all six
  README checks, printing every offender and exiting `1`, or printing four lines of what it
  verified and exiting `0`.
- **Refactor:** the docblock cites `CLAUDE.md` and `scripts/check-no-firestore.mjs` — the same
  ban one layer out, over the artefact that *describes* the architecture, which is how "the SPA
  subscribes to Firestore directly" survived on `main` while the code said the opposite.
- **Tests:** 5 more. 34 in the file at this point; 47 including the supporting unit describes.
- **CLI, verified:** exits `0` printing the four lines quoted under *Manual verification* below.
  The failure path was exercised over an in-memory mutated copy of the README — without
  touching the file — and reported `missing section: ## Deployment`,
  `npm run devv — no such script in the root package.json`, both `Live URLs: does not carry
  …other-project…` lines, `scripts/set-verified.mjs — named in the README, not on disk`, and
  the `onSnapshot` claim.

### T16 — The README allowlist equals `HL_ROUTES` → AC-9 · `8309016`

- **Red:** the full spec against a stubbed `compareAllowlist` returning `[]` after the parse
  guard — red 6 / green 2. Every mutation case failed with
  `expected [] to deep equally contain StringContaining "…"`; the two that passed were the
  real-README case (trivially, against a stub that reports nothing) and the no-heading case
  (the parse guard was real from the start). Implementing the comparison turned all ten green.
- **Green:** an exported pure `compareAllowlist(readmeText, table)` over a private
  `parseAllowlistTable` returning a `{ kind: 'parsed' } | { kind: 'failed' }` union, so a README
  it cannot read reports a reason rather than silently agreeing with an empty table. Rows keyed
  on `METHOD path`; equal row counts; `Version` and scope per row; and the set of rows whose
  Notes say *disabled* equal to the set carrying a `flag`.
- **Refactor:** the docblock names the third consumer — `routes.ts` claims three, two are code
  and cannot drift, and this spec is what makes the hand-rendered third one real.
- **Tests:** 10 — the real files agree, plus nine mutations: a route added to the table, a
  drifted `Version`, a drifted scope, a flag dropped in each direction, a row rendered twice,
  one forgotten, one invented, and a README with no allowlist section at all.
- Two branches no mutation covered were re-verified by temporarily neutering them **inside the
  spec's own function** — exactly those two tests failed, and only those two. `HL_ROUTES` and
  `README.md` were never touched.
- `strictTypeChecked` holds: no `any`, no `as`, no non-null assertions, every indexed cell read
  guarded, and a row-width check that fails the parse rather than padding.
- **Discrepancies between the README table and `HL_ROUTES`: none.** All thirteen rows agree on
  method, path, `Version` and scope, and the single Notes cell containing *disabled* is exactly
  the row carrying `flag: 'HL_ALLOW_MESSAGE_SEND'`.

### T17 — Cleanup: a dead script and three documents · `bd6746e`

- **Red: none possible**, and stated rather than skipped — a deletion and three documentation
  corrections. The plan says so; this records that it was honoured rather than worked around.
- **Green:** `scripts/bootstrap-github.sh` deleted (D17). `IMPLEMENTATION_PLAN.md` §7 now
  records the deletion instead of deferring the decision; §4 and `HIGHLEVEL_PLATFORM.md` §2
  Step 3 corrected to `scripts/seed-sandbox.mjs`; §9's ledger updated — F9.1, F9.2, F9.4 and
  the emulator NFR to ✅, F7.3 to 🟡 with the live run named as a checklist item, F9.3 and F9.5
  left ⏭ pointing at `release-checklist.md`. No other ledger row was touched.
- **One correction beyond the plan's list:** §0's slice-12 row said *PR open from
  `slice/12-error-handling`*; `8c29fc9` merged it. Corrected to *merged to `main`*, because §0
  is the first thing the next session reads and a stale row there is a wrong starting point.
- **Left alone, deliberately:** `docs/slices/02-highlevel-connection/02-prd.md` and
  `docs/slices/08-highlevel-proxy/02-prd.md` both name `scripts/seed-sandbox.ts` when deferring
  the work to this slice. They are sealed records of what was decided then; retconning a
  shipped slice's PRD would make the archive lie about its own history.

## Manual verification

### 1. The fresh-clone walk — definition of done

```bash
git clone /Users/deepak/Documents/Projects/highlevel-genesis /tmp/genesis-fresh
cd /tmp/genesis-fresh && git checkout slice/13-deliverables
npm run install:all
npm run dev
```

Clone from the local repository rather than a remote, because the branch is not pushed until
the ship stage. Nothing else about the walk differs: it is a clean tree with **no `.env`, no
`.firebaserc` edit, no Firebase credentials** — `ls -a` in the clone shows `.env.example` and
nothing else matching `.env*`.

`npm run install:all` exited `0`. `npm run dev` built the functions, started auth, firestore
and functions under `demo-genesis`, and brought up Vite. Port 5173 was already held by a
leftover dev server on this machine, so Vite took 5174 and said so — environmental, not a
README error.

Then, following only the README:

| Step | Result |
|---|---|
| `GET http://localhost:5174/` | `200` — the SPA is served |
| `GET http://localhost:5001/demo-genesis/asia-south1/api/health` | `{"ok":true,…,"roundTripMs":323}` |
| `GET http://localhost:5174/api/health` (through the Vite proxy) | `{"ok":true,…,"roundTripMs":9}` |
| `POST /api/auth/register` with a weak password | `400 invalid_request`, naming the policy |
| `POST /api/auth/register` with a valid one | `200 {"ok":true}` |
| Sign in, request verification, read `oobCodes` | the `oobLink` is returned |

Browser → Cloud Function → Firestore → back, and an account created, on a clone that was
configured with nothing. The **interactive** remainder of the golden path — clicking through
sign-up, connecting HighLevel, generating an app — needs a browser and a real sandbox, and is
the Loom, which `release-checklist.md` owns as a human item.

**The walk falsified two README claims, and both were fixed (`dd55da0`):**

- The README told the reader to read the verification link out of the **Emulator UI's**
  Authentication tab. `npm run dev` wraps `firebase emulators:exec`, and **exec does not start
  the UI** — port 4000 is dark for the whole documented dev path. Confirmed both ways in the
  clone: `npm run emulators` (`emulators:start`) prints *View Emulator UI at
  http://127.0.0.1:4000/* and answers `200` there; `npm run dev` starts auth, firestore and
  functions and nothing on 4000.
- So the surface table now marks the UI row `npm run emulators` only, adds the Auth emulator's
  own port, and the verification link is fetched from
  `http://localhost:9099/emulator/v1/projects/demo-genesis/oobCodes` — the same endpoint the
  e2e suite reads. This is the one place the fresh-clone walk earned its place in the
  definition of done: no test could have caught either sentence.

### 2. The suite from the same clone

`npm run test:scripts` → **7 files, 143 tests passed**.

### 3. The checks as a human runs them, from the fresh clone

```
node scripts/check-secrets.mjs        exit 0
node scripts/check-readme.mjs         exit 0
node scripts/check-deliverables.mjs   exit 0
```

Failure path exercised as the plan asks — `npm run install:all` renamed to
`npm run installl:all` in the clone's README:

```
README.md:
  npm run installl:all — no such script in the root package.json

See docs/slices/13-deliverables/02-prd.md, AC-3 … AC-10.
exit=1
```

Restored; exit `0` again.

### 4. The seed script, without spending anything

`HL_SEED_TOKEN=x HL_SEED_LOCATION_ID=y node scripts/seed-sandbox.mjs --dry-run` prints the
plan — 20 named contacts and 8 appointments — and ends with `0 requests issued.` The **live**
run is a `release-checklist.md` item, human-owned, and was not run from this branch.

### 5. The live URLs

Not re-checked from this session and not deployed by it (D1). Both answered `200` at `b834b61`
and the deploy workflow smoke-tests `/api/health` after every deploy; opening them by hand
before the Loom is a checklist item.

### 6. D14's measurement

```
$ git diff --stat main -- frontend/src firestore.rules firestore.indexes.json tests/rules
$
```

Empty. No screen, no rule, no index, no rules test changed — measured, not asserted.

## Observed, not changed

- **A locked git worktree lives at `.claude/worktrees/fix+oauth-callback-unversioned/`** — a
  full second checkout of the repository, untracked and not covered by `.gitignore`, so
  `git status` reports it and a careless `git add -A` would try to commit it. It is unrelated
  to this slice; every commit here staged explicit paths. Worth pruning, or ignoring, outside
  this branch.
- `docs/slices/02-highlevel-connection/02-prd.md` and `docs/slices/08-highlevel-proxy/02-prd.md`
  still name `scripts/seed-sandbox.ts`. Left alone deliberately — see T17.

## Acceptance criteria — the test that proves each

Every criterion is L1. D15 settles the absence of an L5 walk: the slice adds no user-facing
path, and the existing e2e suite is the regression gate.

| AC | Test file | The `it(...)` that proves it |
|---|---|---|
| AC-1 | `scripts/check-secrets.spec.mjs` | `every variable in a package example is in the root example` (real files) · `names the variable and the file that has it` (fixture) |
| AC-2 | `scripts/check-secrets.spec.mjs` | `declares exactly seven secrets, every one documented in the root example` · `writes no defineSecret name into functions/.env — only FIRESTORE_DATABASE_ID` · `reports a workflow line that writes a secret into functions/.env` · `throws on a heredoc redirect into functions/.env rather than reading nothing` |
| AC-3 | `scripts/check-readme.spec.mjs` | `every `npm run` the real README names resolves` · `reports `npm run dev:emulator` at the root — the brief's own failing example` · `accepts the same script under `npm --prefix frontend`` |
| AC-4 | `scripts/check-readme.spec.mjs` | `every path the real README names exists on disk` · `reports a script that no longer exists` · `reports a markdown link to a document that is not there` · `reports nothing for an external URL, an anchor, or an API route` |
| AC-5 | `scripts/check-readme.spec.mjs` | `the real README carries all seven brief-named sections` · `names the section a README is missing` |
| AC-6 | `scripts/check-readme.spec.mjs` | `the real README stays inside both caps` · `names the section and the count when an eleventh decision is added` · `…when a sixth improvement is added` |
| AC-7 | `scripts/check-readme.spec.mjs` | `the real README carries both derived URLs in its Live URLs section` · `fails when `.firebaserc` alone names a different project` · `derives both URLs from the real .firebaserc and firebase.json` · `throws when the rewrites name two regions, rather than picking one` |
| AC-8 | `scripts/check-readme.spec.mjs` | `the real README names `firebase emulators:start` and `npm run dev`` · `fails when local setup never names the emulator` · `fails when the root `dev` script stops wrapping the emulators` |
| AC-9 | `functions/src/hl/readme.spec.ts` | `finds no difference between the README and HL_ROUTES`, plus nine mutations — added route, drifted `Version`, drifted scope, flag lost in either direction, row rendered twice, forgotten, invented, and no table at all |
| AC-10 | `scripts/check-readme.spec.mjs` | `the real README makes none of them` · `reports an SDK call named in prose` · `reports the architecture decision the README carried on `main`` · `reports every claim a fixture makes, not just the first` |
| AC-11 | `scripts/seed-sandbox.spec.mjs` | `prints 20 contact lines and 8 appointment lines and issues zero requests` · `needs no calendar — it prints <resolved at run time> for an omitted id` · `plans every appointment inside the next 14 days` |
| AC-12 | `scripts/seed-sandbox.spec.mjs` | `issues exactly 28 requests: 20 contact creates and 8 appointment creates` · `carries the bearer token, Accept and the row Version on every request` · `carries the seed location id in every body` · `schedules every appointment inside the next 14 days, ISO 8601 with an offset` · `counts what it created and exits 0` |
| AC-13 | `scripts/seed-sandbox.spec.mjs` | `counts every duplicate refusal as existing, not as a failure, and exits 0` · `still creates the 8 appointments, against the ids the refusals carried` |
| AC-14 | `scripts/seed-sandbox.spec.mjs` | `rejects with SeedConfigError naming HL_SEED_TOKEN and issues zero requests` · `…naming HL_SEED_LOCATION_ID and issues zero requests` · `names the root .env.example, so the operator knows where the variable belongs` |
| AC-15 | `scripts/seed-sandbox.spec.mjs` | `attempts the other 19 contacts when the third fails, and names it` · `records a network rejection exactly as it records a 5xx` · `records a failed appointment against a stable item string too` |
| AC-16 | `scripts/seed-sandbox.spec.mjs` | `finds none of them in scripts/seed-sandbox.mjs` · `reports a mention wherever it is — an import, a URL, or a comment` · `imports nothing but Node built-ins` · `guards its CLI, so importing this module seeds nothing` |
| AC-17 | `scripts/check-deliverables.spec.mjs` | `reports nothing for the real loom-script.md` · `is the brief golden path, in the brief order` · `spends the pinned budget on the nine beats, in order` · `leaves ten seconds of headroom under the budget` · plus four fixtures that make it fail |
| AC-18 | `scripts/check-deliverables.spec.mjs` | `reports nothing for the real release-checklist.md` · `carries D2's three owners: 2 automated, 6 this PR, 11 human` · `names the line when an item has no owner tag` · `…carries two owner tags` · `…when the only tag is on a continuation line` |

**No AC is unmapped, and every named test passes.** T6, T10 and T17 close no AC on their own,
as the plan says: T6 is the calendar-resolution edge AC-12 depends on, T10 is the deliverable
the checks hold true, T17 is D17 and the ledger.

## Deviations from the plan

| # | What | Why |
|---|---|---|
| D-B1 | One commit per task rather than a `test:` commit then a `feat:` one | The lanes' tasks grow the same two files, so the only states that exist are the green ones. A `test:` commit split out of a snapshot would be a red commit, which the skill forbids. Recorded above under *How this build was run*. |
| D-B2 | Six exported names beyond the pinned interfaces — `printSummary` in `seed-sandbox.mjs`; `README`, `sectionProblems`, `liveUrlProblems`, `localSetupProblems`, `scriptCommand` in `check-readme.mjs` | All additive; no pinned name or shape was varied. Each exists because the plan's red step demands a failure message naming a specific thing, and the CLI must print the same string — formatting it in the spec would leave every line the CLI prints untested. |
| D-B3 | `parseArgs` throws on an unknown flag rather than ignoring it | Unspecified either way. A silently-dropped `--calender-id` typo would seed against whichever calendar HighLevel lists first, which is the outcome the flag exists to prevent. |
| D-B4 | `readConfig` reads `HL_API_BASE` as an optional override of the default base | Introduces no new variable — `HL_API_BASE` is already documented, and the operator block still needs only the two. It is what lets every seed test point at a stub without a global fetch mock. |
| D-B5 | Two README corrections after T10, in `dd55da0` | Found by the fresh-clone walk, which is in the definition of done precisely to find claims no test reaches. Written up under *Manual verification*. |
| C2 (plan) | AC-17 and AC-18 live in `check-deliverables.spec.mjs`, not `check-readme.spec.mjs` as the PRD's test matrix says | The plan took this deliberately, for lane disjointness and because a module should be named for what it checks. Same level, same suite, same assertions. |

## Deferred

Nothing from the plan's task list. Everything the slice cannot close from an unattended
session is in `release-checklist.md` with an owner and a procedure — eleven human items,
including the two hand-checks §9 owes (the server-side SSE disconnect, F6.5, and the
client-disconnect partial persistence, F8.2).

Out of scope and named as such: the live seed run, the Loom recording, registering the
deployed redirect URI, and reading the Cloud Run environment by hand.

## Final suite

Run at `dd55da0`, on the branch, after every task:

| Suite | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, zero warnings |
| `functions` unit | 48 files, **1197** tests passed |
| `frontend` unit | 73 files, **1062** tests passed |
| `scripts` unit (`test:scripts`) | 7 files, **143** tests passed |
| `test:rules` | 1 file, **52** tests passed |
| `test:integration` | 17 files, **378** tests passed |
| `npm test` | exit **0** |
| `npm run test:e2e` | **19** passed, exit **0** |

Baseline was 47 / 73 / 3 files and 1187 / 1062 / 25 tests, so this slice adds **1 functions
spec file, 4 scripts spec files, and 128 tests**, and changes no existing one.

<!-- build-complete -->
