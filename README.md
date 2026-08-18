<img src="frontend/public/genesis-mark.svg" width="56" alt="">

# Genesis — AI-Powered HighLevel App Builder

Describe an app in chat; an LLM generates working code that calls **real HighLevel APIs**,
streamed token-by-token into an editor, with a live preview rendering real CRM data.

Vue 3 · TypeScript · Vite · Tailwind · Pinia · Firebase (Auth, Firestore, Functions v2,
Hosting) · Monaco · Claude via `@anthropic-ai/sdk`, always streaming.

Sign up and verify, connect a HighLevel sub-account over OAuth, create a project, prompt it,
watch Claude stream files into the editor, see the generated app render real contacts and
appointments through the server-side proxy, edit a file, restore an earlier version. Built as
fourteen vertical slices, one pull request each — the record is
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md), the spec is
[`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md).

---

## Live URLs

| | |
| --- | --- |
| Frontend | https://hl-genesis-app.web.app |
| Cloud Functions base | https://asia-south1-hl-genesis-app.cloudfunctions.net/api |
| Generation endpoint | https://generate-aitsgtnk5a-el.a.run.app |
| Health check | https://hl-genesis-app.web.app/api/health |

Deployed on every green CI run against `main`.

`/api/**` reaches the `api` function through a Hosting rewrite, so those calls are
same-origin. `/generate` deliberately does not: Hosting's CDN buffers a response to completion
and drops the origin at 60 seconds, so a two-minute generation came back as a `502` and
nothing ever streamed. It calls the function's own URL instead. Decision 9 has the numbers.

---

## Local setup

Runs entirely on the Firebase emulators. No Firebase project, no `.env` and no credentials
are needed.

**Prerequisites:** Node.js 22+, and a JDK 21+ for the Firestore emulator
(`brew install --cask temurin`). No global `firebase` install — `firebase-tools` is a
devDependency.

```bash
npm run install:all      # root + frontend + functions
npm run dev              # emulators + Vite, one command
```

Then open **http://localhost:5173**.

`npm run dev` calls the real model, so it needs an Anthropic key in `functions/.secret.local`
(gitignored, created from its example on every run):

```
ANTHROPIC_API_KEY=sk-ant-…
```

No key, or offline? `npm run dev:stub` is the same loop against the fixture LLM.

Sign up with any address. The Auth emulator issues the verification link instead of mailing
it — open the `oobLink` from the newest entry:

```bash
curl http://localhost:9099/emulator/v1/projects/demo-genesis/oobCodes
```

To run the emulators on their own (`firebase emulators:start` under the hood, functions built
first) use `npm run emulators`, then `npm --prefix frontend run dev:emulator` in a second
terminal. `npm run dev:cloud` points the SPA at real Firebase instead; copy
`frontend/.env.example` first.

**Tests**

```bash
npm run typecheck         # vue-tsc + tsc
npm run lint              # eslint, zero warnings tolerated
npm run test:unit         # Vitest — logic, Vue components, the repo's own scripts
npm run test:rules        # Firestore security rules
npm run test:integration  # Cloud Functions against the emulators
npm run test:e2e          # Playwright
npm test                  # typecheck + lint + unit + rules + integration
```

The last four start their own emulators, so they run from a fresh clone with nothing
configured. HighLevel and the LLM are always stubbed, from `tests/fixtures/`.

---

## HighLevel setup

Only needed to run against a real sub-account — the emulator path fakes the whole OAuth loop.

1. **Developer account** at [marketplace.gohighlevel.com](https://marketplace.gohighlevel.com/).
2. **Create the app** — My Apps → Create App. Type **Private** (no review queue), Target User
   **Sub-account**, which returns a Location token directly so the agency→location exchange
   never happens.
3. **Advanced Settings → Auth**
   - **Redirect URL**, byte-identical to the one the OAuth request sends:
     `https://hl-genesis-app.web.app/api/oauth/callback`. HighLevel rejects a redirect URL
     containing the string `highlevel`, which is why the project id is `hl-genesis-app` — and
     a project id is immutable, so choose a compliant one before creating the project.
   - **Scopes** — take all nine up front; adding one later forces every existing install to
     re-authorize. They are declared in
     [`functions/src/hl/config.ts`](functions/src/hl/config.ts).
   - **Client secret is shown exactly once.** Put it straight into Secret Manager.
4. **Version id** — the v2 authorize endpoint needs `version_id`, and the portal only shows it
   inside its own generated install link. Omit it and HighLevel answers `No integration found
   with the id: <app id>`, which names the app id and so reads like a bad client id.
5. **Sandbox account** — Developer Portal → Testing → *Create App Test Account*. Instant,
   valid for six months. Seed it, after creating one calendar in its UI
   (`calendars.write` is a scope this app deliberately does not request):

   ```bash
   export HL_SEED_TOKEN=<private integration token>
   export HL_SEED_LOCATION_ID=<sandbox location id>

   node scripts/seed-sandbox.mjs --dry-run   # prints the plan, issues zero requests
   node scripts/seed-sandbox.mjs
   ```

### HighLevel API allowlist

A generated app never holds a HighLevel credential. It calls `/api/hl/proxy/**` with one of
these stable Genesis CRM routes, and the proxy attaches the token, injects the connection's
`locationId` and maps only these thirteen routes to HighLevel on the server. The table is
**data** — [`functions/src/hl/routes.ts`](functions/src/hl/routes.ts) — and the spec beside it
fails `functions`' unit suite if this rendering drifts.

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
validated parameters into the matched row's own `upstreamPattern`, so a HighLevel endpoint
upgrade changes the backend map rather than generated apps, and no substring of a caller's raw
path can reach HighLevel.

Verified request shapes, API versions and the gotchas that cost time are in
[`docs/HIGHLEVEL_PLATFORM.md`](docs/HIGHLEVEL_PLATFORM.md).

---

## Architecture decisions

1. **Email verification is a gate on every request, not a prompt at signup.** Registration is
   a server route that creates the account unverified, and every authenticated route re-reads
   `email_verified` out of the decoded ID token.
2. **Data access is API-only; Firestore rules are the deny-all backstop.** The SPA holds no
   Firestore handle — every read and write is a Cloud Function route that verifies the ID
   token, parses with Zod and scopes the query by the uid *inside the token*, never by a path
   segment. A mistake in a route is then a bug rather than a breach.
3. **OAuth runs inside a Cloud Function, on an encrypted `state` that expires in five minutes.**
   AES-256-GCM over the uid and an expiry — encrypted rather than signed, because this value
   travels through another company's logs and the browser's history. Binding the uid into it
   is the CSRF defence. The browser never sees a client id, a secret or a token.
4. **HighLevel tokens are parsed on arrival and sealed at rest.** A discriminated union on
   `userType` means a `Company` token is never mistaken for a location-scoped one; both tokens
   are then AES-256-GCM-sealed under their own secret, so a leaked Firestore read is no longer
   a live token. Refresh runs in a transaction, because HighLevel rotates the refresh token on
   use and two concurrent requests would race one rotation.
5. **The generated app never holds a credential — the proxy is the confused-deputy fix.** It
   calls `/api/hl/proxy/**`; the server attaches the token and injects the connection's
   `locationId`, so the app needs nothing but the signed-in user's session.
6. **That proxy is a stable API surface, not a passthrough.** Generated apps call thirteen
   fixed Genesis routes; the upstream URL and the date-pinned API version live in a table on
   the server, so when HighLevel moves an endpoint the map changes and apps generated months
   ago keep working. Anything off the table answers `403 route_not_allowed`.
7. **A `<genesis:file>` tag pair, not fenced code blocks — and four edit verbs beside it.**
   Tags let the editor open a tab and fill it live, where a fenced block only tells you where a
   file ended once it has. `append`, `after`, `before` and `edit` resolve to a line range on the
   server, so a follow-up prompt patches a file instead of re-emitting it: about 400 output
   tokens where a rewrite costs 3,500.
8. **The HighLevel cheat-sheet sits behind a `cache_control` breakpoint.** It is the largest
   byte-stable part of the prompt, so it is a cache read at a tenth of the input price — and it
   comes off the time to first token, which is what the user watches.
9. **Two functions, not one — and the streaming one bypasses Hosting.** `generate` gets 540
    seconds and 512 MiB; `api` stays at 60 seconds and 256 MiB. Hosting's CDN buffers a
    response to completion and drops the origin at 60 seconds, which turned every long
    generation into a `502` and meant nothing had ever really streamed — 11.8s to first byte
    through it against 0.35s direct.

---

## What I would improve

1. **A structural pass over the code.** Shipping one vertical slice at a time kept every merge
   demoable but left the seams uneven; route wiring, the HighLevel client and the frontend
   stores each want a deliberate refactor.
2. **Usage and billing.** Tokens consumed per generation, a cost per app, a running total on
   the dashboard — and a per-user rate limit in front of `generate`, which today has nothing
   between it and the model.
3. **Export the generated app back into HighLevel.** These belong as a custom menu view inside
   the sub-account's own CRM, so an agency builds a view here and then uses it where it works.

---

## Deployment

Production deploys run from GitHub Actions —
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

**On every merge to `main`**, once CI is green on that exact commit. The deploy is triggered
by CI's completion rather than by the push, so it deploys the SHA that was verified. A red CI
means no deploy.

**On demand**, for a redeploy, a config change that needs no commit, or a way back:

```bash
gh workflow run deploy.yml                                   # everything, from main
gh workflow run deploy.yml -f targets=hosting                # just the SPA
gh workflow run deploy.yml -f targets=functions -f ref=<sha> # roll back the API
```

A run builds the SPA, deploys functions, Hosting and the Firestore rules and indexes, then
smoke-tests the deployed `/api/health` — which writes a document, reads it back and deletes
it, proving the function booted and its configuration arrived.

**Configuration.** GitHub holds exactly one secret, the service account key; a repository
variable would be printed into the run log, and this repo is public. Everything else is in
Secret Manager — `FRONTEND_ENV` (the SPA's `.env`, fetched straight to disk at build time) and
eight `defineSecret` values — or already committed, in `.firebaserc` and `firebase.json`. The
`VITE_*` values are not secret; Vite compiles them into the bundle. Secret Manager just keeps
configuration in one place and out of the deploy log.
[`scripts/check-secrets.mjs`](scripts/check-secrets.mjs) fails the suite if a `defineSecret`
is undocumented in [`.env.example`](.env.example) or written into the functions' `.env`.

`HL_TOKEN_SECRET` is the key the stored HighLevel tokens are sealed under, and the deploy
fails without it — `firebase functions:secrets:set HL_TOKEN_SECRET`. Firestore's own
encryption at rest protects the disks; this protects against anything holding a Firestore
*read*, which is the more likely way a token leaks.

`FRONTEND_ENV` must carry `VITE_GENERATE_URL`, and the deploy stops if it does not: blank, the
SPA sends the streaming turn back through the Hosting rewrite, which ships looking correct and
fails only on generations past a minute. After editing the file:

```bash
gcloud secrets versions add FRONTEND_ENV --data-file=frontend/.env
```

**One-time setup.** [`scripts/setup-deploy.sh`](scripts/setup-deploy.sh) creates the
`github-deployer` service account, grants only the roles a `firebase deploy` needs, puts a key
in the `FIREBASE_SERVICE_ACCOUNT` repository secret and pushes every configured value into
Secret Manager. Idempotent — re-run it whenever a value changes.

```bash
gcloud auth login          # as an owner of the Firebase project
scripts/setup-deploy.sh    # --dry-run first, if you like
```

**Manual steps.** Register the deployed callback URL on the HighLevel marketplace app after
the first deploy; it must match the OAuth request exactly. Deploying by hand still works —
`npm run build`, then `npx firebase deploy` — and is the right move when debugging the deploy
itself. Hosting's `/generate` rewrite stays in `firebase.json` so a browser holding a stale
bundle keeps working rather than 404ing.

---

## Repository layout

```
frontend/     Vue 3 SPA — views, workspace panels, Pinia stores, router, API client
functions/    Cloud Functions — auth, HighLevel OAuth and proxy, projects, files,
              messages, snapshots, the LLM client, and generate.ts (the SSE endpoint)
tests/        rules (L3), integration (L4), e2e (L5), and recorded fixtures
scripts/      repo checks and operator scripts — every .mjs one with a spec beside it
docs/         PRODUCT_SPEC · HIGHLEVEL_PLATFORM · IMPLEMENTATION_PLAN · docs/slices/
```

Unit tests (L1, L2) sit beside the code they cover, as `*.spec.ts`.
