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
  roles/billing.viewer                    # read the plan; firebase-tools checks it before deploying
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

# ─── APIs ─────────────────────────────────────────────────────────────────────
#
# Enabled here rather than left to the deploy, because the deploy's version of
# this failure is bad: `firebase deploy` reports a permission error naming the
# caller, not a disabled API, so it reads as "the service account is wrong" and
# sends you to re-grant roles that were never the problem.
#
# `secretmanager` is the one that was actually off on this project — which meant
# no secret existed, and so the deployed `generate` held no model key. Nothing
# surfaced that: a function with an unresolvable secret deploys perfectly well
# and answers 500 on the first real request.
say "1. APIs"
APIS=(
  # Checked by firebase-tools before it will deploy a v2 function, because those
  # require the Blaze plan. The check itself needs this API, so with it disabled
  # the deploy dies on `Cloud Billing API has not been used in project …` after
  # it has already uploaded rules and indexes — a half-applied deploy, and a
  # message about billing when nothing is wrong with the billing account.
  cloudbilling.googleapis.com     # the plan check that gates every function deploy
  secretmanager.googleapis.com    # the three defineSecrets
  cloudfunctions.googleapis.com   # the functions
  run.googleapis.com              # ...which are Cloud Run services
  cloudbuild.googleapis.com       # ...built by Cloud Build
  artifactregistry.googleapis.com # ...into an image
  eventarc.googleapis.com         # v2 triggers
  cloudscheduler.googleapis.com   # the onSchedule sweep
  firebasehosting.googleapis.com  # the SPA
  firebaserules.googleapis.com    # Firestore rules
  firestore.googleapis.com        # the database itself
  iamcredentials.googleapis.com   # the service account signing its own tokens
)

ENABLED="$(gcloud services list --enabled --project "$PROJECT_ID" --format='value(config.name)')"
for api in "${APIS[@]}"; do
  if grep -qx "$api" <<<"$ENABLED"; then
    echo "  $api"
  else
    echo "  $api — enabling"
    run gcloud services enable "$api" --project "$PROJECT_ID" --quiet
  fi
done

# ─── the service account ──────────────────────────────────────────────────────
say "2. service account"
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "  $SA_EMAIL exists"
else
  run gcloud iam service-accounts create "$SA_NAME" \
    --project "$PROJECT_ID" \
    --display-name "GitHub Actions deployer" \
    --description "Used by .github/workflows/deploy.yml. Created by scripts/setup-deploy.sh."
  echo "  created $SA_EMAIL"
fi

say "3. roles"
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
  say "4. key → FIREBASE_SERVICE_ACCOUNT"
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
  say "4. key — skipped (--no-key)"
fi

# ─── variables ────────────────────────────────────────────────────────────────
#
# Read out of the local .env files rather than asked for, so the deployed
# configuration is the one that was verified by hand locally. Nothing secret is
# read: the two values that were once in functions/.env are `defineSecret`s now
# and live in Secret Manager, which the deploy binds but never reads.
say "5. repository variables"

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
  echo "  $name (variable)"
  run gh variable set "$name" --repo "$REPO" --body "$value"
}

# The same thing, as a masked secret.
#
# GitHub prints a step's whole `env:` block into the run log and masks a secret
# but not a variable. This repository is public, so a variable there is a
# published value — which is fine for anything the bundle or the repository
# already publishes, and not fine for the HighLevel app's identifiers.
#
# Piped rather than passed as an argument: an argument is visible in `ps` for as
# long as the call takes.
set_secret() { # name, value
  local name="$1" value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "  $name — blank locally, skipped"
    return 0
  fi
  echo "  $name (secret, masked in logs)"
  if $DRY_RUN; then
    printf '  would run: gh secret set %s --repo %s (value from stdin)\n' "$name" "$REPO"
  else
    printf '%s' "$value" | gh secret set "$name" --repo "$REPO"
  fi
}

set_var FIREBASE_PROJECT_ID "$PROJECT_ID"

for key in VITE_FIREBASE_API_KEY VITE_FIREBASE_AUTH_DOMAIN VITE_FIREBASE_PROJECT_ID \
           VITE_FIREBASE_STORAGE_BUCKET VITE_FIREBASE_MESSAGING_SENDER_ID \
           VITE_FIREBASE_APP_ID VITE_GOOGLE_RECAPTCHA_V3_KEY; do
  set_var "$key" "$(value_of frontend/.env "$key")"
done

# Already in the committed firebase.json, so masking it would be theatre.
set_var FIRESTORE_DATABASE_ID "$(value_of functions/.env FIRESTORE_DATABASE_ID)"

# Not published anywhere else, and this repository is public.
for key in HL_CLIENT_ID HL_VERSION_ID HL_REDIRECT_URI ALLOWED_ORIGINS; do
  set_secret "$key" "$(value_of functions/.env "$key")"
done

# Left behind by an earlier run of this script, when these were variables. A
# variable and a secret of the same name can coexist, and the variable is the one
# that ends up in the log — so the cleanup is the point, not tidiness.
for key in HL_CLIENT_ID HL_VERSION_ID HL_REDIRECT_URI ALLOWED_ORIGINS; do
  if gh variable list --repo "$REPO" --json name -q '.[].name' | grep -qx "$key"; then
    echo "  $key — deleting the stale variable"
    run gh variable delete "$key" --repo "$REPO"
  fi
done

# ─── Secret Manager ───────────────────────────────────────────────────────────
#
# Checked, not created. A `defineSecret` the project has no secret for fails the
# deploy — non-interactively, with a message about a missing secret rather than
# about the binding — and that is a five-second check here against a ten-minute
# failure in CI. Creating one would mean this script handling secret values,
# which it deliberately never does.
say "6. Secret Manager"
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
