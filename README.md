<img src="brand/genesis-seed.svg" width="56" alt="">

# Genesis — AI-Powered HighLevel App Builder

Describe an app in chat; an LLM generates working code that calls **real HighLevel APIs**,
streamed token-by-token into an editor, with a live preview rendering real CRM data.

> **Status: Slice 0 (Rails) complete.** The scaffold, test harness, and CI are in place, and a
> `/health` page proves the full path — browser → Cloud Function → Firestore → back. Feature
> slices land one pull request at a time; see [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

---

## Live URLs

| | URL |
|---|---|
| Frontend (Firebase Hosting) | _not deployed yet — Slice 13_ |
| Cloud Functions base | _not deployed yet — Slice 13_ |
| Loom walkthrough | _not recorded yet — Slice 13_ |

---

## Local setup

**Prerequisites**

- Node.js 22 or newer
- **A Java runtime** — the Firestore emulator needs it. `brew install --cask temurin`
  (macOS) or any JDK 11+. Without it, `firebase emulators:start` fails on Firestore.

**Run it**

```bash
cp .env.example .env          # then fill in the values
npm run install:all           # root + frontend + functions

npm run dev                   # emulators + Vite dev server together
```

Then open **http://localhost:5173/health**. A green round trip means every layer is wired.

| Surface | URL |
|---|---|
| App (Vite dev) | http://localhost:5173 |
| Emulator UI | http://localhost:4000 |
| Functions | http://localhost:5001/<project-id>/asia-south1/api |
| Hosting (built assets) | http://localhost:5050 |

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
npm run test:unit      # Vitest — pure logic + Vue components
npm run test:rules     # Firestore security rules against the emulator
npm run test:e2e       # Playwright (needs `npm run dev` running)
npm test               # typecheck + lint + unit + rules
```

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
4. **Sandbox account** — Developer Portal → Testing → *Create App Test Account*. Provisioned
   instantly, Enterprise features enabled, valid for six months. This is the demo data source;
   seed it with `scripts/seed-sandbox.ts`.

Full research notes, including API versions and known gotchas, are in
[`docs/HIGHLEVEL_PLATFORM.md`](docs/HIGHLEVEL_PLATFORM.md).

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
10. **Vertical slices, each its own pull request.** Every slice ships UI, API, data, and tests
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

---

## Deployment notes

```bash
firebase use --add                      # point .firebaserc at a real project

firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set HL_CLIENT_ID
firebase functions:secrets:set HL_CLIENT_SECRET

npm run build
firebase deploy                         # hosting + functions + firestore rules
```

- Secrets go through **Secret Manager**, never `.env`, and never the repo.
- After the first deploy, register the deployed callback URL
  (`https://<project>.web.app/api/oauth/callback`) on the HighLevel marketplace app. It must
  match the OAuth request exactly.
- Hosting rewrites `/api/**` → `api` and `/generate` → `generate`, so the SPA and the API are
  same-origin in production and CORS never enters the picture.
- CI runs typecheck, lint, unit tests, and rules tests on every pull request. Deploys are
  manual — there is no auto-deploy on merge.

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
