<img src="brand/genesis-seed.svg" width="56" alt="">

# Genesis — AI-Powered HighLevel App Builder

Describe an app in chat; an LLM generates working code that calls **real HighLevel APIs**,
streamed token-by-token into an editor, with a live preview rendering real CRM data.

> **Status: Slice 1 (Account & session) in review.** Sign up, verify by email, sign in, sign
> out, with a blocking verification gate and a non-disclosing registration flow. Slice 0's
> `/health` page still proves the full path — browser → Cloud Function → Firestore → back.
> Feature slices land one pull request at a time; see
> [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

---

## Live URLs

|                             | URL                           |
| --------------------------- | ----------------------------- |
| Frontend (Firebase Hosting) | _not deployed yet — Slice 13_ |
| Cloud Functions base        | _not deployed yet — Slice 13_ |
| Loom walkthrough            | _not recorded yet — Slice 13_ |

---

## Local setup

**Prerequisites**

- Node.js 22 or newer
- **A Java runtime** — the Firestore emulator needs it. `brew install --cask temurin`
  (macOS) or any JDK 11+. Without it, `firebase emulators:start` fails on Firestore.

**Run it**

```bash
cp frontend/.env.example  frontend/.env    # then fill in the values
cp functions/.env.example functions/.env   # see .env.example at the root for the map
npm run install:all                        # root + frontend + functions

npm run dev                                # Vite, against REAL Firebase
```

Then open **http://localhost:5173/health**. A green round trip means every layer is wired.

**Two ways to run, and they are genuinely different.** `npm run dev` points the app at your
real Firebase project, so development exercises the same path production does — there is no
emulator in that loop. The emulators exist for the test suites and for offline work:

```bash
npm run emulators        # auth + firestore + functions, under the throwaway id demo-genesis
npm run dev:emulator     # in a second terminal — Vite wired to those emulators
```

The emulator wiring is selected by Vite **build mode**, not by a runtime flag, so a
production bundle cannot reach an emulator even if something asked it to. That is also why
`npm run dev` and `npm run dev:emulator` are separate commands rather than one with a
switch.

| Surface                | URL                                                |
| ---------------------- | -------------------------------------------------- |
| App (Vite dev)         | http://localhost:5173                              |
| Emulator UI            | http://localhost:4000                              |
| Functions              | http://localhost:5001/<project-id>/asia-south1/api |
| Hosting (built assets) | http://localhost:5050                              |

Use `localhost`, not `127.0.0.1`, for the Vite dev server — it binds to IPv6 by default.

The Hosting emulator runs on **5050** rather than Firebase's default 5000, because macOS
Control Center holds port 5000 for AirPlay Receiver and the whole emulator suite refuses to
start when Hosting cannot bind.

The emulators run under the project id `demo-genesis`, which keeps everything local and
offline. You only need a real Firebase project to deploy.

**Tests**

```bash
npm run typecheck      # vue-tsc + tsc
npm run lint           # eslint, zero warnings tolerated
npm run test:unit         # Vitest — pure logic + Vue components
npm run test:rules        # Firestore security rules against the emulator
npm run test:integration  # Cloud Functions end to end against the emulators
npm run test:e2e          # Playwright — starts the emulators itself
npm test                  # typecheck + lint + unit + rules + integration
```

`test:integration` and `test:e2e` wrap themselves in `firebase emulators:exec` and pass their
own configuration inline, so both run from a fresh clone with no `.env` and no credentials.
The e2e suite builds the frontend with `--mode emulator`; every other mode targets real
Firebase, and that choice is made at build time so a production bundle cannot reach an
emulator.

### Testing the verification gate

`emailVerified` cannot be toggled from the Firebase console, so there is a script:

```bash
node scripts/set-verified.mjs alice@example.test false          # emulator
node scripts/set-verified.mjs alice@example.test false --live   # real project
```

It defaults to the emulator and needs `--live` to touch the real project, which also
requires `gcloud auth application-default login`.

Un-verifying revokes the user's refresh tokens, and it has to: `email_verified` travels
_inside_ the ID token and Firestore rules read it from there, so a browser already holding
a token would keep the old claim for up to an hour and the app would not notice. **Sign out
and back in** to land on the gate.

---

## HighLevel setup

1. **Developer account** — sign up at
   [marketplace.gohighlevel.com](https://marketplace.gohighlevel.com/), verify phone and email.
2. **Create the app** — My Apps → Create App:
   - **App Type:** Private (no marketplace review, no approval wait)
   - **Target User:** Sub-account — this returns a **Location token directly**, so the
     agency→location exchange never happens
   - **Who Can Install:** Both Agency & Sub-account
3. **Advanced Settings → Auth**
   - **Redirect URL** must be HTTPS in production and match the OAuth request byte for byte:
     `https://<your-project>.web.app/api/oauth/callback`
   - **Scopes** — pick the full list up front. Adding one later forces every existing install
     to re-authorize.
   - **Secrets → Client Keys → Add** generates the Client ID and Client Secret.
     ⚠️ **The client secret is shown exactly once.** Copy it straight into `.env`.
4. **Sandbox account** — Developer Portal → Testing → _Create App Test Account_. Provisioned
   instantly, Enterprise features enabled, valid for six months. This is the demo data source;
   seed it with `scripts/seed-sandbox.ts`.

Full research notes, including API versions and known gotchas, are in
[`docs/HIGHLEVEL_PLATFORM.md`](docs/HIGHLEVEL_PLATFORM.md).

---

## Auth setup

Sign-up runs through a Cloud Function rather than the Firebase client SDK, so the response
cannot reveal whether an address is already registered. Everything else — sign-in,
verification email, password reset — is the client SDK, because Firebase already sends
those and does not disclose either.

**Needed to run locally:** nothing. The Auth emulator generates the verification codes and
the e2e suite reads them from `/emulator/v1/projects/demo-genesis/oobCodes`.

**Needed to deploy:** no mail provider and no secret. Firebase sends from
`noreply@<project>.firebaseapp.com`. Two console settings are worth making, neither of
which needs a domain:

| Console setting                                                                                      | Why                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication → Templates → **customise the action URL** to `https://<project>.web.app/auth/action` | Sends verification and reset links to our own branded page instead of Firebase's. Without it the flow still works, on Firebase's hosted page. |
| Authentication → Templates → sender name and subject                                                 | Otherwise the emails read as generic Firebase notices.                                                                                        |

**Console settings that no test can verify.** The emulator enforces neither, so a green
suite says nothing about either one:

| Setting                      | Why                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email enumeration protection | Sign-in and password reset go browser-to-Identity-Toolkit directly and we never see them. Our endpoint closes sign-up; only this closes those. **Currently enabled.**                                         |
| Password policy              | Passwords are set through Identity Toolkit, so client-side validation alone is bypassable. `functions/src/auth/schema.ts` and `frontend/src/lib/password.ts` mirror it; change one and all three must change. |

**Two limits worth stating plainly:**

- The registration endpoint returns a byte-identical response either way, but the branches
  do measurably different work, so response _timing_ can still distinguish them. Rate
  limiting raises the cost of exploiting that; it does not remove it.
- Registration deliberately sends no email. Someone who registers an address that already
  exists gets no nudge saying so — they meet a sign-in failure with a forgot-password link
  instead. That is the price of the endpoint being unusable to mail a stranger.

---

## Architecture decisions

1. **Firestore security rules are the API for reads.** The SPA subscribes to Firestore
   directly; Cloud Functions exist only where a rule cannot express the logic. Fewer endpoints,
   less latency, and realtime updates for free.
2. **Two functions, not one.** `generate` carries a long timeout and a warm instance for
   streaming; `api` stays small and fast for CRUD. Merging them would make every CRUD request
   pay the streaming function's runtime profile.
3. **The generated app never holds a credential.** It calls a proxy that attaches the HighLevel
   token server-side. A token in the sandboxed iframe would be readable in page source — and
   CORS would reject the call regardless.
4. **OAuth tokens live in a collection with no client read rule at all.** Not owner-scoped —
   unreachable. Only the Admin SDK inside a function can touch them.
5. **SSE over `fetch()`, not `EventSource`.** `EventSource` cannot send an `Authorization`
   header, so it cannot carry a Firebase ID token. The stream is read off the `fetch` body.
6. **Files are Firestore documents, not Cloud Storage objects.** They are small text blobs, and
   documents make snapshot-and-restore a copy rather than a bucket-manifest problem.
7. **Fenced code blocks with path headers, not structured outputs.** Structured output would
   guarantee valid JSON, but streaming JSON into a live editor renders as noise. Blocks let file
   boundaries be emitted as they arrive; Zod validates after the stream closes.
8. **Nothing is written until the whole generation validates.** Tokens render live for feel, but
   a malformed response cannot leave a project half-written.
9. **The HighLevel cheat-sheet sits behind a prompt-cache breakpoint.** It is identical on every
   generation, so it should be a cache read rather than a re-send.
10. **Account creation is server-side, and the response never varies.** The client SDK reports
    `EMAIL_EXISTS` on the wire, so no amount of careful error copy hides whether an address is
    registered — an attacker reads the network response, not the form. Moving creation behind
    the Admin SDK is the only thing that actually closes it.
11. **`email_verified` is enforced in Firestore rules, not just the router.** A route guard
    stops a browser; it does not stop anyone holding a valid token. This is what makes an
    account registered at someone else's address able to reach nothing.
12. **Vertical slices, each its own pull request.** Every slice ships UI, API, data, and tests
    together and is demoable when it merges — no branch accumulates a backend with no screen.

---

## What I would improve

1. **Generation cancellation and iterative refinement** — the two bonus items that most change
   how the product feels; both were scoped out to protect the core path.
2. **A real preview runtime.** `srcdoc` plus a shim is the right call under a five-day clock, but
   Sandpack or WebContainers would let generated apps use npm packages.
3. **Push token refresh out of the request path.** Refreshing inline on a 401 adds latency to the
   unlucky request; a scheduled refresh ahead of expiry would not.
4. **Recorded LLM fixtures for the whole golden path**, so the end-to-end suite could assert on
   generated output without spending tokens or depending on model nondeterminism.
5. **Per-user rate limiting and cost accounting on `generate`.** Right now a loop in a generated
   app could run up a bill with nothing to stop it.
6. **Breached-password screening on sign-up.** A Have I Been Pwned k-anonymity lookup is the
   single highest-value addition to a length-only password policy, and the password never
   leaves the browser to do it.

---

## Deployment

Production deploys run from GitHub Actions — [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

**On every merge to `main`**, once CI has gone green on that exact commit. The deploy is
triggered by CI's completion rather than by the push, so it can read the SHA that was
verified: a `push` trigger would race CI and could put an untested commit in front of users.
A red CI means no deploy.

**On demand**, from the Actions tab or the CLI — for a redeploy, a configuration change that
needs no commit, or a way back after a bad one:

```bash
gh workflow run deploy.yml                                   # everything, from main
gh workflow run deploy.yml -f targets=hosting                # just the SPA
gh workflow run deploy.yml -f targets=functions -f ref=<sha> # roll back the API
```

Each run builds the SPA, re-runs the bundle's no-Firestore-SDK check, deploys functions,
Hosting and Firestore rules and indexes, and then **smoke-tests the result**: it calls the
deployed `/api/health`, which writes a Firestore document, reads it back and deletes it. A
200 there proves the Hosting rewrite reaches the function, the function booted, its
configuration arrived, and the Admin SDK can reach the named database — four things a
successful upload proves nothing about.

### One-time setup

```bash
gcloud auth login          # as an owner of the Firebase project
scripts/setup-deploy.sh    # --dry-run first, if you like
```

That creates the `github-deployer` service account, grants it the roles a
`firebase deploy` actually needs (enumerated in the script, each with the failure it
prevents — never `roles/owner`), puts a key in the `FIREBASE_SERVICE_ACCOUNT` repository
secret, and pushes every configured value into Secret Manager. It is idempotent; re-run it
whenever a value changes.

**GitHub holds one secret and nothing else** — the service account key. Everything else is
either in Secret Manager or already committed:

|                                   | Where it lives                     | Why                                                                                                                                                                                          |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIREBASE_SERVICE_ACCOUNT`        | GitHub secret                      | The one credential the workflow itself needs.                                                                                                                                                |
| Project id, Firestore database id | `.firebaserc`, `firebase.json`     | Already committed. A copy in GitHub would be a second source of truth for a value that has one — and `functions/.env.example` says outright that the database id must match `firebase.json`. |
| `FRONTEND_ENV`                    | Secret Manager                     | The SPA's `.env`, fetched straight to disk at deploy time.                                                                                                                                   |
| The six function values           | Secret Manager, as `defineSecret`s | Attached to the Cloud Run revision as `secretKeyRef`s and resolved when the instance starts.                                                                                                 |

The reason is that GitHub prints a step's whole `env:` block into the run log and masks a
secret but not a variable — and **this repository is public**, so a repository variable was a
published value. Moving configuration to Secret Manager removes the step that published it
rather than masking its output.

To be clear about what that does and does not buy: the `VITE_*` values are **not secret**.
Vite compiles all of them into the bundle, which is served to every visitor, so anyone can
read them from the browser — that is how Firebase web config is designed to work, and access
is controlled by Auth, the Firestore rules that deny every client outright, and App Check.
What changes is that configuration has one home instead of two, and the deploy log is no
longer one of the places it appears.

The three credentials — `ANTHROPIC_API_KEY`, `HL_CLIENT_SECRET`, `OAUTH_STATE_SECRET` — are
`defineSecret`s bound to the functions that read them, so they live in **Secret Manager** and
the workflow never handles their values. It needs permission to _bind_ them, not to read
them, which is why the only repository secret is the service account key:

```bash
npx firebase functions:secrets:set ANTHROPIC_API_KEY   # bound to `generate`
npx firebase functions:secrets:set HL_CLIENT_SECRET    # bound to `api`
npx firebase functions:secrets:set OAUTH_STATE_SECRET  # bound to `api`
```

### Notes

- Deploying by hand still works — `npm run build && npx firebase deploy` — and is the right
  move when you are debugging the deploy itself rather than shipping.
- After the first deploy, register the deployed callback URL
  (`https://<project>.web.app/api/oauth/callback`) on the HighLevel marketplace app. It must
  match the OAuth request exactly.
- Hosting rewrites `/api/**` → `api` and `/generate` → `generate`, so the SPA and the API are
  same-origin in production and CORS never enters the picture.
- CI runs typecheck, lint and all five test levels on every pull request and on `main`.

---

## Repository layout

```
frontend/           Vue 3 + TypeScript + Vite + Tailwind + shadcn-vue
functions/          Firebase Cloud Functions (TypeScript)
  src/api/            express app — health, OAuth callback, HighLevel proxy
  src/generate.ts     SSE streaming endpoint
tests/rules/        Firestore security rules tests
tests/e2e/          Playwright end-to-end tests
brand/              logo and identity assets
docs/               PRODUCT_SPEC · HIGHLEVEL_PLATFORM · IMPLEMENTATION_PLAN
docs/slices/        per-slice discovery, PRD, plan, review
firebase.json       hosting, functions, firestore, emulators
firestore.rules     security rules — deny by default
.env.example        every environment variable, documented
```

Working conventions live in [`CLAUDE.md`](CLAUDE.md); the slice-by-slice plan lives in
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).
