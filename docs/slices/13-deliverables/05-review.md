# Slice 13 — Deliverables · Review

**Reviewed:** `git diff main...HEAD`, 6,558 insertions across 23 files, at `bd4f0df`.
**Fixes:** `7d12b9e` — 22 findings: 7 behavioural (each failing-test-first), 12 documentation,
2 test-coverage, 1 repository hygiene.
**Verdict:** approve after the fixes. The build is strong work; what it missed is
concentrated in exactly one place, and that place is the point of the slice.

---

## Suite

Baseline from `.autopilot/logs/13/gate-post-build.1.log`, run by the orchestrator on
`bd4f0df` minutes before this stage. Re-runs are the suites the fixes touch.

| Check                                                        | Result at `bd4f0df`          | After the fixes                   |
| ------------------------------------------------------------ | ---------------------------- | --------------------------------- |
| `typecheck`                                                  | ✅                           | ✅ re-run                         |
| `lint`                                                       | ✅ zero warnings             | ✅ re-run                         |
| `test:unit` — functions                                      | ✅ 48 files, 1197 tests      | ✅ 48 files, **1198** tests       |
| `test:unit` — frontend                                       | ✅ 73 files, 1062 tests      | untouched                         |
| `test:unit` — scripts                                        | ✅ 7 files, 143 tests        | ✅ 7 files, **162** tests         |
| `test:rules`                                                 | ✅ 1 file, 52 tests          | untouched                         |
| `test:integration`                                           | ✅ 17 files, 378 tests       | untouched                         |
| `test:e2e`                                                   | ✅ 19 passed                 | untouched                         |
| `prettier --check`                                           | 3 docs pre-existing warnings | ✅ every file this review touched |
| `check-readme` / `check-secrets` / `check-deliverables` CLIs | exit 0                       | exit 0                            |

Net: **+19 scripts tests, +1 functions test.** Nothing was weakened, skipped or deleted.

`git diff --stat main...HEAD -- frontend/src firestore.rules firestore.indexes.json
tests/rules` is empty, so **D14 holds and is measured**, not asserted.

---

## Method

Read the diff in full first, then six agents concurrently on one axis each —
correctness, security, architecture/readability, AC audit, documentation accuracy — and
judged every claim against the code before it reached this file. Findings I could not
reproduce were dropped; three were, and they are listed under _Dropped_ at the foot.

---

## Findings

Ordered by leverage. Severity is mine, weighed against the PRD's decisions table.

### Required — fixed

| #   | Severity            | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Action taken                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Critical**        | `plainEnvVarsInDeploy` (`scripts/check-secrets.mjs`) recognised exactly one shell idiom and returned `[]` for every other way of filling `functions/.env` — and `[]` is that function's own word for _"the deploy writes no secrets"_. Reproduced: a `gcloud secrets versions access latest --secret=FUNCTIONS_ENV >> functions/.env` line **appended beside** today's readable one still returned `['FIRESTORE_DATABASE_ID']`, so all seven `defineSecret` values would upload as plain Cloud Run environment variables — readable by anyone with Viewer — with the suite green. `deploy.yml` already uses that exact idiom for `frontend/.env`, so it is the obvious next edit. The author identified this failure class and guarded one instance of it (the heredoc `throw`); eight others were silent. | Default inverted: a line that _fills_ `functions/.env` in a form the reader cannot decompose into `NAME=` assignments now **throws**. Eight forms covered by test — Secret Manager fetch, quoted target, path-prefixed target, `>\|`, `tee`, `cp`, a continuation line, an expanded whole-line variable — plus a test that reads and reads-only still work. |
| F2  | **Critical**        | Same file: plain variables were checked against the `defineSecret` **names**, so `echo "ANTHROPIC_KEY=$ANTHROPIC_API_KEY" > functions/.env` passed clean. And `definedSecrets` matched single quotes only, so a double-quoted or computed declaration was invisible twice over — absent from the `.env.example` requirement _and_ absent from the comparison, leaving the deploy free to write that name.                                                                                                                                                                                                                                                                                                                                                                                                  | `ALLOWED_PLAIN_VARS = ['FIRESTORE_DATABASE_ID']` — an allowlist, so a rename has nothing to hide behind. `definedSecrets` takes either quote and throws when a `defineSecret(` call's name is not a readable literal.                                                                                                                                       |
| F3  | Required            | `resolveCalendar` (`scripts/seed-sandbox.mjs`): a `--calendar-id` the location does not list fell through `?? calendars[0]` and returned the operator's id paired with a **different calendar's** team member. Reproduced live. This is precisely the "seed against whichever calendar HighLevel lists first" outcome the flag exists to prevent (the file's own docblock, and build-log D-B3) — a typo in the flag _name_ was caught, a typo in its _value_ was not — and it contradicts the PRD's edge-case row, which promises exit 1. Cost: twenty real contacts created before eight appointments fail on an upstream 4xx naming neither problem.                                                                                                                                                     | Throws `SeedConfigError` naming the id, what the location does list, and the `--assigned-user-id` escape hatch for a calendar that exists but is not listed. Two tests, including the both-flags case that issues no request at all.                                                                                                                        |
| F4  | Required            | A blank `HL_API_BASE` produced `apiBase: ''`, making all 28 URLs relative and failing every request with `Failed to parse URL from /contacts/` — which reads as HighLevel's fault. `??` guards `undefined`, not `''`, and `HL_API_BASE=` is a documented **blank-by-default** line in both `.env.example` files, so anyone who sources one lands on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Blank counts as unset, as it already did for the two required variables beside it.                                                                                                                                                                                                                                                                          |
| F5  | Required            | `loomShotList` dropped any table row whose Beat cell was not a backticked slug — including its **Length**. Reproduced: one `\| 0 \| intro card \| 0:40 \| … \|` row made a 5:30 shot list pass AC-17's 5:00 cap, reporting 4:50. The cap is the brief's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | A duration is what makes a row a row: timed rows are kept with `beat: null`, counted toward the budget, and reported by name. The table now also ends at the first non-table line, so a second table cannot merge into it.                                                                                                                                  |
| F6  | Required            | `orderedItemCount` counted `^\d+\.\s` only, so both brief-mandated caps were vacuous for any other list syntax. Reproduced: 25 dash-bulleted decisions and 25 improvements returned `[]` problems. There was no lower bound either — an empty section passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Renamed `topLevelItemCount`, counts `-` and `*` as well as `N.`; the real-README test now also asserts each capped section is non-empty.                                                                                                                                                                                                                    |
| F7  | Required (security) | The unknown-flag error echoed the whole argument, so an operator guessing at `--token=pit-…` — plausible, since the script _has_ flags — put the token on stderr, which the release checklist then asks them to paste into an evidence slot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Reports the flag name, never its value. This was the only path by which `HL_SEED_TOKEN` reached any output; every other path traces clean (see _Token boundary_).                                                                                                                                                                                           |

### Required — documentation. The claims no check can reach.

This slice's deliverable **is** the prose, so a false sentence here is a defect, not a nit.
Each was verified against the code before being called wrong.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Action taken                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F8  | **Architecture decision #1** — the one the README leads with — described "an import shim and a `fetch` wrapper that routes HighLevel calls back through the proxy". There is no `fetch` wrapper: `grep -c fetch frontend/src/lib/previewShim.ts` is **0**. It exposes `window.hl(method, path, payload)` brokered over `postMessage`, and a `fetch` wrapper is impossible — `PreviewPanel.vue:217` mounts the frame with no `allow-same-origin`, so it has an opaque origin. `loom-script.md` beat 6 described it _correctly_, so the two deliverables contradicted each other. | Rewritten to what the code does, naming the missing `allow-same-origin` as the reason the broker exists.                                                                                                                                                                                                                                                 |
| F9  | **Decision #9** claimed `generate` carries "a warm instance". `grep -rn minInstances functions/src` returns nothing; every generation pays a cold start. `functions/src/index.ts:58` carried the same claim, and is where the README's came from.                                                                                                                                                                                                                                                                                                                               | Both corrected to the real numbers (540 s / 512 MiB vs 60 s / 256 MiB), with the absence of `minInstances` stated as the cost decision nobody has taken.                                                                                                                                                                                                 |
| F10 | The **Loom script** told the recorder to say verification is "enforced in the Firestore rules, not just the router". `firestore.rules` contains no `email_verified` condition — every match block is `allow read, write: if false`, and the file's own header says it is "the backstop, **not** the enforcement". Said on camera to a grader, this claims the opposite of the architecture the recording exists to sell. Beat 2 also said the OAuth state is "signed"; it is AES-256-GCM **encrypted**, and `functions/.env.example` argues explicitly for the stronger word.   | Both lines corrected.                                                                                                                                                                                                                                                                                                                                    |
| F11 | **Repository layout** misfiled four directories and omitted five. `files/`, `messages/` and `snapshots/` are siblings of `projects/`, not its contents; `users/` and `lib/` were missing; `src/api/` was credited with the OAuth callback and proxy, which live in `src/hl/` — the very next line. Frontend `router/` and `composables/` were absent.                                                                                                                                                                                                                           | Rewritten against `ls functions/src` and `ls frontend/src`.                                                                                                                                                                                                                                                                                              |
| F12 | "`scripts/` — repo checks and operator scripts, **each with a spec beside it**" is false for `setup-deploy.sh`, `autopilot.sh` and `autopilot-status.sh`. The claim is load-bearing: it is the README's argument that the checks are self-verifying, and `setup-deploy.sh` is one the README tells a reader to run.                                                                                                                                                                                                                                                             | "every .mjs one with a spec beside it".                                                                                                                                                                                                                                                                                                                  |
| F13 | "20 contacts and 8 appointments **over the next fortnight**". Two per business day means eight occupy **four** business days — never two weeks. `HIGHLEVEL_PLATFORM.md`, edited by this slice, still specified "5–10 over the next two weeks".                                                                                                                                                                                                                                                                                                                                  | Both corrected; the README now states 10:00 and 15:00 **UTC** explicitly (see F14).                                                                                                                                                                                                                                                                      |
| F14 | `plannedAppointments` takes an `offsetMinutes` that **nothing passes** — `seed()` has no call site, flag or variable for it — so every appointment renders `+00:00` while the code comment claimed "10:00 and 15:00 local to the offset" and the PRD claimed "in business hours". For a US Pacific sandbox that is 03:00 and 08:00 local, on camera.                                                                                                                                                                                                                            | Comment corrected to state UTC and that the parameter has no caller. A **new human checklist item** asks the operator to check the times read sensibly, with `--utc-offset` named as the follow-up — the plumbing and its tests exist, only a flag and a call site are missing. Adding CLI surface in review was the wrong stage for it; see _Deferred_. |
| F15 | The **duplicate-refusal hand-check** — the evidence the PRD's own risk table nominates for D10 — curled `Ada Okafor / ada.okafor@genesis-seed.test`, a contact `plannedContacts` never creates, under a different domain. Run as written it returns `201`, and the operator records a success body as "the duplicate-refusal shape".                                                                                                                                                                                                                                            | Uses seed row 1 verbatim (`amara.osei@genesis-seed.example.com`), with a sentence saying why any other contact settles nothing.                                                                                                                                                                                                                          |
| F16 | The checklist told the operator to expect `contacts: { created: 20, existing: 0, failed: 0 }`. `printSummary` prints prose (`contacts:     20 created, 0 existing, 0 failed`); anyone diffing literally would think the run failed. It also credited `functions/src/hl/readme.spec.ts` to `npm run test:scripts`, which globs `scripts/**/*.spec.mjs` and cannot run it.                                                                                                                                                                                                        | Both corrected to the real output and the real runner.                                                                                                                                                                                                                                                                                                   |
| F17 | Prerequisites named "any JDK 11+". `firebase-tools@14.23` sets `MIN_SUPPORTED_JAVA_MAJOR_VERSION = 21` and prints an **error-labelled** deprecation below it — on every `npm run dev`, against a README whose standard is a clean fresh clone.                                                                                                                                                                                                                                                                                                                                  | Corrected to JDK 21+, and a line added saying `firebase-tools` comes from the root devDependencies so no global install is needed.                                                                                                                                                                                                                       |
| F18 | Three stale lines in `docs/IMPLEMENTATION_PLAN.md` §7 — inside and beside the region **this slice edited**. "`main` carries Slice 0; `slice/01-account-session` is open" (the same file's §1 table, updated in this diff, says twelve merged); "**Running it:**" whose antecedent became a script the paragraph above announces as deleted; and "Slice 13 still owes the README a walked-through version of this", eleven lines below where this slice marks that row ✅. Same class of defect the slice exists to eliminate.                                                   | All three corrected.                                                                                                                                                                                                                                                                                                                                     |
| F19 | The PRD's test matrix credits AC-17 and AC-18 to `check-readme.spec.mjs`. They live in `check-deliverables.spec.mjs` — a deliberate, recorded move (plan C2, build-log D-B2), but the matrix was never updated, so the PRD was the stale document.                                                                                                                                                                                                                                                                                                                              | Rows corrected, with a note recording _why_ they moved rather than silently rewriting history.                                                                                                                                                                                                                                                           |

### Required — test coverage

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Action taken                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| F20 | The appointment→contact mapping had **no test**. `contact-create.json` answers every one of the twenty creates with the same id, so `expect(call.body.contactId).toBe(CONTACT_CREATED.contact.id)` holds however the ids are assigned. Verified by mutation: replacing `contactIds[index % contactIds.length]` with `contactIds[0]` books all eight appointments against one contact — visibly wrong in the preview beat 6 is built on — and every AC-12 and AC-13 test still passed. | A per-call stub returning `seed-contact-<index>` makes the mapping observable; the test fails against the mutation and passes against the real code. |
| F21 | The README's prose count — "forwards only these **thirteen** routes" — sat above a table pinned row-for-row to `HL_ROUTES` while being unchecked itself, as did the Loom's ninth beat ("Thirteen routes"). A fourteenth route forces the table to grow and leaves both sentences wrong.                                                                                                                                                                                               | `readme.spec.ts` now derives the spelled-out count from `HL_ROUTES.length` and asserts it in both documents.                                         |

### Repository hygiene

| #   | Finding                                                                                                                                                                                                                                                                      | Action taken                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| F22 | `.claude/worktrees/` — a full checkout of this repository — is untracked and **not** ignored. `.claude/` cannot be ignored wholesale because `.claude/skills/` is committed, so it needs its own line; without it a `git add -A` in the ship stage commits a duplicate repo. | Added to `.gitignore` with the reason. |

---

## AC coverage

Every AC audited against the test that claims it, by opening the test — not the matrix.
All eighteen are covered, and every file-reading check asserts over the **real** committed
artefact as well as a fixture, which is the PRD's own rule for this slice.

| AC    | Test                                                                                         | Verified                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | `check-secrets.spec.mjs` — `every variable in a package example is in the root example`      | ✅ real files; negative fixture names the variable and its file                                                                       |
| AC-2  | `check-secrets.spec.mjs` — `declares exactly seven secrets…`, `writes no defineSecret name…` | ✅ real `deploy.yml` + real `functions/src`; **strengthened** by F1/F2                                                                |
| AC-3  | `check-readme.spec.mjs` — `every npm run the real README names resolves`                     | ✅ the brief's own failing example (`npm run dev:emulator` at root) asserted                                                          |
| AC-4  | `check-readme.spec.mjs` — `every path the real README names exists on disk`                  | ✅ negative fixture is `scripts/set-verified.mjs`, the exact regression                                                               |
| AC-5  | `check-readme.spec.mjs` — `the real README carries all seven brief-named sections`           | ✅                                                                                                                                    |
| AC-6  | `check-readme.spec.mjs` — `the real README stays inside both caps`                           | ✅ **after F6**; was bypassable by list syntax, and had no lower bound                                                                |
| AC-7  | `check-readme.spec.mjs` — `fails when .firebaserc alone names a different project`           | ✅ derived, not matched — the strongest form of this check                                                                            |
| AC-8  | `check-readme.spec.mjs` — `fails when the root dev script stops wrapping the emulators`      | ✅ (see _Deferred_ — `npm run dev` is a substring test)                                                                               |
| AC-9  | `functions/src/hl/readme.spec.ts` — 10 tests                                                 | ✅ the strongest in the slice; both directions on the disabled flag, invented/forgotten/duplicated rows. **F21** adds the prose count |
| AC-10 | `check-readme.spec.mjs` — `the real README makes none of them`                               | ✅ the exact sentence `main` carried is a negative fixture                                                                            |
| AC-11 | `seed-sandbox.spec.mjs` — dry run, `noFetch` stub                                            | ✅ zero requests proven by a stub that throws                                                                                         |
| AC-12 | `seed-sandbox.spec.mjs` — 7 tests                                                            | ✅ every clause: count, headers, versions, location id, ISO+offset inside 14 days, ordering (**F20**), exit 0                         |
| AC-13 | `seed-sandbox.spec.mjs` — `counts every duplicate refusal as existing…`                      | ✅ ids reused, exit 0                                                                                                                 |
| AC-14 | `seed-sandbox.spec.mjs` — `rejects with SeedConfigError… issues zero requests`               | ✅ behaviour; exit code via `exitCodeFor` (see _Deferred_)                                                                            |
| AC-15 | `seed-sandbox.spec.mjs` — 3 tests                                                            | ✅ 500, network rejection, and a failed appointment, each named with a stable item string                                             |
| AC-16 | `seed-sandbox.spec.mjs` — `forbiddenMentions` over the real source                           | ✅ no Firebase import, no proxy URL, no message send; scanner proven to fire                                                          |
| AC-17 | `check-deliverables.spec.mjs` — real doc pinned beat-for-beat and second-for-second          | ✅ **after F5**; the cap was beatable                                                                                                 |
| AC-18 | `check-deliverables.spec.mjs` — `reports nothing for the real release-checklist.md`          | ✅ no tag, two tags, and continuation-line tags each proven to fail                                                                   |

---

## Genesis-specific checks

- **Firestore rules / L3:** no collection added, no rules change. `git diff --stat` proves it.
- **Token boundary:** traced every path in `seed-sandbox.mjs`. `headersFor` puts the token in
  an `Authorization` header, never a query string; `resolveCalendar` builds its URL with
  `encodeURIComponent` and no credential; `printPlan` prints location, base, calendar,
  assignee and fictional 555 numbers; `required()` names the variable, never the value;
  `messageOf` reproduces only HighLevel's own body; the entry-point catch prints
  `err.message`. The one leak was **F7**, now closed. No OAuth token is touched at all.
- **Proxy routes:** unchanged. The seeder calls HighLevel directly by design (D9) and never
  `POST /conversations/messages` — asserted by a source scan that is itself tested.
- **Streaming / partial persistence:** untouched.
- **Secrets:** none in source. Grepped the diff for `sk-ant-`, `AIza`, `pit-`, `ghp_`, PEM
  headers and long base64; the only hit is an obvious spec fixture. `.env.example` at full
  parity, tested, and **F1/F2** make the deploy-side proof considerably harder to fool.
- **States:** no new screen, so none owed (D14).
- **Dependencies:** none added. `package.json` / lockfile untouched by this slice.
- **Scope:** clean. `check-deliverables.{mjs,spec.mjs}` is absent from the PRD's in-scope
  list but is a recorded, reasoned plan decision (C2) — a module named for what it checks —
  and the PRD's matrix was the weaker call. **F19** corrects the matrix rather than the code.

---

## Dead code (step 9) — decided, since there is no one to ask

**`scripts/check-readme.mjs`, `check-secrets.mjs` and `check-deliverables.mjs` each carry a
CLI `main` block that no npm script, CI step or shell script invokes.** ~117 lines that never
execute in an automated run — message formatting and `process.exit` paths included.

**Decision: keep them, do not wire CI.** They have a documented human caller —
`release-checklist.md` and `loom-script.md` both instruct an operator to run
`node scripts/check-deliverables.mjs` — so they are operator tooling, not dead code, and the
guarantees themselves are held by the specs, which do run. Wiring them into `ci.yml` is the
better end state and follows the `check-no-firestore.mjs` precedent, but the PRD puts CI
workflow changes explicitly out of scope and the pipeline is green; doing it here would be
the review taking a scope decision that belongs to a slice. I ran all three by hand: exit 0.

**Named as the follow-up:** one root `check:docs` script calling all three, and one CI step
beside the existing `check-no-firestore` step.

Nothing else in the diff is unreachable. `scripts/bootstrap-github.sh` was deleted (D17) and
`git grep bootstrap-github` leaves only the one intentional historical mention in
`IMPLEMENTATION_PLAN.md` §7, which this review corrected the surrounding prose of (**F18**).

---

## Deliberately deferred

Real, recorded, not fixed — with why.

| Finding                                                                                                                                                                                                                         | Why not now                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`--utc-offset` flag for the seeder.** `offsetMinutes` is plumbed and tested but has no caller.                                                                                                                                | Adding CLI surface is a slice decision, not a review one. The false _claims_ are fixed (**F14**), the operator is warned in the checklist, and the follow-up names exactly what is missing.                               |
| **A shared `scripts/repo.mjs`** — `ROOT` and the `import.meta.url === pathToFileURL(argv[1])` guard are copy-pasted six times, two files now export a colliding `ROOT`, and markdown section-slicing has three implementations. | Genuine duplication, and it is the fourth use, not the third. But it is a refactor across six files, and a change that refactors _and_ fixes behaviour is two changes. Worth its own PR.                                  |
| **`readme.spec.ts` renders rather than parses.** 376 lines of markdown parser and mutation kit to check 13 rows agree; `expect(readme).toContain(renderAllowlist(HL_ROUTES))` would delete most of it.                          | The current shape produces better diagnostics and has the best coverage in the slice. Rewriting a working, well-tested file at the gate relocates risk rather than reducing it.                                           |
| **Splitting `seed-sandbox.mjs` (596 lines) / its spec (925).** The pure planners are a clean seam.                                                                                                                              | Neither is unreadable; the spec is the one that hurts. Same reasoning as above.                                                                                                                                           |
| **`pathsNamed` only sees six path roots**, so the whole repository-layout block (`src/views/`, `src/stores/`, …) and bare root files (`firebase.json`, `firestore.rules`) are unchecked.                                        | The docblock already reasons about this boundary and the noise that widening it brings. **F11** fixed the layout block's actual staleness by hand; the checker gap is a known, written-down limitation, not a silent one. |
| **AC-14's "exits non-zero" is asserted through `exitCodeFor`, not the process.** The CLI block's `process.exit` is source-scanned only.                                                                                         | Eight lines behind an `import.meta.url` guard; spawning a subprocess per test to cover them is a poor trade. Recorded.                                                                                                    |
| **AC-8's `npm run dev` check is a substring test** — `npm run dev:cloud` would satisfy it.                                                                                                                                      | Harmless today (the README names bare `npm run dev`), and the second half of that check — the root `dev` script must contain `emulators:exec` — is the load-bearing one.                                                  |
| **`--dry-run=false` sets `dryRun = true`.**                                                                                                                                                                                     | Fails safe, which is the right direction for a flag that decides whether real writes happen.                                                                                                                              |
| **`duplicateContactId` requires exactly `400`.** If the live sandbox answers `409`, a re-run reports 20 failures.                                                                                                               | Already the PRD's named risk, and already a human checklist item — now with the correct curl (**F15**).                                                                                                                   |
| **The release checklist's curls expand `$HL_SEED_TOKEN` into `argv`**, visible in `ps aux`.                                                                                                                                     | Real on a shared host, marginal for a personal sandbox PIT. Rewriting to `--header @-` costs the checklist its copy-pasteability. Recorded here.                                                                          |
| **CI pins `java-version: 17`**, below firebase-tools' supported 21.                                                                                                                                                             | CI changes are out of scope (PRD) and the pipeline is green — it is a deprecation warning, not a failure. **F17** fixed the README's advice to readers.                                                                   |
| **`.claude/worktrees/` still on disk** as an untracked stale checkout.                                                                                                                                                          | Now ignored (**F22**); deleting another agent's worktree is not this review's call.                                                                                                                                       |

---

## Dropped — claims that did not survive verification

Recorded because dropping them is the work, not a shortfall of it.

- _"`plainEnvVarsInDeploy` returning `[]` is a silent all-clear that nothing catches."_
  Partly wrong. `check-secrets.spec.mjs` pins `plainEnvVarsInDeploy(real deploy.yml)` to
  exactly `['FIRESTORE_DATABASE_ID']`, so **replacing** the readable line is caught. Only the
  _append-beside_ case slipped through — which is what F1 actually fixes, and why the finding
  is narrower than it was reported.
- _"The README's `working-directory: functions` + `> .env` form is a live hole."_
  `deploy.yml` uses no such form; it is a hypothetical about a refactor. F1 covers it anyway.
- _"'Twelve slices merged… this is the thirteenth' contradicts the plan's fourteen rows."_
  The plan's table includes Slice 0 (Rails) and Slice 2b. Under the natural reading —
  numbered slices 1–12 merged, this is 13 — the sentence is correct. Not a defect.

---

## Manual verification

- Reproduced **F1** (append-beside), **F3** (calendar fallback), **F5** (5:30 shot list),
  **F6** (25 dash bullets) and **F4** (blank base) by executing the real exported functions
  before writing a line of fix.
- Mutation-tested **F20**: swapped `contactIds[index % contactIds.length]` for
  `contactIds[0]`; the new test failed, the old ones did not. Reverted.
- Verified every prose correction against source: `grep -c fetch previewShim.ts` → 0;
  `grep -rn minInstances functions/src` → none; `ls functions/src` and `ls frontend/src` for
  the layout; `firestore.rules` for the `email_verified` claim;
  `MIN_SUPPORTED_JAVA_MAJOR_VERSION = 21` in the installed firebase-tools; emulator ports
  9099 / 5001 / 4000 / 5173 against `firebase.json` and `vite.config.ts`;
  `functions/.env.local` confirmed committed (`git ls-files`), which is what makes the
  README's "no `.env` needed" true.
- Ran all three check CLIs by hand: exit 0, output as documented.

---

## What I checked and found sound

Said plainly, because a review that only lists faults misrepresents this diff.

- The **AC-9 allowlist spec** is the best test in the slice: a set keyed on `METHOD path`
  with row counts asserted, the disabled flag compared in both directions, and nine negative
  cases mutating both the table and the README's own text.
- **Every check asserts twice** — a fixture that proves it can fail, and the real committed
  file that proves it passes. The PRD demanded this and the build actually did it, on all
  thirteen file-reading criteria. That is rarer than it sounds.
- **`--dry-run` is genuinely free.** The branch returns before `counted` is ever constructed;
  `resolveCalendar` is not called; a stub that throws on any request proves it.
- **No test opens a socket or reads a clock.** `fetchImpl`, `now` and `out` are injected
  throughout; the global `fetch` is never patched.
- **`liveUrls` derives rather than matches.** A test comparing the README against a string
  written into the test would pass forever after a project rename. This one reads
  `.firebaserc` and `firebase.json` — the same files the deploy reads.
- The **deviations are recorded honestly** (D-B1 … D-B5, C2), including the one the PRD's
  matrix contradicts. The build log did not paper over anything I could find.

---

## Verdict

**Approve.** Twenty-two findings, all fixed or recorded with a reason. The two that mattered
were both checks that could not fail — one that would have let seven secrets onto a Cloud Run
revision as plain environment variables with a green suite, and one that let the brief's
five-minute cap be beaten silently — plus a seeder that would spend twenty real contacts on a
typo. Nine documentation claims described mechanisms this codebase does not have, which in a
slice whose deliverable _is_ the documentation is the same defect as a stale import.

Next: `/feature-ship 13`.
