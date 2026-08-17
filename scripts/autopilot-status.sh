#!/usr/bin/env bash
#
# What autopilot has done, what it is doing, and what it cost.
#
# Reads the run's own artefacts — the state markers, the narrative log, and each
# stage's transcript — so it reports what happened rather than what was meant to.
# Safe to run at any time, including mid-stage; it never writes.
#
#   scripts/autopilot-status.sh          # full report
#   scripts/autopilot-status.sh --brief  # one line per slice
#
# Cost comes from the `result` event each session emits at its end, summed
# across every attempt. A stage still running has no such event yet and is
# reported by turns taken so far, with its cost landing when it stops.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.autopilot/logs"
STATE_DIR="$ROOT/.autopilot/state"
RUN_LOG="$ROOT/.autopilot/autopilot.log"

BRIEF=0
[[ "${1:-}" == "--brief" ]] && BRIEF=1

command -v jq >/dev/null 2>&1 || { echo "needs jq" >&2; exit 1; }
[[ -d "$LOG_DIR" ]] || { echo "no run yet — $LOG_DIR does not exist"; exit 0; }

# Slice display names, mirroring the runner's manifest. A case rather than an
# associative array: macOS ships bash 3.2, where `declare -A` silently becomes
# an indexed array and `[02b]` is then parsed as arithmetic.
slice_name() {
  case "$1" in
    02b) echo "API-only data access" ;;
    03) echo "Projects" ;;
    04) echo "Workspace shell & chat persistence" ;;
    05) echo "Streaming generation" ;;
    06) echo "File operations" ;;
    07) echo "Monaco editor" ;;
    08) echo "HighLevel API proxy" ;;
    09) echo "HighLevel knowledge injection" ;;
    10) echo "Live preview" ;;
    11) echo "Snapshots & restore" ;;
    12) echo "Error handling & state hardening" ;;
    13) echo "Deliverables" ;;
    *) echo "" ;;
  esac
}

STAGE_ORDER=(prd plan build fix-post-build review fix-post-review ship fix-ci)

# Exact-match the command line: a loose -f also matches any watcher shell whose
# own arguments mention the script, and then reports a finished run as running.
running_pid() { pgrep -xf 'bash scripts/autopilot.sh' 2>/dev/null | head -1; }

# Sum every session-end event in a transcript: a stage retried three times has
# three of them, and all three were paid for.
stage_cost() {
  jq -rs 'map(select(.type=="result")) | map(.total_cost_usd // 0) | add // 0' "$1" 2>/dev/null || echo 0
}
stage_sessions() { jq -rs 'map(select(.type=="result")) | length' "$1" 2>/dev/null || echo 0; }
stage_turns() { jq -rs 'map(select(.type=="assistant")) | length' "$1" 2>/dev/null || echo 0; }

# Wall-clock for a stage, from the narrative log's start and completion lines.
stage_minutes() {
  local nn="$1" stage="$2"
  awk -v nn="$nn" -v st="$stage" '
    function secs(t,  p) { split(t, p, ":"); return p[1]*3600 + p[2]*60 + p[3] }
    $0 ~ ("→ slice " nn " · " st " · attempt") { start = secs($1) }
    $0 ~ ("✓ slice " nn " · " st " complete") && start { d = secs($1) - start; if (d < 0) d += 86400; total += d; start = 0 }
    END { if (total) printf "%dm", int(total/60) }
  ' "$RUN_LOG" 2>/dev/null
}

printf '\n\033[1mGenesis autopilot\033[0m — %s\n' "$(date '+%Y-%m-%d %H:%M')"
pid="$(running_pid)"
if [[ -n "$pid" ]]; then
  printf '  running (pid %s) · %s\n' "$pid" "$(tail -1 "$RUN_LOG" 2>/dev/null | sed 's/^[0-9:]*  //')"
else
  printf '  \033[33mnot running\033[0m · last: %s\n' "$(tail -1 "$RUN_LOG" 2>/dev/null | sed 's/^[0-9:]*  //')"
fi
echo

grand=0
for dir in "$LOG_DIR"/*/; do
  nn="$(basename "$dir")"
  [[ -d "$dir" ]] || continue

  slice_total=0
  for f in "$dir"*.jsonl; do
    [[ -e "$f" ]] || continue
    slice_total=$(awk -v a="$slice_total" -v b="$(stage_cost "$f")" 'BEGIN{printf "%.2f", a+b}')
  done
  grand=$(awk -v a="$grand" -v b="$slice_total" 'BEGIN{printf "%.2f", a+b}')

  if [[ -f "$STATE_DIR/$nn.merged.done" ]]; then state=$'\033[32mMERGED\033[0m'
  elif [[ -f "$STATE_DIR/$nn.ship.done" ]]; then state=$'\033[36mshipped\033[0m'
  elif [[ -n "$pid" ]]; then state=$'\033[36min progress\033[0m'
  else state=$'\033[33mstopped\033[0m'; fi

  printf '\033[1mslice %-4s\033[0m %-38s %b  \033[1m$%s\033[0m\n' \
    "$nn" "$(slice_name "$nn")" "$state" "$slice_total"
  (( BRIEF )) && continue

  for stage in "${STAGE_ORDER[@]}"; do
    f="$dir$stage.1.jsonl"
    [[ -e "$f" ]] || continue
    cost="$(stage_cost "$f")"; sessions="$(stage_sessions "$f")"
    mins="$(stage_minutes "$nn" "$stage")"
    if [[ -f "$STATE_DIR/$nn.$stage.done" ]]; then mark=$'\033[32m✓\033[0m'
    elif [[ "$stage" == fix-* ]]; then mark=$'\033[32m✓\033[0m'
    elif [[ -n "$pid" ]]; then mark=$'\033[36m▸\033[0m'
    else mark=$'\033[31m✗\033[0m'; fi
    note=""
    (( sessions > 1 )) && note=" \033[33m($sessions attempts)\033[0m"
    [[ "$mark" == $'\033[36m▸\033[0m' ]] && note=" \033[36m($(stage_turns "$f") turns so far)\033[0m"
    printf '  %b %-16s %-6s $%-7s%b\n' "$mark" "$stage" "${mins:-—}" \
      "$(printf '%.2f' "$cost")" "$note"
  done
  echo
done

printf '\033[1mtotal spend: $%s\033[0m\n' "$grand"
merged=$(ls "$STATE_DIR" 2>/dev/null | grep -c '\.merged\.done$' || true)
printf 'slices merged by autopilot: %s · remaining in queue: %s\n\n' "$merged" "$(( 12 - merged ))"
