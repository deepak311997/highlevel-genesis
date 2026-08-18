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

# ─── configuration ────────────────────────────────────────────────────────────
#
# Everything the deploy needs beyond the key itself lives in Secret Manager, and
# nothing is held in GitHub. Three reasons, in order of how much they matter:
#
#  1. GitHub prints a step's whole `env:` block into the run log and masks a
#     secret but not a variable. This repository is public, so a variable there
#     was a published value.
#  2. One home instead of two. The functions already read their credentials from
#     Secret Manager; splitting the rest across repository variables meant the
#     answer to "what is this deployment configured with" was in two places.
#  3. The project id and the Firestore database id are in neither: they are read
#     from `.firebaserc` and `firebase.json`, which are committed. A copy in
#     GitHub would be a second source of truth for a value that has one.
#
# **The SPA's values are not secret and this does not pretend otherwise.** Vite
# compiles every one of them into the bundle, which is served to every visitor.
# What Secret Manager buys for them is a single home and a deploy log that does
# not republish them — not confidentiality, which is impossible for a value the
# browser must have.
say "5. configuration → Secret Manager"

value_of() { # file, key
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | head -1 | sed 's/[[:space:]]*$//'
}

# Piped, never passed as an argument: an argument is visible in `ps` for as long
# as the call takes.
put_secret() { # name, value
  local name="$1" value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "  $name — blank locally, skipped"
    return 0
  fi
  if $DRY_RUN; then
    printf '  would set %s (%d chars, from stdin)\n' "$name" "${#value}"
    return 0
  fi
  if gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT_ID" >/dev/null
    echo "  $name — new version"
  else
    printf '%s' "$value" | gcloud secrets create "$name" \
      --replication-policy=automatic --data-file=- --project "$PROJECT_ID" >/dev/null
    echo "  $name — created"
  fi
}

# The four that the `api` function declares with defineSecret. The credentials it
# also declares — HL_CLIENT_SECRET, OAUTH_STATE_SECRET, ANTHROPIC_API_KEY — are
# checked below rather than written, because this script never handles a value a
# human has not already put somewhere deliberate.
for key in HL_CLIENT_ID HL_VERSION_ID HL_REDIRECT_URI ALLOWED_ORIGINS; do
  put_secret "$key" "$(value_of functions/.env "$key")"
done

# The SPA build's whole .env, as one secret, because the deploy writes it back
# out as one file. Per-key secrets would be seven entries and seven chances for
# the workflow and this script to disagree about the list.
if [[ -f frontend/.env ]]; then
  # Only the keys the app reads. `firebase apps:sdkconfig WEB` prints two more —
  # storageBucket and messagingSenderId — and src/lib/firebase.ts stopped
  # carrying them, since nothing this app loads looks at either.
  FRONTEND_ENV="$(grep -E '^(VITE_FIREBASE_API_KEY|VITE_FIREBASE_AUTH_DOMAIN|VITE_FIREBASE_PROJECT_ID|VITE_FIREBASE_APP_ID|VITE_GOOGLE_RECAPTCHA_V3_KEY)=' frontend/.env || true)"
  FRONTEND_ENV+=$'\n# Blank: production is same-origin through the Hosting rewrite.\nVITE_FUNCTIONS_BASE_URL=\n'
  put_secret FRONTEND_ENV "$FRONTEND_ENV"
else
  echo "  FRONTEND_ENV — no frontend/.env here, skipped"
fi

# ─── GitHub cleanup ───────────────────────────────────────────────────────────
#
# Earlier versions of this script put all of the above in GitHub, as variables
# and then as secrets. Both are removed rather than left: a stale variable still
# resolves in a workflow expression, so one left behind is a value that keeps
# being published long after the workflow stopped reading it.
say "6. GitHub — only the key should remain"

for key in FIREBASE_PROJECT_ID FIRESTORE_DATABASE_ID VITE_FIREBASE_API_KEY \
           VITE_FIREBASE_AUTH_DOMAIN VITE_FIREBASE_PROJECT_ID VITE_FIREBASE_STORAGE_BUCKET \
           VITE_FIREBASE_MESSAGING_SENDER_ID VITE_FIREBASE_APP_ID \
           VITE_GOOGLE_RECAPTCHA_V3_KEY HL_CLIENT_ID HL_VERSION_ID \
           HL_REDIRECT_URI ALLOWED_ORIGINS; do
  if gh variable list --repo "$REPO" --json name -q '.[].name' | grep -qx "$key"; then
    echo "  deleting variable $key"
    run gh variable delete "$key" --repo "$REPO"
  fi
  if gh secret list --repo "$REPO" --json name -q '.[].name' | grep -qx "$key"; then
    echo "  deleting secret $key"
    run gh secret delete "$key" --repo "$REPO"
  fi
done
echo "  keeping FIREBASE_SERVICE_ACCOUNT"

# ─── Secret Manager ───────────────────────────────────────────────────────────
#
# Checked, not created. A `defineSecret` the project has no secret for fails the
# deploy — non-interactively, with a message about a missing secret rather than
# about the binding — and that is a five-second check here against a ten-minute
# failure in CI. Creating one would mean this script handling secret values,
# which it deliberately never does.
say "7. Secret Manager — the credentials"
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
