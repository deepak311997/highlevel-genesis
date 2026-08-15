#!/usr/bin/env bash
#
# Creates the GitHub repository for Genesis, pushes main, and opens one issue per
# slice from docs/IMPLEMENTATION_PLAN.md.
#
# Run this yourself — it creates a repository under your account.
#   gh auth login          # once, interactively
#   ./scripts/bootstrap-github.sh
#
# Override defaults with env vars:
#   REPO_NAME=my-genesis VISIBILITY=public ./scripts/bootstrap-github.sh

set -euo pipefail

REPO_NAME="${REPO_NAME:-highlevel-genesis}"
# The assignment requires a PUBLIC repository.
VISIBILITY="${VISIBILITY:-public}"    # public | private
DESCRIPTION="${DESCRIPTION:-Genesis — AI-powered HighLevel app builder}"

cd "$(dirname "$0")/.."

# --- preflight ---------------------------------------------------------------
command -v gh >/dev/null || { echo "gh is not installed: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not logged in. Run: gh auth login"; exit 1; }
[ -d .git ] || { echo "Not a git repository. Run: git init"; exit 1; }

ACCOUNT="$(gh api user --jq .login)"

cat <<EOF

About to create a GitHub repository:

  repo        ${ACCOUNT}/${REPO_NAME}
  visibility  ${VISIBILITY}
  remote      origin -> github.com/${ACCOUNT}/${REPO_NAME}
  then        push the current branch, and open 14 slice issues

EOF
read -r -p "Proceed? [y/N] " reply
[[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# --- commit anything outstanding ---------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "Add plan, conventions, and vertical-slice workflow skills"
fi

git branch -M main

# --- create and push ---------------------------------------------------------
gh repo create "${REPO_NAME}" \
  --"${VISIBILITY}" \
  --source=. \
  --remote=origin \
  --description "${DESCRIPTION}" \
  --push

# --- one issue per slice -----------------------------------------------------
# format: number|name|spec ids|depends on
SLICES=(
  "00|Rails|F9.4|—"
  "01|Account & session|F1.1|00"
  "02|HighLevel connection|F1.2, F1.3|01"
  "03|Projects|F2.1, F2.2, F2.3|01"
  "04|Workspace shell & chat persistence|F6.1, F6.2, F3.4|03"
  "05|Streaming generation|F3.1, F4.1, F4.2, F4.3|04"
  "06|File operations|F3.3, F5.1|05"
  "07|Monaco editor|F6.3|06"
  "08|HighLevel API proxy|F7.1, F7.2|02"
  "09|HighLevel knowledge injection|F3.2|08, 06"
  "10|Live preview|F6.4, F8.3|09"
  "11|Snapshots & restore|F5.2, F5.3, F6.6|06"
  "12|Error handling & state hardening|F8.1, F8.2, F8.3|10, 11"
  "13|Deliverables|F9.1-F9.5|12"
)

gh label create slice --color 1D76DB --description "A vertical slice" 2>/dev/null || true

echo
echo "Creating slice issues..."
for entry in "${SLICES[@]}"; do
  IFS='|' read -r num name spec deps <<< "$entry"
  gh issue create \
    --title "Slice ${num} — ${name}" \
    --label slice \
    --body "$(cat <<BODY
**Spec:** ${spec}
**Depends on:** ${deps}

Scope, demo line, tests, and risks: see \`docs/IMPLEMENTATION_PLAN.md\` §4.

### Workflow
- [ ] \`/feature-discovery ${num}\`
- [ ] \`/feature-prd ${num}\`
- [ ] \`/feature-plan ${num}\`
- [ ] \`/feature-build ${num}\`
- [ ] \`/feature-review ${num}\`
- [ ] \`/feature-ship ${num}\` → PR opened, awaiting human review

Docs land in \`docs/slices/${num}-<slug>/\`.
BODY
)" >/dev/null
  echo "  Slice ${num} — ${name}"
done

echo
echo "Done. https://github.com/${ACCOUNT}/${REPO_NAME}"
echo "Next: /feature-discovery 0"
