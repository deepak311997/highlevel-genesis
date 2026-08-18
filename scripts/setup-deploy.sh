#!/usr/bin/env bash
#
# One-time setup for .github/workflows/deploy.yml.
#
# Creates the deploy service account, grants it the narrowest set of roles that
# actually completes a `firebase deploy`, mints a key into the repository's
# FIREBASE_SERVICE_ACCOUNT secret, and copies the non-secret configuration out of
# your local .env files into repository variables.
#
# Idempotent: every step checks before it creates, so re-running it after adding
# a variable is the normal way to use it, not a special case.
#
#   scripts/setup-deploy.sh              # do it
#   scripts/setup-deploy.sh --dry-run    # print what it would do
#   scripts/setup-deploy.sh --no-key     # skip the key; refresh variables only
#
# Prerequisites, both of which it checks for:
#
#   gcloud auth login                    # as an owner of the Firebase project
#   gh auth status                       # with write access to the repository
#
# It never prints a secret value. What it echoes is names.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".firebaserc")).projects.default)')"
SA_NAME="github-deployer"
SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

DRY_RUN=false
WITH_KEY=true
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-key) WITH_KEY=false ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
run() {
  if $DRY_RUN; then printf '  would run: %s\n' "$*"; else "$@"; fi
}

# ─── roles ────────────────────────────────────────────────────────────────────
#
# Deliberately enumerated rather than `roles/owner`. Each line says what breaks
# without it, because the failure modes are not guessable from the role names —
# a missing serviceAccountUser, for instance, fails at the very end of a
# ten-minute deploy with a message about `actAs` that names no role at all.
ROLES=(
  roles/firebase.admin                    # Hosting releases, Firestore rules and indexes
  roles/cloudfunctions.admin              # create and update the functions themselves
  roles/run.admin                         # v2 functions ARE Cloud Run services
  roles/artifactregistry.admin            # the build pushes a container image
  roles/cloudbuild.builds.editor          # ...and Cloud Build is what builds it
  roles/iam.serviceAccountUser            # actAs the functions' runtime service account
  roles/secretmanager.admin               # bind ANTHROPIC_API_KEY, HL_CLIENT_SECRET, OAUTH_STATE_SECRET
  roles/cloudscheduler.admin              # the onSchedule sweep needs a Scheduler job
  roles/serviceusage.serviceUsageConsumer # quota project for every API call above
  roles/eventarc.admin                    # v2 triggers are wired through Eventarc
)

# ─── preflight ────────────────────────────────────────────────────────────────
for bin in gcloud gh node; do
  command -v "$bin" >/dev/null || { echo "missing $bin" >&2; exit 1; }
done

ACTIVE="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
[[ -n "$ACTIVE" ]] || { echo "gcloud is not logged in. Run: gcloud auth login" >&2; exit 1; }
say "gcloud account: $ACTIVE"
say "project:        $PROJECT_ID"

gh auth status >/dev/null 2>&1 || { echo "gh is not logged in. Run: gh auth login" >&2; exit 1; }
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
say "repository:     $REPO"
echo

# ─── the service account ──────────────────────────────────────────────────────
say "1. service account"
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "  $SA_EMAIL exists"
else
  run gcloud iam service-accounts create "$SA_NAME" \
    --project "$PROJECT_ID" \
    --display-name "GitHub Actions deployer" \
    --description "Used by .github/workflows/deploy.yml. Created by scripts/setup-deploy.sh."
  echo "  created $SA_EMAIL"
fi

say "2. roles"
for role in "${ROLES[@]}"; do
  echo "  $role"
  # `--condition=None` because without it gcloud prompts, and this runs in CI-ish
  # contexts where a prompt is a hang. Output suppressed: a successful binding
  # prints the project's entire IAM policy.
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:$SA_EMAIL" \
    --role "$role" \
    --condition=None \
    --quiet >/dev/null
done

# ─── the key ──────────────────────────────────────────────────────────────────
if $WITH_KEY; then
  say "3. key → FIREBASE_SERVICE_ACCOUNT"
  if $DRY_RUN; then
    echo "  would mint a key and pipe it to gh secret set"
  else
    # A file, because `gcloud iam service-accounts keys create` writes to one and
    # will not write to stdout. Deleted on any exit, including a failure — a
    # service account key left in a working tree is the exact accident this whole
    # pipeline exists to avoid.
    KEY_FILE="$(mktemp -t genesis-deploy-key)"
    trap 'rm -f "$KEY_FILE"' EXIT

    gcloud iam service-accounts keys create "$KEY_FILE" \
      --iam-account "$SA_EMAIL" \
      --project "$PROJECT_ID" \
      --quiet
    gh secret set FIREBASE_SERVICE_ACCOUNT --repo "$REPO" < "$KEY_FILE"
    rm -f "$KEY_FILE"
    trap - EXIT
    echo "  set (the key file was deleted)"
  fi
else
  say "3. key — skipped (--no-key)"
fi

# ─── variables ────────────────────────────────────────────────────────────────
#
# Read out of the local .env files rather than asked for, so the deployed
# configuration is the one that was verified by hand locally. Nothing secret is
# read: the two values that were once in functions/.env are `defineSecret`s now
# and live in Secret Manager, which the deploy binds but never reads.
say "4. repository variables"

value_of() { # file, key
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | head -1 | sed 's/[[:space:]]*$//'
}

set_var() { # name, value
  local name="$1" value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "  $name — blank locally, skipped"
    return 0
  fi
  echo "  $name"
  run gh variable set "$name" --repo "$REPO" --body "$value"
}

set_var FIREBASE_PROJECT_ID "$PROJECT_ID"

for key in VITE_FIREBASE_API_KEY VITE_FIREBASE_AUTH_DOMAIN VITE_FIREBASE_PROJECT_ID \
           VITE_FIREBASE_STORAGE_BUCKET VITE_FIREBASE_MESSAGING_SENDER_ID \
           VITE_FIREBASE_APP_ID VITE_GOOGLE_RECAPTCHA_V3_KEY; do
  set_var "$key" "$(value_of frontend/.env "$key")"
done

for key in FIRESTORE_DATABASE_ID HL_CLIENT_ID HL_VERSION_ID HL_REDIRECT_URI ALLOWED_ORIGINS; do
  set_var "$key" "$(value_of functions/.env "$key")"
done

# ─── Secret Manager ───────────────────────────────────────────────────────────
#
# Checked, not created. A `defineSecret` the project has no secret for fails the
# deploy — non-interactively, with a message about a missing secret rather than
# about the binding — and that is a five-second check here against a ten-minute
# failure in CI. Creating one would mean this script handling secret values,
# which it deliberately never does.
say "5. Secret Manager"
MISSING=()
for secret in ANTHROPIC_API_KEY HL_CLIENT_SECRET OAUTH_STATE_SECRET; do
  if gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "  $secret exists"
  else
    echo "  $secret MISSING"
    MISSING+=("$secret")
  fi
done

echo
if (( ${#MISSING[@]} > 0 )); then
  say "Set these before the first deploy — each prompts for the value:"
  for secret in "${MISSING[@]}"; do
    echo "  npx firebase functions:secrets:set $secret --project $PROJECT_ID"
  done
  echo
fi

say "Done. Trigger a deploy with:"
echo "  gh workflow run deploy.yml --repo $REPO"
