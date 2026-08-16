# Slice 02 — HighLevel connection · Technical plan

**PRD:** `02-prd.md` (D1–D24, AC-1–43) · **Branch:** `slice/02-highlevel-connection` · **Date:** 2026-08-16

## Approach

A new `functions/src/hl/` module mounted on the existing `api` Express app, following the
shape `functions/src/auth/` already established: pure logic in its own files with L1 tests,
thin route handlers, and one router mounted at both `/` and `/api` because the emulator
strips the function name while the Hosting rewrite does not. Four endpoints, one state
module, one token module, one connection panel and one SPA route.

The one genuinely new piece of infrastructure is a **fake HighLevel server**, and it goes
inside the `api` function behind `isEmulator()` — the same gate `/auth/__test/cleanup`
already uses. That buys a fake with no extra process to start, no port to manage, and a
control an operator cannot switch on in production. `HL_AUTHORIZE_BASE` and `HL_API_BASE`
default to the real hosts and are pointed at it by the npm scripts, exactly as
`FIRESTORE_DATABASE_ID` already is.

**Alternatives considered.** A standalone fake HighLevel process — rejected, it adds a
lifecycle to manage in three test scripts for no isolation we need. Express middleware
setting `res.locals.uid` for the auth check — rejected in favour of a
`withVerifiedUser(handler)` wrapper that passes `uid` as an argument, because
`noPropertyAccessFromIndexSignature` makes `res.locals` untyped at every call site and
ambient state is exactly what this codebase avoids elsewhere. Storing consumed authorization
codes in Firestore for the fake — rejected, a module-level `Set` is enough for one emulator
process and AC-13 is the only consumer.

## The two things that would otherwise cost an hour each

**1. The callback's redirect must stay relative, and that decides `HL_REDIRECT_URI` under
the emulator.** The callback answers `Location: /hl/callback?...`. In production that is
same-origin because Hosting rewrites `/api/**` into the function. Under the emulator the
function lives on `127.0.0.1:5001` and the SPA on `localhost:5173`, so a relative redirect
would land on the functions emulator and render nothing.

The fix is not an `APP_BASE_URL` variable. `frontend/vite.config.ts:95` already proxies
`/api` to `EMULATOR_FUNCTIONS_TARGET`, so setting

```
HL_REDIRECT_URI=http://localhost:5173/api/oauth/callback
```

under the emulator keeps the entire loop on one origin, and the relative redirect works
unchanged in both environments. One fewer variable, and the e2e test exercises the same
redirect string production does.

**2. `logAuthEvent` does not currently redact `code` or `state`.** `SENSITIVE_KEY` in
`functions/src/lib/log.ts:23` catches `pass|token|secret|oobcode|api[-_]?key|…` — an
authorization code and a state token are both bearer credentials and neither matches. Adding
`code` to `INLINE_SECRET` would be wrong: `describeError` builds `"auth/email-already-exists: …"`
from an error's `code` property, and redacting that destroys the useful half of every error
line. The precise fix is a new pattern matching **query-string position only**:

```ts
const SENSITIVE_QUERY = /([?&](?:code|state)=)[^&\s]+/gi
```

so `?code=abc&state=xyz` is scrubbed while `code: 'auth/…'` in prose is untouched. AC-21 is
the test.

## File map

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/hl/config.ts` | New | Lazy env accessors — client id/secret, redirect URI, the two base URLs, and the scope constant. Lazy for the reason `getDb()` is: deploy analyses the module before injecting `.env` |
| `functions/src/hl/state.ts` | New | `sealState(uid)` / `openState(token)` — AES-256-GCM, HKDF-derived key, `base64url(iv ‖ ct ‖ tag)` |
| `functions/src/hl/state.spec.ts` | New | L1 — round trip, expiry, tampering, malformed input, uniqueness |
| `functions/src/hl/authorize.ts` | New | `buildAuthorizeUrl(state)` — pure string composition |
| `functions/src/hl/authorize.spec.ts` | New | L1 — every query parameter, byte-exact `redirect_uri`, scope encoding |
| `functions/src/hl/schema.ts` | New | Zod for the token response and the location response. Parse, don't validate |
| `functions/src/hl/schema.spec.ts` | New | L1 — accepts the recorded fixture, rejects an agency token and a missing `locationId` |
| `functions/src/hl/exchange.ts` | New | `exchangeCode()` / `refreshTokens()` — form-urlencoded, no `Version` header |
| `functions/src/hl/exchange.spec.ts` | New | L1 — request shape, asserted against a stubbed `fetch` |
| `functions/src/hl/token.ts` | New | `getAccessToken(uid)` — fast path, then the Firestore transaction |
| `functions/src/hl/token.spec.ts` | New | L1 — skew arithmetic, refresh triggering, not-connected error |
| `functions/src/hl/connect.ts` | New | `POST /hl/connect` handler |
| `functions/src/hl/callback.ts` | New | `GET /oauth/callback` handler — always 302 |
| `functions/src/hl/connection.ts` | New | `GET` and `DELETE /hl/connection` handlers |
| `functions/src/hl/fake.ts` | New | Emulator-only fake HighLevel: authorize page, token endpoint, locations |
| `functions/src/hl/fake.spec.ts` | New | L1 — the router is empty unless `isEmulator()` |
| `functions/src/hl/index.ts` | New | `hlRouter`, wiring App Check + `withVerifiedUser` per route |
| `functions/src/auth/requireUser.ts` | New | `withVerifiedUser(handler)` — verifies the ID token *and* `email_verified` (D26) |
| `functions/src/auth/requireUser.spec.ts` | New | L1 — missing token, invalid token, unverified claim |
| `functions/src/lib/log.ts` | Edit | `SENSITIVE_QUERY`, per the note above |
| `functions/src/lib/log.spec.ts` | Edit | AC-21 — codes and state tokens scrubbed, error `code:` prefixes preserved |
| `functions/src/api/index.ts` | Edit | Mount `hlRouter` at `/` and `/api`, beside `authRouter` |
| `functions/package.json` | Edit | `@gohighlevel/api-client` as a devDependency |
| `functions/.env.example` | Edit | ✅ already done — `OAUTH_STATE_SECRET`, `HL_AUTHORIZE_BASE`, `HL_API_BASE` |
| `package.json` | Edit | The three emulator scripts gain the fake-HL and redirect env vars |
| `frontend/src/lib/api.ts` | Edit | `authedFetch` — attaches the ID token and the App Check header |
| `frontend/src/lib/hlApi.ts` | New | `connect()`, `getConnection()`, `disconnect()` |
| `frontend/src/lib/hlApi.spec.ts` | New | L1 — paths, methods, error mapping |
| `frontend/src/stores/hl.ts` | New | Pinia: `status`, `loading`, `error`, `lastError`, `refresh()`, `startConnect()`, `disconnect()` |
| `frontend/src/stores/hl.spec.ts` | New | L1 — state transitions, `lastError` lifecycle |
| `frontend/src/components/ConnectionPanel.vue` | New | The five panel states |
| `frontend/src/components/ConnectionPanel.spec.ts` | New | L2 — AC-34–39, 42 |
| `frontend/src/views/HlCallbackView.vue` | New | "Finishing connection…", then `router.replace` |
| `frontend/src/views/HlCallbackView.spec.ts` | New | L2 — AC-40, 41 |
| `frontend/src/views/DashboardView.vue` | Edit | Render `<ConnectionPanel />` |
| `frontend/src/router/index.ts` | Edit | `/hl/callback`, `meta: { access: 'protected' }` |
| `frontend/src/router/guard.spec.ts` | Edit | AC-43 — the route round-trips through sign-in |
| `tests/integration/helpers.ts` | Edit | `idTokenFor()`, `getJson`, `deleteJson`, `fetchNoRedirect` |
| `tests/integration/hl-connect.spec.ts` | New | L4 — AC-4–7 |
| `tests/integration/hl-callback.spec.ts` | New | L4 — AC-9–20 |
| `tests/integration/hl-connection.spec.ts` | New | L4 — AC-22–26 |
| `tests/integration/hl-refresh.spec.ts` | New | L4 — AC-29–31 |
| `tests/rules/firestore.spec.ts` | Edit | AC-33 — re-assert with a realistic token document |
| `tests/e2e/highlevel.spec.ts` | New | L5 — the demo |
| `tests/fixtures/highlevel/*.json` | New | Recorded from the §9 walk |

## Task list

Ordered so every task leaves the suite green and nothing depends on a later one to compile.

### T1 — Record the HighLevel fixtures → enables everything
- **Not test-first, and this is the one place that is correct.** There is no code to test yet; the output is recorded data. Writing a test first would assert our guess at the response shape, which is precisely what D1 exists to avoid.
- Walk `HIGHLEVEL_PLATFORM.md` §9 against the sandbox. Save `token-response.json`, `location.json`, `refresh-response.json`, `refresh-reuse-error.json` into `tests/fixtures/highlevel/`.
- **Redact before committing** — real tokens must not enter git. Replace `access_token` / `refresh_token` values with obvious placeholders and keep the shape.
- Confirm `userType: "Location"`, `locationId` present, and that a re-sent refresh token fails.

### T2 — Seal and open the state → AC-4, 5, 10, 11, 12
- **Red:** `hl/state.spec.ts` — round trip returns the uid; a token expired by one ms is rejected; flipping any byte of iv, ciphertext or tag is rejected; a non-base64url string is rejected; two seals of one uid differ.
- **Green:** `hl/state.ts` — `hkdfSync('sha256', secret, '', 'genesis-oauth-state', 32)`, `createCipheriv('aes-256-gcm', key, randomBytes(12))`, decrypt then compare `exp`.
- **Refactor:** the key derivation memoised per process; the error a single `InvalidStateError` so no caller can branch on *why* it failed.

### T3 — Build the authorize URL → AC-1, 2, 3
- **Red:** `hl/authorize.spec.ts` — asserts base, `response_type`, `client_id`, `loginWindowOpenMode=self`, the state, and that `redirect_uri` decodes to `HL_REDIRECT_URI` exactly.
- **Green:** `hl/authorize.ts` + `hl/config.ts` with the scope constant.
- **Refactor:** scopes as a readonly tuple with the comment naming the marketplace app as the other half of the contract.

### T4 — Parse HighLevel's responses → AC-16
- **Red:** `hl/schema.spec.ts` — the recorded fixture parses; `userType: "Company"` fails; a body with no `locationId` fails; an unexpected extra field is dropped, not rejected.
- **Green:** `hl/schema.ts` — Zod, with `locationId` required and `userType` a literal.
- **Refactor:** export the inferred types; nothing else in the module hand-writes them.

### T5 — Stop codes and state tokens reaching the logs → AC-21
- **Red:** `lib/log.spec.ts` — `?code=…&state=…` in a logged URL is scrubbed; `describeError` still yields `auth/email-already-exists: …` intact.
- **Green:** `SENSITIVE_QUERY` in `lib/log.ts`, applied inside `scrubString`.
- **Refactor:** none expected; the existing structure absorbs it.

### T6 — Expiry arithmetic → AC-27, 32
- **Red:** `hl/token.spec.ts` — beyond the skew returns the stored token and calls no `fetch`; inside the skew triggers a refresh; a missing document rejects with `HlNotConnectedError`.
- **Green:** `hl/token.ts`, fast path only, refresh injected as a parameter so this stays pure.
- **Refactor:** `SKEW_MS` a named constant with the rotation-race comment.

### T7 — Verified-user wrapper → AC-6, 7
- **Red:** `auth/requireUser.spec.ts` — no header → 401; a token the Admin SDK rejects → 401; a valid token with `email_verified: false` → 403 `email_unverified`; a verified token calls the handler with the uid.
- **Green:** `auth/requireUser.ts` — `withVerifiedUser(handler)`, using `getAdminAuth().verifyIdToken`.
- **Refactor:** doc comment pointing at D26 and at why this is not a router-level `use`.

### T8 — The fake HighLevel server → enables T9–T12 and the e2e
- **Red:** `hl/fake.spec.ts` — the exported router has no routes when `isEmulator()` is false.
- **Green:** `hl/fake.ts` — `GET /__fake-hl/oauth/chooselocation` rendering an Approve and a Deny button that redirect to the supplied `redirect_uri` with `code`/`error` and the original `state`; `POST /__fake-hl/oauth/token` reading form-urlencoded bodies, serving the fixture, and refusing a code or refresh token it has already consumed; `GET /__fake-hl/locations/:id`.
- **Refactor:** consumed codes in a module-level `Set`; a query flag to force a 400 so T11 can drive `exchange_failed`.

### T9 — `POST /api/hl/connect` → AC-1–8 end to end
- **Red:** `tests/integration/hl-connect.spec.ts` — verified user gets 200 and an `authorizeUrl` whose state opens to their uid; no token → 401; unverified → 403.
- **Green:** `hl/connect.ts` + `hl/index.ts`, mounted in `api/index.ts` with `requireAppCheck` then `withVerifiedUser`, ordered as `authRouter` does it.
- **Refactor:** add `idTokenFor()` to `tests/integration/helpers.ts` using the existing client SDK wiring.

### T10 — Callback, happy path → AC-9, 17, 18, 19, 20
- **Red:** `tests/integration/hl-callback.spec.ts` — a valid state and code writes `hlConnections/{uid}` with the expected fields and 302s to `/hl/callback?status=connected`; the fake records that the exchange was form-urlencoded, carried `user_type=Location` and no `Version` header; `locationName` is stored; a failing location lookup still connects with `locationName: null`; reconnecting to another location leaves one document.
- **Green:** `hl/callback.ts`.
- **Refactor:** the Firestore write shaped by one `toConnectionDocument()` so T12's projection has a single source.

### T11 — Callback, every failure → AC-10–16
- **Red:** same file — tampered, expired, absent and malformed state each 302 to `invalid_state` with no write; `?error=access_denied` → `denied`; a forced 400 → `exchange_failed`; an agency token → `wrong_account_type`; a replayed code → `exchange_failed` with the existing connection untouched.
- **Green:** the failure branches, all funnelling through one `redirectWithError(code)`.
- **Refactor:** the outcome codes a union type shared with the frontend copy map, so a new code cannot be added on one side only.

### T12 — Status and disconnect → AC-22–26
- **Red:** `tests/integration/hl-connection.spec.ts` — never-connected shape; connected shape with no `accessToken`/`refreshToken`/`expiresAt` anywhere in the raw body; delete removes the document; delete when absent still 200; user B never sees user A's connection.
- **Green:** `hl/connection.ts`.
- **Refactor:** assert absence against the raw response text, not the parsed object — a nested leak survives a key check on the top level.

### T13 — Transactional refresh → AC-28, 29, 30, 31
- **Red:** `tests/integration/hl-refresh.spec.ts` — two concurrent `getAccessToken` calls against an expired connection produce exactly one token request at the fake and one shared return; `invalid_grant` sets `needsReconnect` and leaves `refreshToken` in place; a 500 changes neither.
- **Green:** the transaction half of `hl/token.ts`, per `HIGHLEVEL_PLATFORM.md` §3.
- **Refactor:** the "someone else refreshed while we waited" branch commented, since it looks redundant and is the entire point.

### T14 — Rules re-assertion → AC-33
- **Red:** `tests/rules/firestore.spec.ts` — owner and stranger both denied read *and* write on `hlConnections/{uid}`, against a document carrying realistic token fields.
- **Green:** none — `firestore.rules` already denies it. **If this task needs a rules change, something is wrong**; the value is proving the deny still holds now that the document holds real credentials.
- **Refactor:** none.

### T15 — Frontend client and store → supports AC-34–42
- **Red:** `lib/hlApi.spec.ts` and `stores/hl.spec.ts` — correct method and path per call; a 401 surfaces as a typed error; `refresh()` moves loading → loaded; `lastError` is set by `noteError()` and cleared on the next successful refresh.
- **Green:** `authedFetch` in `lib/api.ts`, `lib/hlApi.ts`, `stores/hl.ts`.
- **Refactor:** `authedFetch` shares the App Check header helper with `authApi.ts` rather than duplicating it.

### T16 — The connection panel → AC-34–39, 42
- **Red:** `components/ConnectionPanel.spec.ts` — loading, not-connected, connected-with-name, connected-with-id-only, reconnect-required, error-with-retry, per-code Alert copy including an unknown code, and Connect disabled while in flight.
- **Green:** `ConnectionPanel.vue` using the vendored `Card`, `Alert` and `Button`.
- **Refactor:** copy in one exported map keyed by the union from T11.

### T17 — The callback route → AC-40, 41, 43
- **Red:** `views/HlCallbackView.spec.ts` — mounting shows the finishing state, calls `refresh()`, and calls `router.replace('/dashboard')` not `push`; with `status=error&code=…` it writes `lastError` before navigating. `router/guard.spec.ts` — `/hl/callback` resolves as `protected`.
- **Green:** `HlCallbackView.vue`, the router entry, `<ConnectionPanel />` on the dashboard.
- **Refactor:** none expected.

### T18 — End to end → the demo
- **Red:** `tests/e2e/highlevel.spec.ts` — sign up, verify, dashboard, Connect, approve at the fake, land on the dashboard showing the location name, disconnect, back to Not connected.
- **Green:** whatever wiring the walk exposes.
- **Refactor:** the three emulator scripts in `package.json` gain `HL_AUTHORIZE_BASE`, `HL_API_BASE`, `HL_REDIRECT_URI` and `OAUTH_STATE_SECRET`, so a fresh clone runs it with no setup.

**AC coverage:** all 43 map to at least one task. AC-8 is covered only as "the middleware is mounted" (T9) — a genuinely forged App Check token is refused by Google, not by us, so the deployed behaviour stays manual, exactly as Slice 1 recorded for its AC-50.

## Firestore rules changes

**None.** The state is encrypted and never persisted (D3), so this slice adds no collection —
`CLAUDE.md`'s "any new collection gets rules and L3 tests in the same commit" does not fire.
`hlConnections/{uid}` already carries its deny in `firestore.rules:69`:

```
match /hlConnections/{uid} {
  allow read, write: if false;
}
```

T14 re-asserts it against a document holding real token fields, because this is the slice
where that document stops being hypothetical.

## Dependencies

| Package | Where | Why |
|---|---|---|
| `@gohighlevel/api-client` | functions devDependency | Types only, never imported at runtime (D20, `PRODUCT_SPEC.md` §7.3). Its `.d.ts` is a better parameter reference than the docs portal |

No runtime dependency is added. AES-GCM and HKDF are `node:crypto`, both confirmed present
on Node 22; the exchange is `fetch`; Zod and Express are already here.

## Manual verification

```bash
npm run emulators          # auth + firestore + functions, with the fake HL wired
npm run dev:emulator       # SPA on :5173
```

1. Sign up, verify through the emulator's oob code, land on the dashboard.
2. The panel shows **Not connected**. Click **Connect HighLevel**.
3. The fake authorize page appears — click **Approve**.
4. Back on the dashboard: **Connected to Genesis Sandbox**.
5. Reload — still connected, proving it came from Firestore and not component state.
6. **Disconnect** → **Not connected**.
7. Click Connect and then **Deny** → "Connection cancelled."
8. In the Firestore emulator UI, confirm `hlConnections/{uid}` exists and that the SPA
   never read it — the Network tab shows `/api/hl/connection`, not a Firestore listen.

Then once, against the real sandbox, with `.env` pointed at the real hosts: connect, confirm
the real location name renders, disconnect.

## Estimate

| Task | Estimate |
|---|---|
| T1 fixtures | 45m |
| T2 state | 45m |
| T3 authorize | 30m |
| T4 schema | 45m |
| T5 log redaction | 20m |
| T6 expiry math | 30m |
| T7 verified-user wrapper | 40m |
| T8 fake HighLevel | 1h 15m |
| T9 connect endpoint | 45m |
| T10 callback happy path | 1h |
| T11 callback failures | 1h |
| T12 status and disconnect | 45m |
| T13 transactional refresh | 1h 15m |
| T14 rules | 15m |
| T15 client and store | 45m |
| T16 panel | 1h |
| T17 callback route | 45m |
| T18 e2e | 1h |
| **Total** | **≈ 13h 45m** |

No single task exceeds half a day. **The total does, and it is worth saying plainly:** this
is roughly two working days, and `IMPLEMENTATION_PLAN.md` §5 has slices 2, 3 and 4 sharing
today. Slice 2 alone consumes the day and then some.

Two levers, in the order they should be pulled, both already named in the PRD's risks:

1. **T13 moves to Slice 8** (PRD risk 6's cut line) — saves ~1h 15m and removes the hardest
   concurrency work from this PR. The cost is that Slice 8 writes it under day-4 pressure,
   which is what D13 argued against; take this only if the day is genuinely lost.
2. **T8 and T18 collapse** to the PRD's D14 fallback — e2e hits the callback directly with a
   pre-sealed state, and Connect is covered at L2. Saves ~1h 30m and costs the demo its
   automated proof.

My recommendation is to take neither yet, run T1–T7 first, and re-measure. Those seven are
~4h 25m, they are all pure logic with no integration risk, and finishing them tells you far
more about the real pace than this table does.

## Risks specific to the build

1. **T1 is a hard prerequisite and it is not code.** If the sandbox or the marketplace app
   misbehaves, every task after T4 is blocked. Do it first, in one sitting.
2. **Real tokens must not reach git.** T1 writes fixtures from live responses; redact the
   token values in the same action that saves them, not as a follow-up.
3. **The vite proxy carrying a 302 is assumed, not proven.** It follows from the config at
   `frontend/vite.config.ts:95` and standard proxy behaviour, but T18 is the first thing to
   exercise it. If the `Location` header does not survive, the fallback is an `APP_BASE_URL`
   variable holding an absolute SPA origin — half an hour, not a redesign.
