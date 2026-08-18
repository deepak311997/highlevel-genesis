<img src="brand/genesis-seed.svg" width="56" alt="">

# Genesis — AI-Powered HighLevel App Builder

Describe an app in chat; an LLM generates working code that calls **real HighLevel APIs**,
streamed token-by-token into an editor, with a live preview rendering real CRM data.

> **Status: twelve slices merged, one pull request each; this is the thirteenth.** Sign up
> and verify, connect a HighLevel sub-account over OAuth, create a project, prompt it, watch
> Claude stream files into Monaco, see the generated app render real contacts and
> appointments through the server-side proxy, edit a file, and restore any earlier version.
> The slice-by-slice record is [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md);
> what each one had to prove is [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md).

---

## Live URLs

|                             | URL                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Frontend (Firebase Hosting) | https://hl-genesis-app.web.app                                                                                         |
| Cloud Functions base        | https://asia-south1-hl-genesis-app.cloudfunctions.net/api                                                              |
| Health check                | https://hl-genesis-app.web.app/api/health                                                                              |
| Loom walkthrough            | _pending — see [`docs/slices/13-deliverables/release-checklist.md`](docs/slices/13-deliverables/release-checklist.md)_ |

Both origins are deployed continuously: `.github/workflows/deploy.yml` runs on every green CI
run against `main` and smoke-tests `/api/health` afterwards. In production the SPA and the API
are same-origin — Hosting rewrites `/api/**` and `/generate` to the two functions — so the
`cloudfunctions.net` base URL above is the same code reached directly.

Neither URL is hard-coded in this file's tests: `scripts/check-readme.mjs` derives them from
`.firebaserc`'s project id and the region pinned in `firebase.json`, so changing the project
fails the suite rather than leaving a stale link here.

---

## Local setup

Everything below runs against the Firebase emulators. **No Firebase project, no `.env`, and no
credentials are needed** — the emulator build's configuration lives in
`frontend/vite.config.ts` and the functions' fake HighLevel credentials in the committed
`functions/.env.local`.

**Prerequisites**

- Node.js 22 or newer
- **A Java runtime** — the Firestore emulator needs it. `brew install --cask temurin` (macOS)
  or any JDK 11+. Without it, `firebase emulators:start` fails on Firestore.

**Three commands**

```bash
git clone <this repo> && cd highlevel-genesis
npm run install:all      # root + frontend + functions
npm run dev              # emulators + Vite, one command
```

Then open **http://localhost:5173**. Sign up with any address: the Auth emulator issues the
verification link instead of sending mail, and serves it from its own endpoint —

```bash
curl http://localhost:9099/emulator/v1/projects/demo-genesis/oobCodes
```

Open the `oobLink` from the newest entry and the account is verified. Use `localhost`, not
`127.0.0.1`, for the app: the Vite dev server binds IPv6 by default.

`npm run dev` wraps `firebase emulators:exec` around the Vite server, so one Ctrl-C stops
both and the emulator data is exported to `.emulator-data` on the way out. To run the
emulators on their own — `firebase emulators:start` under the hood, with the functions built
first — use:

```bash
npm run emulators                        # auth + firestore + functions, project demo-genesis
npm --prefix frontend run dev:emulator   # in a second terminal, Vite wired to them
```

| Surface        | URL                                                |
| -------------- | -------------------------------------------------- |
| App (Vite dev) | http://localhost:5173                              |
| Functions      | http://localhost:5001/demo-genesis/asia-south1/api |
| Auth emulator  | http://localhost:9099                              |
| Emulator UI    | http://localhost:4000 — `npm run emulators` only   |

The Emulator UI is the one thing the two commands differ on: `emulators:start` serves it,
`emulators:exec` — which is what `npm run dev` wraps around Vite — does not. Everything the
UI would show is on the endpoints above, which is why the verification link is fetched from
`oobCodes` rather than clicked out of a console.

The emulators run under the throwaway project id `demo-genesis`, which keeps everything local
and offline. A real Firebase project is needed only to deploy.

**Running against real Firebase instead.** `npm run dev:cloud` points the SPA at whatever
project is configured beside `frontend/.env.example` (copy it, then fill it in). The emulator
wiring is selected by Vite **build mode**, not by a runtime flag, so a production bundle
cannot reach an emulator even if something asked it to — which is why these are two commands
rather than one with a switch.

**Tests**

```bash
npm run typecheck         # vue-tsc + tsc
npm run lint              # eslint, zero warnings tolerated
npm run test:unit         # Vitest — pure logic, Vue components, and the repo's own scripts
npm run test:rules        # Firestore security rules against the emulator
npm run test:integration  # Cloud Functions end to end against the emulators
npm run test:e2e          # Playwright — starts the emulators itself
npm run test:scripts      # just the checks under scripts/
npm test                  # typecheck + lint + unit + rules + integration
```

Every suite starts its own emulators and passes its own configuration inline, so all of them
run from a fresh clone with nothing configured. HighLevel and the LLM are always stubbed,
from `tests/fixtures/`.

---

## HighLevel setup

Only needed to run against a real sub-account; the emulator path fakes the whole OAuth loop.

1. **Developer account** — sign up at
   [marketplace.gohighlevel.com](https://marketplace.gohighlevel.com/), verify phone and email.
2. **Create the app** — My Apps → Create App:
   - **App Type:** Private (no marketplace review, no approval wait)
   - **Target User:** Sub-account — this returns a **Location token directly**, so the
     agency→location exchange never happens
   - **Who Can Install:** Both Agency & Sub-account
3. **Advanced Settings → Auth**
   - **Redirect URL**, byte-identical to the one the OAuth request sends. For this deployment
     that is **`https://hl-genesis-app.web.app/api/oauth/callback`**.
     HighLevel rejects a redirect URL containing the string `highlevel`, which is why the
     project id is `hl-genesis-app`; the project id is immutable, so pick a compliant one
     before creating the Firebase project.
   - **Scopes** — take all nine up front, because adding one later forces every existing
     install to re-authorize: `locations.readonly`, `contacts.readonly`, `contacts.write`,
     `conversations.readonly`, `conversations/message.readonly`,
     `conversations/message.write`, `calendars.readonly`, `calendars/events.readonly`,
     `calendars/events.write`. They are declared once, in
     [`functions/src/hl/config.ts`](functions/src/hl/config.ts).
   - **Secrets → Client Keys → Add** generates the Client ID and Client Secret.
     ⚠️ **The client secret is shown exactly once.** Put it straight into Secret Manager.
4. **Version id** — the v2 authorize endpoint needs `version_id`, which the portal only shows
   inside its own generated install link. Omit it and HighLevel answers with
   `No integration found with the id: <app id>` — which names the app id, so it reads like a
   bad client id and is not.
5. **Sandbox account** — Developer Portal → Testing → _Create App Test Account_. Provisioned
   instantly, valid for six months. This is the demo's data source; seed it below.

Full research notes — verified request shapes, API versions and the gotchas that cost time —
are in [`docs/HIGHLEVEL_PLATFORM.md`](docs/HIGHLEVEL_PLATFORM.md).

### HighLevel API allowlist

A generated app never holds a HighLevel credential. It calls `/api/hl/proxy/**`, and the proxy
attaches the token, injects the connection's `locationId` and forwards only these thirteen
routes. The table is **data** — [`functions/src/hl/routes.ts`](functions/src/hl/routes.ts) —
and the spec beside it fails `functions`' unit suite if this rendering drifts.

| Method | Path                                      | Version      | Scope                            | Notes                                                                                                                   |
| ------ | ----------------------------------------- | ------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/contacts/search`                        | `2021-07-28` | `contacts.readonly`              | List and search — `GET /contacts/` is deprecated upstream                                                               |
| `GET`  | `/contacts/:contactId`                    | `2021-07-28` | `contacts.readonly`              |                                                                                                                         |
| `POST` | `/contacts/`                              | `2021-07-28` | `contacts.write`                 |                                                                                                                         |
| `PUT`  | `/contacts/:contactId`                    | `2021-07-28` | `contacts.write`                 |                                                                                                                         |
| `GET`  | `/conversations/search`                   | `2021-04-15` | `conversations.readonly`         |                                                                                                                         |
| `GET`  | `/conversations/:conversationId`          | `2021-04-15` | `conversations.readonly`         |                                                                                                                         |
| `GET`  | `/conversations/:conversationId/messages` | `2021-04-15` | `conversations/message.readonly` |                                                                                                                         |
| `POST` | `/conversations/messages`                 | `2021-04-15` | `conversations/message.write`    | **Disabled by default** — sends a real SMS or email. Needs `HL_ALLOW_MESSAGE_SEND=true`, which is set in no environment |
| `GET`  | `/calendars/`                             | `2021-04-15` | `calendars.readonly`             |                                                                                                                         |
| `GET`  | `/calendars/:calendarId`                  | `2021-04-15` | `calendars.readonly`             |                                                                                                                         |
| `GET`  | `/calendars/events`                       | `2021-04-15` | `calendars/events.readonly`      | Query takes **epoch milliseconds** — ISO returns `200` with no events                                                   |
| `GET`  | `/calendars/events/appointments/:eventId` | `2021-04-15` | `calendars/events.readonly`      |                                                                                                                         |
| `GET`  | `/calendars/:calendarId/free-slots`       | `2021-04-15` | `calendars.readonly`             |                                                                                                                         |

Anything else answers `403 route_not_allowed`. The upstream URL is assembled by substituting
validated parameters into the matched row's own pattern, so no substring of a caller's raw
path can reach HighLevel.

### Seeding the sandbox

A fresh sandbox is empty, and the demo renders real records.
[`scripts/seed-sandbox.mjs`](scripts/seed-sandbox.mjs) creates 20 contacts and 8 appointments
over the next fortnight. It calls HighLevel directly — the proxy deliberately does not
allowlist appointment creation — and authenticates with a Private Integration Token or an
OAuth access token; the API is identical either way.

```bash
export HL_SEED_TOKEN=<private integration token>
export HL_SEED_LOCATION_ID=<sandbox location id>

node scripts/seed-sandbox.mjs --dry-run   # prints the plan, issues zero requests
node scripts/seed-sandbox.mjs             # for real
```

Create the calendar once in the sandbox UI first — `calendars.write` is a scope this app
deliberately does not request. The script picks the first calendar and its first team member
unless `--calendar-id` and `--assigned-user-id` say otherwise, and a re-run is safe: HighLevel
refuses a duplicate contact with the existing record's id, which the script counts as
`existing` and carries into the appointment step.

---

## Auth setup

Sign-up runs through a Cloud Function rather than the Firebase client SDK, so the response
cannot reveal whether an address is already registered. Everything else — sign-in,
verification email, password reset — is the client SDK, because Firebase already sends those
and does not disclose either.

**Needed to run locally:** nothing. The Auth emulator generates the verification links itself,
and the e2e suite reads them from `/emulator/v1/projects/demo-genesis/oobCodes`.

**Needed to deploy:** no mail provider and no secret. Firebase sends from
`noreply@<project>.firebaseapp.com`. Two console settings are worth making, neither of which
needs a domain: customise the action URL to `https://hl-genesis-app.web.app/auth/action` so
verification and reset links land on our own page, and set the sender name and subject.

Two settings no test can verify, because the emulator enforces neither: **email enumeration
protection** (sign-in and password reset go browser-to-Identity-Toolkit directly, so only this
closes them — currently enabled) and the **password policy** (passwords are set through
Identity Toolkit, so client-side validation alone is bypassable;
`functions/src/auth/schema.ts` and `frontend/src/lib/password.ts` mirror it).

---

## Architecture decisions

1. **`srcdoc` plus a runtime shim, not Sandpack.** The preview writes the generated app into a
   sandboxed iframe with an import shim and a `fetch` wrapper that routes HighLevel calls back
   through the proxy. Under a five-day clock that bought full control of the boundary; a real
   bundler runtime is the follow-up.
2. **Files are Firestore documents, not Cloud Storage objects.** They are small text blobs, and
   documents make snapshot-and-restore a copy on one batch rather than a bucket-manifest
   problem.
3. **The generated app never holds a credential — the proxy is the confused-deputy fix.** It
   calls `/api/hl/proxy/**`; the server attaches the HighLevel token and injects the
   connection's `locationId`. A token inside the iframe would be readable in page source, and
   the browser's own CORS would reject the call regardless.
4. **Token refresh happens inside a Firestore transaction.** HighLevel rotates the refresh
   token on use, so two concurrent requests refreshing the same connection would race one
   rotation and invalidate the other. The transaction re-reads and short-circuits.
5. **HighLevel API versions are date-pinned per route**, in the same table that authorises the
   route, because `2021-07-28` and `2021-04-15` disagree about response shapes. Migrating to
   their `v3` line is a known follow-up.
6. **Data access is API-only; Firestore rules are the deny-all backstop.** The SPA holds no
   Firestore handle at all — every read and write is a Cloud Function route that verifies the
   ID token, checks `email_verified`, parses with Zod and scopes the query by the uid inside
   the token. The rules deny every client outright, so a mistake in a route is a bug rather
   than a breach, and three checks (an ESLint rule, a source scan, and a scan of the built
   bundle) keep the SDK out.
7. **A `<genesis:file>` tag pair, not fenced code blocks.** File boundaries are emitted as the
   reply streams, so the editor can open a tab and fill it live; a fenced block only tells you
   where a file ended once it has. Zod validates the whole set after the stream closes, and
   nothing is written until it does.
8. **The HighLevel cheat-sheet sits behind a `cache_control` breakpoint.** It is byte-identical
   on every generation, so it should be a cache read rather than a re-send.
9. **Two functions, not one.** `generate` carries a long timeout and a warm instance for
   streaming; `api` stays small and fast. Merging them would make every CRUD request pay the
   streaming function's runtime profile.
10. **Vertical slices, one pull request each.** Every slice ships UI, API, data and tests
    together and is demoable when it merges — no branch accumulates a backend with no screen.

---

## What I would improve

1. **Iterative refinement and generation cancellation.** The two bonus items that most change
   how the product feels; both were scoped out to protect the core path.
2. **A real preview runtime** — Sandpack or WebContainers — so a generated app can use npm
   packages instead of what the shim provides.
3. **Per-user rate limiting and cost accounting on `generate`.** A loop in a generated app can
   run up an Anthropic bill with nothing in front of it.
4. **Migrate the HighLevel version pin from the date-based headers to `v3`**, which is where
   their documentation is moving.
5. **Recorded LLM fixtures for the whole golden path**, so the e2e suite could assert on
   generated output without spending tokens or depending on model nondeterminism.

---

## Deployment

Production deploys run from GitHub Actions —
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

**On every merge to `main`**, once CI has gone green on that exact commit. The deploy is
triggered by CI's completion rather than by the push, so it can read the SHA that was
verified: a `push` trigger would race CI and could put an untested commit in front of users. A
red CI means no deploy.

**On demand**, from the Actions tab or the CLI — for a redeploy, a configuration change that
needs no commit, or a way back after a bad one:

```bash
gh workflow run deploy.yml                                   # everything, from main
gh workflow run deploy.yml -f targets=hosting                # just the SPA
gh workflow run deploy.yml -f targets=functions -f ref=<sha> # roll back the API
```

Each run builds the SPA, re-runs the bundle's no-Firestore-SDK check, deploys functions,
Hosting and the Firestore rules and indexes, and then **smoke-tests the result**: it calls the
deployed `/api/health`, which writes a Firestore document, reads it back and deletes it. A 200
there proves the Hosting rewrite reaches the function, the function booted, its configuration
arrived, and the Admin SDK can reach the named database — four things a successful upload
proves nothing about.

### Configuration, and where each value lives

**GitHub holds exactly one secret**, the service account key. Everything else is either in
Secret Manager or already committed — GitHub prints a step's `env:` block into the run log and
masks a secret but not a variable, and this repository is public, so a repository variable was
a published value.

|                                   | Where it lives                     | Why                                                                                  |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `FIREBASE_SERVICE_ACCOUNT`        | GitHub secret                      | The one credential the workflow itself needs                                         |
| Project id, Firestore database id | `.firebaserc`, `firebase.json`     | Already committed; the workflow reads them rather than keeping a second copy         |
| `FRONTEND_ENV`                    | Secret Manager                     | The SPA's `.env`, fetched straight to disk at deploy time, never through a variable  |
| Seven function values             | Secret Manager, as `defineSecret`s | Attached to the Cloud Run revision as `secretKeyRef`s and resolved at instance start |

The seven are `ANTHROPIC_API_KEY`, `OAUTH_STATE_SECRET`, `HL_CLIENT_ID`, `HL_CLIENT_SECRET`,
`HL_VERSION_ID`, `HL_REDIRECT_URI` and `ALLOWED_ORIGINS`. The **only** plain environment
variable the deploy writes into the functions' `.env` is `FIRESTORE_DATABASE_ID`, which it
reads out of `firebase.json`. That split is not a convention anyone has to remember:
[`scripts/check-secrets.mjs`](scripts/check-secrets.mjs) fails the suite if a `defineSecret`
name is undocumented in [`.env.example`](.env.example) or if the workflow writes one into the
functions' `.env`.

To be clear about what Secret Manager does and does not buy here: the `VITE_*` values are
**not secret**. Vite compiles them into the bundle, which is served to every visitor. What
changes is that configuration has one home instead of two, and the deploy log is no longer one
of the places it appears.

### One-time setup

```bash
gcloud auth login          # as an owner of the Firebase project
scripts/setup-deploy.sh    # --dry-run first, if you like
```

That creates the `github-deployer` service account, grants it the roles a `firebase deploy`
actually needs — enumerated in the script, each with the failure it prevents, never
`roles/owner` — puts a key in the `FIREBASE_SERVICE_ACCOUNT` repository secret, and pushes
every configured value into Secret Manager. It is idempotent; re-run it whenever a value
changes.

### Notes

- Deploying by hand still works — `npm run build` then `npx firebase deploy` — and is the
  right move when you are debugging the deploy itself rather than shipping.
- After the first deploy, register the deployed callback URL on the HighLevel marketplace app.
  It must match the OAuth request exactly.
- Hosting rewrites `/api/**` → `api` and `/generate` → `generate`, so the SPA and the API are
  same-origin in production and CORS never enters the picture.
- CI runs typecheck, lint and all five test levels on every pull request and on `main`.
- What is left in human hands after this branch merges — registering the redirect URI, seeding
  the sandbox for real, recording the Loom — is listed with its procedure in
  [`docs/slices/13-deliverables/release-checklist.md`](docs/slices/13-deliverables/release-checklist.md).

---

## Repository layout

```
frontend/           Vue 3 + TypeScript + Vite + Tailwind + shadcn-vue
  src/views/          screens — auth, dashboard, workspace
  src/components/     workspace panels, editor, preview, snapshots
  src/stores/         Pinia — session, projects, files, generation
  src/lib/            API client, validation, formatting
functions/          Firebase Cloud Functions (TypeScript)
  src/api/            express app — health, OAuth callback, HighLevel proxy
  src/auth/           server-side registration
  src/hl/             OAuth, token store, the allowlist and the proxy
  src/llm/            Claude client, prompt assembly, stream parsing
  src/projects/       projects, files, messages, snapshots
  src/generate.ts     SSE streaming endpoint
tests/rules/        Firestore security rules tests (L3)
tests/integration/  Cloud Functions against the emulators (L4)
tests/e2e/          Playwright end-to-end walks (L5)
tests/fixtures/     recorded HighLevel and LLM responses — never live calls
scripts/            repo checks and operator scripts, each with a spec beside it
brand/              logo and identity assets
docs/               PRODUCT_SPEC · HIGHLEVEL_PLATFORM · IMPLEMENTATION_PLAN
docs/slices/        per-slice PRD, plan, build log and review
firebase.json       hosting, functions, firestore, emulators
firestore.rules     security rules — deny by default, for every client
.env.example        every environment variable in the project, documented
```

Working conventions live in [`CLAUDE.md`](CLAUDE.md); the slice-by-slice plan lives in
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).
