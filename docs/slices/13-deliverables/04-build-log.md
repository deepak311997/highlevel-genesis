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

