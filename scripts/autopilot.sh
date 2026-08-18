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

# A sleeping Mac kills a streaming session mid-response, and the CLI reports it
# as "your computer went to sleep mid-response" hours into a stage. Three review
# attempts on slice 02b died that way — this machine has `pmset sleep 1`. Re-exec
# under caffeinate so the run holds the machine awake for exactly as long as it
# is running, and releases it the moment it exits.
if [[ "$(uname)" == "Darwin" && -z "${AUTOPILOT_CAFFEINATED:-}" ]] && command -v caffeinate >/dev/null 2>&1; then
  export AUTOPILOT_CAFFEINATED=1
  exec caffeinate -ims "$0" "$@"
fi

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
: "${AUTOPILOT_LIMIT_WAIT:=900}"      # seconds to sleep before re-checking a usage limit
: "${AUTOPILOT_LIMIT_MAX_WAITS:=24}"  # give up after this many (default: 6 hours)

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
  "02b|api-data-access|API-only data access|full"
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

FROM=0
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

**Data access is API-only, decided 2026-08-17 and binding on every slice from 2b on.**
The frontend never uses the Firestore client SDK — no \`getDoc\`, no \`setDoc\`, no
\`onSnapshot\`, no imports from \`firebase/firestore\` outside the emulator wiring. Every
read and write goes through a Cloud Function route that verifies the ID token (including
\`email_verified\`), parses the payload with Zod, and scopes the query by the uid **from the
token, never from the request body**. Security rules stay and deny clients outright; each
collection's L3 tests prove that denial. Liveness is a refetch after a mutation, or an SSE
stream where one already exists.

**No user identifier appears in a route** — not \`:uid\`, not \`me\`. The uid comes from the
verified token and nowhere else, so a path segment naming the user is redundant at best and
a second, forgeable source of identity at worst. Routes name the resource only:
\`/api/profile\`, \`/api/projects\`, \`/api/projects/:projectId/files\`. A resource id in a path
is fine — it gets an ownership check, and is never trusted for identity.

If a slice's own PRD or plan contradicts this — including one written before the decision —
this rule wins, and you note the contradiction in the slice's docs rather than following
the stale document.
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

The build session fans its tasks out across concurrent subagent lanes, and it can only do
that safely where the plan pinned the boundaries. So make the task list legible as lanes:
give every task the explicit list of files it creates or modifies, and pin the interface
wherever two tasks meet — the exported signature, the route shape, the event name, the
schema. Close the plan with a short **Lanes** section naming which task groups touch
disjoint file sets and can run at once, and which must stay a chain and why. Where you
have a choice, prefer a file split that keeps lanes disjoint over one that forces two
tasks onto the same file.
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

**The last thing you do, once every task is done and the full suite is green, is append
the line \`<!-- build-complete -->\` to 04-build-log.md on its own line.** Write it at no
other point. The orchestrator treats it as the only evidence this stage finished, because
the log itself grows from task one and a session that dies at task sixteen leaves a log
that looks exactly like a finished one. If you stop early for any reason, leave it out —
an unfinished build that says so is resumable; one that claims completion is not.

### Parallelism — fan out where the plan lets you

The task list is ordered, but it is rarely a single chain. Before writing anything, read the
file map and the task list together and work out which tasks touch disjoint sets of files.
Those are independent lanes, and you should run them concurrently with the Agent tool rather
than one after another. Dispatch every lane you can justify in a single message so they run
at once; token cost is not a constraint on this run, so the only reasons to keep a task for
yourself are dependency and contention, never expense.

Five rules make that safe. They are not optional:

- **You own git. A subagent never runs it.** No commit, no branch, no checkout, no stash
  inside a lane. Lanes write tests and implementation; you commit. Concurrent writers on one
  index corrupt it, and a lane that commits its own half-finished idea is unreviewable.
- **A lane owns its files exclusively.** Hand each subagent the explicit list of paths it may
  create or modify, and tell it plainly that anything outside that list is out of bounds — if
  it needs a change there, it reports the need rather than making it. Two lanes sharing one
  file is not a lane split; it is a conflict you have chosen in advance.
- **Test-first survives the split.** Each lane works its own tasks in red-green order and
  reports, per task, the failing test it wrote and the change that made it pass. You commit
  per task, in plan order, with those messages — so the history still reads as one disciplined
  build rather than a heap of parallel drops.
- **Contracts come from the plan, never from a sibling.** Lanes cannot see each other's work.
  Where two lanes meet at an interface, that interface is whatever the plan pinned. If the
  plan did not pin it, keep that task for yourself instead of letting two lanes guess at it.
- **A chain stays a chain.** Anything genuinely sequential — one module refined across several
  tasks, a task whose test needs the previous task's code, a task the plan flags as a hazard —
  stays with you. Splitting a chain to look parallel buys rework, not speed.

Run the suite yourself after each lane lands, not only at the end. A lane that goes red is
cheapest to fix while you still know which lane it was.

Your wall clock is the longest single lane, so balance them by weight rather than by count:
one lane holding three heavy tasks while four lanes hold one trivial task each is barely
faster than working in order. Split the heavy lane if its tasks permit it; if they do not,
start it first so the light lanes finish underneath it.

If the plan has no independent lanes worth the coordination, say so in the build log and work
the tasks in order. Sequential is a legitimate conclusion of this analysis, not a failure of it.
EOF
      ;;
    review)
      cat <<EOF

### This stage: review

You are reviewing code you cannot remember writing, which is the right frame — treat it
as another author's PR. Read the diff against main in full.

There is no human reviewer after you. You are the last gate before this merges, so the
findings you skip are findings nobody makes. Fix what you find, test-first where the fix
is behavioural. Step 9's dead-code question has no one to answer it: decide it yourself
and record the call in 05-review.md.

**Do not re-run the full suite to establish the baseline.** The orchestrator ran all six
suites on this exact commit minutes ago and gated on the result — that is why this stage
started at all. The output is in .autopilot/logs/$nn/, in the gate-post-build log with the
highest attempt number. Read it, and take the counts for the review's suite table from it.
A full run costs twenty minutes and answers a question already answered; the sessions that
did it anyway are the ones that ran out of time before writing a review.

### Parallelism — one reviewer per axis, then you judge

Read the diff yourself first, in full, so you have your own picture before anyone else's. Then
dispatch the axes concurrently with the Agent tool, in a single message: correctness, security,
architecture, performance, readability, and one agent whose only job is to audit the PRD's
acceptance criteria against the tests that claim to cover them. Give each the same diff range
and its axis alone — an agent asked for everything returns the obvious.

You are the judge, not a collator:

- **A reported finding is a claim, not a fact.** Verify each one against the actual code before
  it reaches 05-review.md. Agents reviewing in isolation produce plausible findings about code
  that does not do what they assumed — the ones you cannot reproduce get dropped, and dropping
  them is the work, not a shortfall of it.
- **You write every fix.** Lanes report; they do not edit. Fixes are yours, test-first where the
  fix is behavioural, so the failing test still precedes the change.
- **Severity is yours too.** An axis agent has no view of the slice's PRD decisions and will rank
  a deliberate trade-off as a defect. Check each finding against the PRD's decisions table before
  you call it Required.

The two findings this stage exists to catch are the ones that cost money or corrupt state while
every test passes. Weight the correctness and security lanes accordingly, and give the AC-audit
lane the explicit instruction to open the tests it is checking rather than trusting the matrix.

Run only the specific tests your own fixes touch. The orchestrator re-runs everything
after you stop, so a fix that breaks something else is caught regardless.

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

Then stop, with the PR URL in your final message. The orchestrator merges. Do not merge
it yourself, and do not start the next slice.
EOF
      ;;
  esac
}

# ─── running a stage ──────────────────────────────────────────────────────────

run_claude() {
  local stage="$1" nn="$2" slug="$3" name="$4" mode="$5" prompt="$6" timeout="$7" attempt="$8"
  local dir="$LOG_DIR/$nn"; mkdir -p "$dir"
  local raw="$dir/$stage.$attempt.jsonl" err="$dir/$stage.$attempt.err"
  LAST_RAW="$raw"   # read by the usage-limit check in run_stage

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
    # The build log is written incrementally on purpose — that is what makes it a
    # handoff a fresh session can resume from — so its existence can never mean
    # "finished". Slice 06 proved it: a session killed at task 16 of 24 left a
    # branch, a long build log and nineteen commits, passed all three of those
    # tests, and minted a build.done marker over a tree whose tests did not
    # compile. Every re-run then skipped the build and looped on the same red
    # gate. The sentinel is the session's own terminal statement, written last.
    build)  git rev-parse --verify "slice/$nn-$slug" >/dev/null 2>&1 \
              && [[ -s "$d/04-build-log.md" ]] \
              && grep -q '<!-- build-complete -->' "$d/04-build-log.md" \
              && [[ $(git rev-list --count "main..slice/$nn-$slug" 2>/dev/null || echo 0) -gt 0 ]] ;;
    review) [[ -s "$d/05-review.md" ]] ;;
    ship)   gh pr view "slice/$nn-$slug" --json url -q .url >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# A session that ends on the account's usage limit did no work and tells us
# nothing about the stage. Retrying it immediately just spends the remaining
# attempts at four seconds each — which is exactly how slice 05 died with its
# three PRD attempts inside four seconds. Waiting is the only useful response.
# Text-matched rather than parsed with jq: the CLI interleaves the odd non-JSON
# line into the stream (MCP capability notices, for one), and a `jq -rs` over the
# whole file fails on those — silently returning nothing, which would read as
# "no limit hit" exactly when the limit was hit. The last `result` field in the
# file is the session's own verdict.
hit_usage_limit() {
  [[ -f "${1:-}" ]] || return 1
  grep -o '"result":"[^"]*"' "$1" 2>/dev/null | tail -1 \
    | grep -qiE "hit your (session|usage) limit|usage limit reached|limit . resets"
}

# An expired or invalid token is the same kind of event as a usage limit — a
# session that never ran and tells us nothing about the stage — with one
# difference that matters: it does not heal on its own. Waiting is wasted and
# retrying spends the remaining attempts in seconds. Slice 06 died this way: the
# build was cut off at task 16 of 24, and the three fix sessions that were meant
# to repair the red suite each exited in three seconds on the same 401, so the
# run ended blaming the suite for a failure that was entirely about credentials.
hit_auth_failure() {
  [[ -f "${1:-}" ]] || return 1
  grep -o '"result":"[^"]*"' "$1" 2>/dev/null | tail -1 \
    | grep -qiE "OAuth access token is invalid|Failed to authenticate|API Error: 401"
}

run_stage() {
  local stage="$1" nn="$2" slug="$3" name="$4" mode="$5" prompt="$6" timeout="$7"

  if is_done "$nn" "$stage"; then say "✓ slice $nn · $stage already done — skipping"; return 0; fi

  local attempt=1 waits=0
  while (( attempt <= AUTOPILOT_STAGE_RETRIES + 1 )); do
    local p="$prompt"
    if (( attempt > 1 )); then
      p="$prompt

A previous attempt at this stage did not finish — its expected output is missing or
incomplete. **Do not read its transcript.** Those .jsonl files run to hundreds of
kilobytes and reading one costs more context than redoing the work.

Read the repository instead: \`git status\`, \`git log --oneline main..HEAD\`, and this
slice's docs show exactly how far it got — including any half-finished cycle left in the
working tree, such as a failing test written without its implementation. Continue from
there, or undo it deliberately and say why."
    fi
    run_claude "$stage" "$nn" "$slug" "$name" "$mode" "$p" "$timeout" "$attempt"

    # Checked before the artefact test, not after: a stage whose artefact grows
    # incrementally can look complete when the session died halfway through it.
    if hit_auth_failure "$LAST_RAW"; then
      die "slice $nn: authentication failed at the '$stage' stage — the session never ran.
Re-authenticate, then re-run; state is preserved in .autopilot/. Check the branch
for a half-finished cycle (a failing test with no implementation) before resuming."
    fi

    if stage_artefacts_ok "$stage" "$nn" "$slug"; then
      mark_done "$nn" "$stage"; say "✓ slice $nn · $stage complete"; return 0
    fi

    # Not a failed attempt — a session that never got to run. Wait it out and
    # try again on the same attempt number, so the limit cannot exhaust the
    # retries that exist for real failures.
    if hit_usage_limit "$LAST_RAW"; then
      (( waits++ ))
      if (( waits > AUTOPILOT_LIMIT_MAX_WAITS )); then
        die "slice $nn: usage limit still in force after $waits waits (~$(( waits * AUTOPILOT_LIMIT_WAIT / 3600 ))h) at stage '$stage'"
      fi
      say "· usage limit reached — waiting ${AUTOPILOT_LIMIT_WAIT}s, then retrying $stage (wait $waits/$AUTOPILOT_LIMIT_MAX_WAITS, attempt $attempt unchanged)"
      sleep "$AUTOPILOT_LIMIT_WAIT"
      continue
    fi

    say "✗ slice $nn · $stage produced no usable output on attempt $attempt"
    (( attempt++ ))
  done
  die "slice $nn stalled at stage '$stage' after $((AUTOPILOT_STAGE_RETRIES + 1)) attempts. Logs: ${LOG_DIR#$ROOT/}/$nn/"
}

# ─── the suite gate ───────────────────────────────────────────────────────────
# The orchestrator runs the suite itself. A model reporting green is a claim; this
# is the evidence. Red suite → fresh fix session pointed at the actual output.

# The suite binds fixed ports: scripts/test-emulator-config.mjs derives them from
# firebase.json by a fixed +100, and package.json names the results (8180, 5101,
# 5273, 9199, hub 4700, logging 4800). Every checkout on this machine therefore
# computes the *same* set, so two autopilot runs in two clones share one set of
# sockets however isolated their git state is. Making the offset configurable
# would work, but it means editing the harness every slice's gate depends on.
# A gate is two minutes of a ninety-minute slice, so letting the runs queue is
# both cheaper and safer.
#
# mkdir is the atomic primitive — macOS has no flock. The holder's pid goes
# inside so a run killed mid-gate is reclaimed rather than deadlocking its
# sibling forever, which this run has already seen happen from another cause.
GATE_LOCK="${AUTOPILOT_GATE_LOCK:-/tmp/genesis-suite-gate.lock}"

gate_lock_acquire() {
  local waited=0 holder
  until mkdir "$GATE_LOCK" 2>/dev/null; do
    holder="$(cat "$GATE_LOCK/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      say "· gate lock held by dead pid $holder — reclaiming"
      rm -rf "$GATE_LOCK"; continue
    fi
    (( waited % 60 == 0 )) && say "· waiting for the suite gate (held by pid ${holder:-unknown})"
    sleep 10; waited=$(( waited + 10 ))
  done
  echo $$ >"$GATE_LOCK/pid"
}

gate_lock_release() { [[ -f "$GATE_LOCK/pid" ]] && [[ "$(cat "$GATE_LOCK/pid")" == "$$" ]] && rm -rf "$GATE_LOCK"; return 0; }

trap gate_lock_release EXIT

suite_gate() {
  local nn="$1" slug="$2" name="$3" mode="$4" phase="$5"
  (( SKIP_LOCAL_GATE )) && { say "· local suite gate skipped by flag"; return 0; }

  local attempt=1
  while (( attempt <= AUTOPILOT_FIX_ATTEMPTS + 1 )); do
    local out="$LOG_DIR/$nn/gate-$phase.$attempt.log"
    say "· suite gate ($phase, attempt $attempt) — typecheck · lint · unit · rules · integration · e2e"
    gate_lock_acquire
    if { npm run typecheck && npm run lint && npm run test:unit \
         && npm run test:rules && npm run test:integration && npm run test:e2e; } \
         >"$out" 2>&1; then
      gate_lock_release
      say "✓ suite green"; return 0
    fi
    # A red gate hands the ports back too — the fix session that follows is pure
    # model time and must not block the sibling run from gating behind it.
    gate_lock_release
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
  # This slice's own docs are written on main and only committed once the build
  # stage cuts the branch, so a resumed run legitimately finds them untracked
  # here. Anything else dirty is a surprise this script should not guess about.
  local dirty
  dirty="$(git status --porcelain | grep -v "^?? docs/slices/$nn-$slug/" || true)"
  [[ -z "$dirty" ]] || die "working tree is dirty on main — resolve it, then re-run (state is preserved in .autopilot/):
$dirty"
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
  # Slice ids are not all numeric — 02b is an architecture change inserted
  # between two merged slices. Strip the suffix for range comparisons only.
  n=$((10#${nn//[!0-9]/}))
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
