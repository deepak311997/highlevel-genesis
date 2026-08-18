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

