#!/usr/bin/env bash
#
# Genesis autopilot — runs the five-stage slice loop end to end, unattended.
#
# For each slice, in order:
#   PRD → plan → build → local suite gate → review → local suite gate → ship (PR)
#   → wait for CI → merge to main → checkout main + pull → next slice.
#
# Every stage runs in a *fresh* `claude -p` session. Nothing is carried in memory
# between stages: each stage reads its inputs from disk (the PRD, the plan, the
# code, the build log), which is exactly what the five skills were written to do.
# The fresh session is the point — stage 3 of slice 9 gets a clean context window
# rather than the exhaust of eight previous slices.
#
# The orchestrator, not the model, owns the irreversible steps: merging, pushing
# to main, and deciding a stage passed. A stage "passed" means its artefact
# exists on disk and the suite is green — not that the model said it was done.
#
#   scripts/autopilot.sh                 # slice 3 through 13
#   scripts/autopilot.sh --from 5        # resume at slice 5
#   scripts/autopilot.sh --only "8 9"    # just those two
#   scripts/autopilot.sh --dry-run       # print the plan, run nothing
#   scripts/autopilot.sh --no-merge      # stop at the PR, leave the merge to a human
#   scripts/autopilot.sh --wait-ci       # gate the merge on GitHub checks too
#
# State lives in .autopilot/ (gitignored). Completed stages are marked, so a
# re-run picks up where a crash left off instead of redoing work.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR="$ROOT/.autopilot/state"
LOG_DIR="$ROOT/.autopilot/logs"
RUN_LOG="$ROOT/.autopilot/autopilot.log"
mkdir -p "$STATE_DIR" "$LOG_DIR"

# ─── configuration ────────────────────────────────────────────────────────────

: "${AUTOPILOT_MODEL:=}"              # e.g. opus; empty inherits the configured model
: "${AUTOPILOT_FALLBACK_MODEL:=}"     # model to fall back to if the primary is overloaded
: "${AUTOPILOT_MAX_BUDGET_USD:=}"     # optional per-session spend cap
: "${AUTOPILOT_STAGE_RETRIES:=2}"     # fresh-session retries per stage
: "${AUTOPILOT_FIX_ATTEMPTS:=3}"      # fix sessions per red suite / red CI
: "${AUTOPILOT_CI_TIMEOUT:=3600}"     # seconds to wait for GitHub checks

# Per-stage wall-clock ceilings, in seconds. Build is the long one.
: "${TIMEOUT_PRD:=3600}"
: "${TIMEOUT_PLAN:=2700}"
: "${TIMEOUT_BUILD:=21600}"
: "${TIMEOUT_REVIEW:=10800}"
: "${TIMEOUT_SHIP:=3600}"
: "${TIMEOUT_FIX:=10800}"

# ─── the slices ───────────────────────────────────────────────────────────────
# nn | slug | name | mode  — mirrors docs/IMPLEMENTATION_PLAN.md §4.
# Slugs are fixed here rather than left to the model, so branch names, doc paths
# and PR titles are predictable enough for this script to verify them.

SLICES=(
  "03|projects|Projects|fast"
  "04|workspace-shell|Workspace shell & chat persistence|full"
  "05|streaming-generation|Streaming generation|full"
  "06|file-operations|File operations|full"
  "07|monaco-editor|Monaco editor|fast"
  "08|highlevel-proxy|HighLevel API proxy|full"
  "09|highlevel-knowledge|HighLevel knowledge injection|full"
  "10|live-preview|Live preview|full"
  "11|snapshots-restore|Snapshots & restore|fast"
  "12|error-handling|Error handling & state hardening|fast"
  "13|deliverables|Deliverables|fast"
)

FROM=3
TO=13
ONLY=""
DRY_RUN=0
NO_MERGE=0
SKIP_LOCAL_GATE=0
WAIT_CI=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-merge) NO_MERGE=1; shift ;;
    --wait-ci) WAIT_CI=1; shift ;;
    --skip-local-gate) SKIP_LOCAL_GATE=1; shift ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# ─── plumbing ─────────────────────────────────────────────────────────────────

say() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$RUN_LOG"; }
rule() { printf '\n%s\n' "────────────────────────────────────────────────────────────" | tee -a "$RUN_LOG"; }
die() { say "FATAL: $*"; exit 1; }

marker() { echo "$STATE_DIR/$1.$2.done"; }
is_done() { [[ -f "$(marker "$1" "$2")" ]]; }
mark_done() { date -u +%FT%TZ > "$(marker "$1" "$2")"; }

# Portable wall-clock ceiling: gtimeout if coreutils is installed, else perl's
# alarm, which survives exec and kills the child on expiry.
with_timeout() {
  local secs="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout --signal=TERM --kill-after=30 "$secs" "$@"
  else
    perl -e '$s = shift; alarm $s; exec @ARGV or exit 127' "$secs" "$@"
  fi
}

# Renders the stream-json event feed as readable progress: assistant prose, one
# line per tool call, and the terminating result line.
pretty_stream() {
  jq -rj --unbuffered '
    if .type == "assistant" then
      (.message.content[]? |
        if .type == "text" then .text
        elif .type == "tool_use" then "\n  ⚙ \(.name)\n"
        else "" end)
    elif .type == "result" then
      "\n\n  ── \(.subtype) · \(.num_turns // 0) turns · $\(.total_cost_usd // 0 | . * 100 | round / 100)\n"
    else "" end
  ' 2>/dev/null || cat
}

# ─── the unattended contract ──────────────────────────────────────────────────
# Appended to the system prompt of every session. The five skills stay untouched;
# this is what tells a session it has no human to defer to, and which
# irreversible actions belong to the orchestrator instead.

base_addendum() {
  local nn="$1" slug="$2" name="$3" mode="$4"
  cat <<EOF
## Autopilot — you are running unattended

This session was launched by scripts/autopilot.sh. There is no human watching and
no one will answer a question. The session ends when you stop, and the next stage
starts in a brand-new session that shares none of your context.

**Slice under work:** $nn — $name
**Slice directory:** docs/slices/$nn-$slug/   (create it if it does not exist)
**Branch:** slice/$nn-$slug
**Planned mode:** $mode

### What this changes about how you work

- **Never call AskUserQuestion, and never end a turn waiting for an answer.** Where a
  skill says to interview the user, make the call yourself: pick the option the
  documents and the codebase best support, and record it in the decisions table with
  its rationale, exactly as if a human had chosen it. An unrecorded decision is the
  real failure here, not a decision made without asking.
- **When a skill's hard stop tells you to hand off to the user** ("stop, tell the user
  to run /feature-plan"), just stop. The orchestrator runs the next stage. Do not run
  the next stage yourself, and do not read ahead into it.
- **Everything written to disk is the handoff.** The next session knows only what is
  in the repo: the PRD, the plan, the build log, the review, the code. Anything you
  worked out and did not write down is lost.
- If you genuinely cannot proceed — the plan contradicts reality, a dependency does
  not exist — write what you found into the slice's docs, explain it in your final
  message, and stop. A stage that stops with the blocker written down is recoverable;
  one that improvises around it is not.

### Reserved for the orchestrator — never do these

- \`gh pr merge\`, \`gh pr review\`, or any merge into main
- committing or pushing directly to main
- \`git push --force\`, \`git reset --hard\` on anything already pushed, deleting branches
- \`firebase deploy\` or anything else touching deployed infrastructure
- editing .autopilot/ or scripts/autopilot.sh
- weakening, skipping, or deleting a test to get a green suite, or relaxing a lint or
  typecheck rule to get past it. If something cannot pass honestly, say so and stop.

### Standing rules

CLAUDE.md and docs/IMPLEMENTATION_PLAN.md are binding. Test-first is not negotiable:
the failing test exists before the implementation. No secrets in source. Every new
Firestore collection ships with rules and L3 rules tests in the same commit. Every new
screen ships with loading, empty, and error states.
EOF
}

stage_addendum() {
  local stage="$1" nn="$2" slug="$3" name="$4" mode="$5"
  base_addendum "$nn" "$slug" "$name" "$mode"
  case "$stage" in
    prd)
      cat <<EOF

### This stage: discovery + PRD

You are running with --fast because there is no one to interview. That is a change of
mechanism, not of depth. Work through the interview checklist in the skill yourself —
scope boundary, the demo, edge cases, failure modes, data shape, contracts — and answer
each item from docs/PRODUCT_SPEC.md, docs/HIGHLEVEL_PLATFORM.md, docs/IMPLEMENTATION_PLAN.md
and the merged slices under docs/slices/. Every question you would have asked becomes a
row in the decisions table with the answer you chose and why.

$([[ "$mode" == "full" ]] && echo "This slice is marked **full** mode in the implementation plan: it has real unknowns.
Be exhaustive — expect a dozen or more decisions, and state the alternative you rejected
for each of the load-bearing ones.")

Scope discipline matters more than usual with no human gate: the brief's own words are
the ceiling. If the slice is too big for one reviewable PR, say so in the PRD and cut
the excess into a later slice rather than building it.

Publishing 02-prd.html with the Artifact tool is best-effort — if publishing fails,
write the file, note the failure, and carry on. 02-prd.md is the contract and is not
optional.
EOF
      ;;
    plan)
      cat <<EOF

### This stage: technical plan

Read the PRD at docs/slices/$nn-$slug/02-prd.md, then read the real code you intend to
touch before writing a line of the plan. The build session will follow this plan
literally and will have no idea what you were imagining — every file path, function name
and existing pattern you cite has to be real.

Every AC in the PRD maps to at least one task. Say so explicitly for any that does not.
EOF
      ;;
    build)
      cat <<EOF

### This stage: build

Read docs/slices/$nn-$slug/03-plan.md and 02-prd.md first. Create the branch
slice/$nn-$slug from a clean, up-to-date main.

Work the tasks in order, one red-green-refactor cycle each, committing every cycle.
Append to 04-build-log.md as you go rather than at the end — if this session dies at
task 9, the log is what lets a fresh session pick it up.

Do not stop at "most tests pass". The stage is done when every acceptance criterion has
a named passing test and the full suite is green: typecheck, lint, test:unit, test:rules,
test:integration, test:e2e. If the plan turns out to be wrong, write the amendment and its
reasoning into the build log, follow the corrected route, and flag it clearly in your
final message.
EOF
      ;;
    review)
      cat <<EOF

### This stage: review

You are reviewing code you cannot remember writing, which is the right frame — treat it
as another author's PR. Read the diff against main in full.

There is no human reviewer after you. You are the last gate before this merges, so the
findings you skip are findings nobody makes. Run the suite yourself and record the real
counts. Fix what you find, test-first where the fix is behavioural. Step 9's dead-code
question has no one to answer it: decide it yourself and record the call in 05-review.md.

Do not write a review that finds nothing on a slice-sized diff. If the diff is genuinely
clean, say what you checked to be able to claim that.
EOF
      ;;
    ship)
      cat <<EOF

### This stage: ship

Run the preflight honestly — re-run the suite, do not trust the last session's word for
it. Rebase on current main, push slice/$nn-$slug, open the PR with \`gh pr create\`,
title \`Slice $nn — $name\`.

One addition to the skill: in the same branch, update the status table in §0 of
docs/IMPLEMENTATION_PLAN.md so it reflects this slice landing, and refresh the suite
counts there from the run you just did. That keeps main's own record of where the build
is accurate without anyone pushing to main by hand.

Then stop, with the PR URL in your final message. The orchestrator waits for CI and
merges. Do not merge, do not start slice $((10#$nn + 1)).
EOF
      ;;
  esac
}

# ─── running a stage ──────────────────────────────────────────────────────────

run_claude() {
  local stage="$1" nn="$2" slug="$3" name="$4" mode="$5" prompt="$6" timeout="$7" attempt="$8"
  local dir="$LOG_DIR/$nn"; mkdir -p "$dir"
  local raw="$dir/$stage.$attempt.jsonl" err="$dir/$stage.$attempt.err"

  local -a cmd=(claude -p "$prompt"
    --append-system-prompt "$(stage_addendum "$stage" "$nn" "$slug" "$name" "$mode")"
    --dangerously-skip-permissions
    --output-format stream-json --verbose
  )
  # Sessions stay persisted on purpose: when a stage goes wrong at 3am, being able
  # to `claude --resume` into that exact session is worth the disk.
  [[ -n "$AUTOPILOT_MODEL" ]] && cmd+=(--model "$AUTOPILOT_MODEL")
  [[ -n "$AUTOPILOT_FALLBACK_MODEL" ]] && cmd+=(--fallback-model "$AUTOPILOT_FALLBACK_MODEL")
  [[ -n "$AUTOPILOT_MAX_BUDGET_USD" ]] && cmd+=(--max-budget-usd "$AUTOPILOT_MAX_BUDGET_USD")

  say "→ slice $nn · $stage · attempt $attempt (log: ${raw#$ROOT/})"
  # errexit off across the pipeline: a session that times out or errors is a
  # normal outcome here, handled by the artefact check, not a reason to abort the
  # run. PIPESTATUS must be read immediately — `|| true` would overwrite it.
  local rc=0
  set +e
  with_timeout "$timeout" "${cmd[@]}" 2>>"$err" | tee -a "$raw" | pretty_stream
  rc="${PIPESTATUS[0]}"
  set -e
  if [[ $rc -ne 0 ]]; then
    say "   session exited $rc$( [[ $rc -eq 142 || $rc -eq 124 ]] && printf ' (timed out after %ss)' "$timeout") — stderr: ${err#$ROOT/}"
  fi
  return 0   # the artefact check below decides pass/fail, not the exit code
}

# A stage passes only if the thing it was supposed to produce exists.
stage_artefacts_ok() {
  local stage="$1" nn="$2" slug="$3"
  local d="docs/slices/$nn-$slug"
  case "$stage" in
    prd)    [[ -s "$d/02-prd.md" ]] ;;
    plan)   [[ -s "$d/03-plan.md" ]] ;;
    build)  git rev-parse --verify "slice/$nn-$slug" >/dev/null 2>&1 \
              && [[ -s "$d/04-build-log.md" ]] \
              && [[ $(git rev-list --count "main..slice/$nn-$slug" 2>/dev/null || echo 0) -gt 0 ]] ;;
    review) [[ -s "$d/05-review.md" ]] ;;
    ship)   gh pr view "slice/$nn-$slug" --json url -q .url >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

run_stage() {
  local stage="$1" nn="$2" slug="$3" name="$4" mode="$5" prompt="$6" timeout="$7"

  if is_done "$nn" "$stage"; then say "✓ slice $nn · $stage already done — skipping"; return 0; fi

  local attempt=1
  while (( attempt <= AUTOPILOT_STAGE_RETRIES + 1 )); do
    local p="$prompt"
    if (( attempt > 1 )); then
      p="$prompt

The previous attempt at this stage did not finish — its expected output is missing or
incomplete. Its transcript is at .autopilot/logs/$nn/$stage.$((attempt - 1)).jsonl and its
stderr at .autopilot/logs/$nn/$stage.$((attempt - 1)).err. Read enough of them to see how far
it got, then continue from there rather than starting over."
    fi
    run_claude "$stage" "$nn" "$slug" "$name" "$mode" "$p" "$timeout" "$attempt"
    if stage_artefacts_ok "$stage" "$nn" "$slug"; then
      mark_done "$nn" "$stage"; say "✓ slice $nn · $stage complete"; return 0
    fi
    say "✗ slice $nn · $stage produced no usable output on attempt $attempt"
    (( attempt++ ))
  done
  die "slice $nn stalled at stage '$stage' after $((AUTOPILOT_STAGE_RETRIES + 1)) attempts. Logs: ${LOG_DIR#$ROOT/}/$nn/"
}

# ─── the suite gate ───────────────────────────────────────────────────────────
# The orchestrator runs the suite itself. A model reporting green is a claim; this
# is the evidence. Red suite → fresh fix session pointed at the actual output.

suite_gate() {
  local nn="$1" slug="$2" name="$3" mode="$4" phase="$5"
  (( SKIP_LOCAL_GATE )) && { say "· local suite gate skipped by flag"; return 0; }

  local attempt=1
  while (( attempt <= AUTOPILOT_FIX_ATTEMPTS + 1 )); do
    local out="$LOG_DIR/$nn/gate-$phase.$attempt.log"
    say "· suite gate ($phase, attempt $attempt) — typecheck · lint · unit · rules · integration · e2e"
    if { npm run typecheck && npm run lint && npm run test:unit \
         && npm run test:rules && npm run test:integration && npm run test:e2e; } \
         >"$out" 2>&1; then
      say "✓ suite green"; return 0
    fi
    say "✗ suite red — see ${out#$ROOT/}"
    (( attempt > AUTOPILOT_FIX_ATTEMPTS )) && \
      die "slice $nn: suite still red after $AUTOPILOT_FIX_ATTEMPTS fix attempts ($phase). Logs: ${out#$ROOT/}"

    run_claude "fix-$phase" "$nn" "$slug" "$name" "$mode" \
"The suite is red on branch slice/$nn-$slug and must be green before this slice can go
further. The full output of the failing run is at ${out#$ROOT/} — read it first; do not
guess at the cause from the code.

Fix the failures properly:
- A failing test that is correct means the implementation is wrong. Fix the implementation.
- A failing test that is itself wrong gets fixed deliberately, with the reason recorded in
  docs/slices/$nn-$slug/04-build-log.md. Never delete, skip, or weaken a test to get green,
  and never relax a lint or typecheck rule to get past it.
- Typecheck and lint failures are real failures. Zero warnings is the standard.

Commit each fix. Re-run the specific failing suite, then the full suite, before you stop.
If the failure is environmental rather than a defect in this slice, say so explicitly in
your final message instead of papering over it." \
      "$TIMEOUT_FIX" "$attempt"
    (( attempt++ ))
  done
}

# ─── CI + merge ───────────────────────────────────────────────────────────────

wait_for_ci_and_merge() {
  local nn="$1" slug="$2" name="$3" mode="$4"
  local branch="slice/$nn-$slug"
  local pr_url; pr_url="$(gh pr view "$branch" --json url -q .url)"
  say "· PR open: $pr_url"

  if (( NO_MERGE )); then say "· --no-merge: stopping at the PR for slice $nn"; return 1; fi

  # The local gate already ran the same six suites CI runs, on the same commit.
  # Waiting for the remote copy of that answer costs minutes per slice, so by
  # default we merge on the local result and let CI report on main behind us.
  # --wait-ci puts the remote gate back in front of the merge.
  if (( ! WAIT_CI )); then
    say "· not waiting for CI (local gate already green) — merging"
    merge_pr "$nn" "$branch" "$pr_url"
    return 0
  fi

  local attempt=1
  while (( attempt <= AUTOPILOT_FIX_ATTEMPTS + 1 )); do
    local out="$LOG_DIR/$nn/ci.$attempt.log"
    say "· waiting on GitHub checks (attempt $attempt)"
    if with_timeout "$AUTOPILOT_CI_TIMEOUT" gh pr checks "$branch" --watch --fail-fast --interval 30 >"$out" 2>&1; then
      say "✓ CI green"
      break
    fi
    say "✗ CI red or timed out — see ${out#$ROOT/}"
    (( attempt > AUTOPILOT_FIX_ATTEMPTS )) && \
      die "slice $nn: CI still failing after $AUTOPILOT_FIX_ATTEMPTS fix attempts. PR: $pr_url"

    run_claude "fix-ci" "$nn" "$slug" "$name" "$mode" \
"CI is failing on the pull request for slice $nn ($pr_url), branch $branch.

Check out that branch if you are not on it. Get the failing job's log with
\`gh run view --log-failed\` (the watch output is at ${out#$ROOT/}) and read the actual
failure before changing anything — CI runs \`npm ci\` on a clean Ubuntu box with the
emulators, so it catches things a warm local checkout hides: an uncommitted lockfile
change, a file missing from git, a test that depends on local emulator state, a
platform-dependent path.

Fix the real cause, test-first where the fix is behavioural, commit, and push to the
branch. Never weaken a test or a lint rule to get CI green. Do not merge the PR." \
      "$TIMEOUT_FIX" "$attempt"
    (( attempt++ ))
  done

  merge_pr "$nn" "$branch" "$pr_url"
  return 0
}

merge_pr() {
  local nn="$1" branch="$2" pr_url="$3"
  git checkout main >/dev/null 2>&1
  say "· merging $branch"
  if ! gh pr merge "$branch" --squash --delete-branch >/dev/null 2>&1; then
    # Unmerged checks are the usual refusal when we did not wait for them.
    say "  plain merge refused — retrying with --admin"
    gh pr merge "$branch" --squash --delete-branch --admin >/dev/null 2>&1 \
      || die "slice $nn: merge failed. PR: $pr_url"
  fi
  git pull --ff-only >/dev/null 2>&1 || die "could not fast-forward main after merging slice $nn"
  git branch -D "$branch" >/dev/null 2>&1 || true
  say "✓ slice $nn merged to main"
}

# ─── one slice, end to end ────────────────────────────────────────────────────

run_slice() {
  local nn="$1" slug="$2" name="$3" mode="$4"
  rule
  say "SLICE $nn — $name  (branch slice/$nn-$slug, mode $mode)"

  # Every slice starts from a clean, current main. Anything else means the
  # previous slice left the tree in a state this script should not guess about.
  git checkout main >/dev/null 2>&1 || die "cannot check out main"
  [[ -z "$(git status --porcelain)" ]] || die "working tree is dirty on main — resolve it, then re-run (state is preserved in .autopilot/)"
  git pull --ff-only >/dev/null 2>&1 || die "cannot fast-forward main"

  run_stage prd    "$nn" "$slug" "$name" "$mode" \
    "Run the feature-prd skill for slice $nn in fast mode — invoke it as: /feature-prd $nn --fast. Follow it exactly, subject to the autopilot rules in your system prompt." \
    "$TIMEOUT_PRD"

  run_stage plan   "$nn" "$slug" "$name" "$mode" \
    "Run the feature-plan skill for slice $nn — invoke it as: /feature-plan $nn. The PRD at docs/slices/$nn-$slug/02-prd.md is approved; treat it as the contract." \
    "$TIMEOUT_PLAN"

  run_stage build  "$nn" "$slug" "$name" "$mode" \
    "Run the feature-build skill for slice $nn — invoke it as: /feature-build $nn. The plan at docs/slices/$nn-$slug/03-plan.md is approved; execute it test-first, task by task." \
    "$TIMEOUT_BUILD"

  suite_gate "$nn" "$slug" "$name" "$mode" post-build

  run_stage review "$nn" "$slug" "$name" "$mode" \
    "Run the feature-review skill for slice $nn — invoke it as: /feature-review $nn. You are the last gate before this merges." \
    "$TIMEOUT_REVIEW"

  suite_gate "$nn" "$slug" "$name" "$mode" post-review

  run_stage ship   "$nn" "$slug" "$name" "$mode" \
    "Run the feature-ship skill for slice $nn — invoke it as: /feature-ship $nn. Open the PR and stop; the orchestrator merges." \
    "$TIMEOUT_SHIP"

  if wait_for_ci_and_merge "$nn" "$slug" "$name" "$mode"; then
    mark_done "$nn" "merged"
    say "✓ SLICE $nn DONE — main is at $(git rev-parse --short HEAD)"
  else
    say "· slice $nn left at the PR gate"
    return 1
  fi
}

# ─── preflight ────────────────────────────────────────────────────────────────

for bin in claude gh git npm jq; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required tool: $bin"
done
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run: gh auth login"
git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository"

selected=()
for entry in "${SLICES[@]}"; do
  IFS='|' read -r nn slug name mode <<<"$entry"
  n=$((10#$nn))
  if [[ -n "$ONLY" ]]; then
    [[ " $ONLY " == *" $n "* ]] || continue
  else
    (( n >= FROM && n <= TO )) || continue
  fi
  selected+=("$entry")
done
[[ ${#selected[@]} -gt 0 ]] || die "no slices selected"

rule
say "Genesis autopilot · ${#selected[@]} slice(s) queued"
for entry in "${selected[@]}"; do
  IFS='|' read -r nn slug name mode <<<"$entry"
  status="pending"; is_done "$nn" merged && status="already merged"
  say "   $nn — $name ($mode) · $status"
done
say "state: ${STATE_DIR#$ROOT/}   logs: ${LOG_DIR#$ROOT/}"

if (( DRY_RUN )); then say "dry run — stopping here"; exit 0; fi

for entry in "${selected[@]}"; do
  IFS='|' read -r nn slug name mode <<<"$entry"
  if is_done "$nn" merged; then say "✓ slice $nn already merged — skipping"; continue; fi
  run_slice "$nn" "$slug" "$name" "$mode" || { rule; say "stopped after slice $nn"; exit 0; }
done

rule
say "All queued slices are merged. main: $(git rev-parse --short HEAD)"
