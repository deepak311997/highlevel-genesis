# Slice 02 — HighLevel connection · PRD

**Spec:** F1.2, F1.3 · **Branch:** `slice/02-highlevel-connection` · **Depends on:** 1 · **Date:** 2026-08-16

## Problem

A signed-in user has an account and nothing to build against. Genesis generates apps that
call *real* HighLevel APIs, so every slice downstream — the proxy (8), knowledge injection
(9), the live preview (10) — is dead until a user's HighLevel location is linked to their
Firebase uid and we hold a token we can refresh on their behalf. Today there is no link,
no token, and no way to make one.

## The demo

Sign in, click **Connect HighLevel**, pick the sandbox location, land back on the dashboard
showing **Connected to \<location name\>**, then disconnect and watch it return to
**Not connected**.

## Decisions

Interview decisions first, then the ones taken from `HIGHLEVEL_PLATFORM.md` and Slice 1's
standing contracts, recorded so the build can be re-derived from this document alone.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Are the HighLevel API fixtures recorded or hand-written? | **Recorded.** The build's first task walks `HIGHLEVEL_PLATFORM.md` §9 against the sandbox and saves every response body into `tests/fixtures/highlevel/`. | Hand-written fixtures encode our *assumption* about the response shape, so tests built on them pass while the real integration fails. §9 also proves the redirect-URI exact match and the refresh rotation before any code depends on either. |
| D2 | Who builds the authorize URL? | **The server.** `POST /api/hl/connect` verifies the ID token and `email_verified`, encrypts the state, and returns `{ authorizeUrl }`; the SPA navigates to it. | `client_id` and the scope list stay out of the bundle, and the uid inside the state is one the server established rather than one the client asserted. It is also the only place D26's verified check can run *before* the redirect. |
| D3 | How is the CSRF `state` carried? | **An encrypted, stateless token.** `{ uid, exp }` sealed with **AES-256-GCM** under a key derived from `OAUTH_STATE_SECRET`; the wire form is `base64url(iv ‖ ciphertext ‖ authTag)`. **No Firestore collection.** The callback decrypts, which authenticates, then checks the expiry. | **This reverses an earlier decision to store state in Firestore, and the reason is worth recording.** The store was justified as replay protection, but replay achieves nothing: a replayed callback carries an authorization code HighLevel has already consumed, so the exchange fails on its own. And the CSRF attack this parameter exists to stop — feeding a victim the attacker's `code` — is defeated by *binding the uid into the state*, not by consuming it. The connection simply lands on whichever uid the state names. So the collection bought a write on the hot path, a rules block, an L3 test and stale-document housekeeping, in exchange for protection already provided twice over. |
| D4 | Encrypted rather than merely signed — why? | **Encrypted.** A signed token's payload is readable by anyone holding it. | The state travels in a URL to a third party. Signed, the **Firebase uid would sit in plain base64** in the user's address bar and history, in HighLevel's request logs, and in any `Referer` header downstream of the authorize page. A uid is not a credential — rules do not trust it — but handing an internal identifier to another company's logging for no reason is a disclosure we can decline for free. AEAD also folds integrity in: the GCM auth tag makes a separate HMAC redundant, tamper detection comes with decryption, and the constant-time comparison stops being ours to hand-write. |
| D5 | The key | **`OAUTH_STATE_SECRET`,** its own secret in Secret Manager, never derived from `HL_CLIENT_SECRET`. The 32-byte AES key comes from it via **HKDF-SHA256**, so the secret may be any sufficiently random string rather than exactly 32 bytes. | One secret serving two purposes means rotating either one breaks the other. HKDF also means a rotated secret produces an entirely unrelated key. |
| D6 | Is a `nonce` field needed in the payload? | **No.** GCM requires a fresh random 12-byte IV per encryption, and the IV is part of the wire format, so two states for the same uid in the same second already differ. | A payload nonce would be a second uniqueness mechanism doing the IV's job. |
| D7 | State lifetime | **5 minutes.** | The window has to cover the user *at HighLevel* — possibly signing in, clearing 2FA, and choosing from a list of locations. Two minutes fails a first-time connect and the user cannot tell why; ten leaves the token valid long after the flow is abandoned. |
| D8 | How does the UI read connection status? | **`GET /api/hl/connection`,** authenticated. No client-readable mirror of the connection. | `hlConnections/{uid}` holds tokens and stays denied to every client, including the owner (rules already say so, and Slice 1 has the denial test). A mirror document would be a second place the connection state lives and a second thing to keep true. |
| D9 | Where does HighLevel's redirect land in the SPA? | **A dedicated route, `/hl/callback`.** The Cloud Function callback 302s there, the route resolves the outcome, refreshes connection state, then `router.replace`s to `/dashboard`. | The dashboard has nothing to do with OAuth and should not carry connection query parameters forever. A dedicated route owns "finishing the connection" and keeps that concern in one file. `replace` rather than `push` so the back button cannot return to a spent callback URL. |
| D10 | How does a callback error reach the panel? | **Through the connection store,** not a query parameter on `/dashboard`. `/hl/callback` writes `lastError`, then navigates to a clean URL. | Otherwise D9's cleanup just moves the query string one screen along. |
| D11 | What does `/hl/callback` render? | **A brief "Finishing connection…" status, then it navigates automatically.** No button on the happy path. | A terminal screen with a Continue button adds a click to the demo and tells the user nothing they did not already know. |
| D12 | What does the user see when the callback fails? | **The dashboard panel renders an Alert** from `lastError`. Codes: `denied`, `invalid_state`, `exchange_failed`, `wrong_account_type`. | Error copy lives in one place, beside the Connect button that retries it. |
| D13 | How much refresh machinery lands here? | **All of it.** `getAccessToken()` with the 5-minute skew and the Firestore transaction from `HIGHLEVEL_PLATFORM.md` §3, tested at L1 and L4. No runtime consumer until Slice 8. | Rotation-on-use bricks a connection when two callers refresh at once, and Slice 10's preview fires parallel proxy calls into exactly that. Designing it under day-4 time pressure is how it gets written wrong — and a bricked connection is unrecoverable without a reinstall. |
| D14 | How does e2e drive the flow? | **`HL_AUTHORIZE_BASE` and `HL_TOKEN_BASE`** default to the real hosts and point at a local fake under the emulator. Playwright walks the whole loop. | Hitting the callback directly would skip the Connect button and the authorize redirect — the two things most likely to be misconfigured. |
| D15 | What does Disconnect do? | **Deletes `hlConnections/{uid}` only.** The install stays on HighLevel's side. | No revoke endpoint is documented in `HIGHLEVEL_PLATFORM.md`, and a revoke that fails leaves a half-disconnected state to design around. Reconnecting re-runs OAuth and replaces the record, so switching location falls out for free. |
| D16 | Agency or sub-account install? | **Target User = Sub-account,** so the install returns a Location token directly. `/oauth/locationToken` is never called. | `HIGHLEVEL_PLATFORM.md` §1. It is also what makes F1.3's "one HL location per user" a design decision rather than a limitation. |
| D17 | API versions | **Date-pinned:** `2021-07-28` for locations, `2021-04-15` for calendars/conversations. `v3` migration is a named README follow-up. | Already settled in `IMPLEMENTATION_PLAN.md` §8. |
| D18 | Which scopes, and where do they live? | **The full list** from `HIGHLEVEL_PLATFORM.md` §4 — required plus the four cheap extras — as a **constant in code**, not an env var. | Adding a scope later forces every install to re-authorize. It is not a secret, it must match the marketplace app exactly, and one constant with one comment is easier to diff against the portal than a value in a file nobody reads. |
| D19 | Where does the location name come from? | **Fetched once at callback time** via `GET /locations/{locationId}` and stored on the connection. | The status endpoint then costs one Firestore read and no HighLevel call. A live fetch on every status read would burn the burst limit on a page that renders on every dashboard visit. |
| D20 | `@gohighlevel/api-client` | **devDependency, types only.** Never imported at runtime. | `PRODUCT_SPEC.md` §7.3. Its auto-refresh would reintroduce the rotation race D11 exists to close. |
| D21 | The redirect URI | `https://hl-genesis-app.web.app/api/oauth/callback`, byte for byte in three places: the marketplace app, `HL_REDIRECT_URI`, and both the authorize URL and the token exchange. | HighLevel rejects a redirect URL containing the string `highlevel`, which is why the project id is `hl-genesis-app`. Recorded in `functions/.env.example` because it is invisible from the code. |
| D22 | App Check on these endpoints? | **On `POST /api/hl/connect` and `DELETE /api/hl/connection`. Not on the callback.** | The callback is a browser navigation initiated by HighLevel; it cannot carry an App Check header. Its protection is the encrypted state, not attestation. |
| D23 | What happens when a refresh fails? | **Never clear the stored refresh token on a transient failure.** Set `needsReconnect: true` only on a definitive `invalid_grant`. | `HIGHLEVEL_PLATFORM.md` §3. Persisting a network blip as a dead connection destroys a refresh token that was probably still valid. |
| D24 | Path namespace | Connection management owns `/api/hl/connect` and `/api/hl/connection`. **Slice 8's proxy is reserved `/api/hl/proxy/**`.** | Slice 8 forwards arbitrary HighLevel paths under `/api/hl/*`. Without reserving a subtree now, a HighLevel path segment could shadow a management route. |

## In scope

- `POST /api/hl/connect` — authenticated, attested, seals the state, returns the authorize URL
- `GET /api/oauth/callback` — verifies state, exchanges the code, stores the connection, redirects into the SPA
- `GET /api/hl/connection` — authenticated connection status
- `DELETE /api/hl/connection` — authenticated disconnect
- A state module: seal and open, AES-256-GCM with an HKDF-derived key
- `getAccessToken(uid)` — transactional refresh with a 5-minute skew (no runtime consumer yet)
- `/hl/callback` — a new SPA route that resolves the outcome and navigates on
- A connection panel on the dashboard with loading, not-connected, connected, reconnect-required and error states
- A fake HighLevel server for the emulator, selected by `HL_AUTHORIZE_BASE` / `HL_TOKEN_BASE`
- Recorded fixtures in `tests/fixtures/highlevel/` from the §9 walk

## Out of scope

| Not here | Picked up by |
|---|---|
| The HighLevel API proxy and its route allowlist | Slice 8 |
| Any runtime consumer of `getAccessToken()` | Slice 8 |
| Contacts / Conversations / Calendars calls of any kind | Slice 8 |
| Rate-limit header surfacing (`X-RateLimit-*`) | Slice 8 |
| A dedicated `/integrations` screen | Deferred — one integration does not make a list. Revisit if a second arrives. |
| Sandbox seeding (`scripts/seed-sandbox.ts`) | Slice 13 |
| Registering the callback URL on a *deployed* app as a deliverable | Slice 13 (F9.3) |
| Webhook `UNINSTALL` handling | Not planned — `HIGHLEVEL_PLATFORM.md` §7 recommends skipping |

## User flow

1. A verified user lands on `/dashboard`. The connection panel shows a **loading** state while status is fetched.
2. Status returns `{ connected: false }` → the panel shows **Not connected** and a **Connect HighLevel** button.
3. Click → `POST /api/hl/connect` → `{ authorizeUrl }` → the SPA navigates to HighLevel.
4. The user picks the sandbox location and approves.
5. HighLevel redirects to `/api/oauth/callback?code=…&state=…`.
6. The callback opens the state — decryption authenticates it — checks the expiry, exchanges the code, reads the location name, writes `hlConnections/{uid}`, and 302s to `/hl/callback?status=connected`.
7. `/hl/callback` shows **Finishing connection…**, refreshes the connection store, then `router.replace('/dashboard')`.
8. The panel shows **Connected to \<location name\>** with a **Disconnect** button.
9. Disconnect → `DELETE /api/hl/connection` → back to **Not connected**.

On failure, step 6 redirects to `/hl/callback?status=error&code=<code>`; step 7 writes the code to the store as `lastError` and still lands on a clean `/dashboard`, where the panel renders the matching Alert.

## Data model

**`hlConnections/{uid}`** — already declared in `firestore.rules` with `allow read, write: if false`. Admin SDK only; no client, not even the owner, may read it.

| Field | Type | Note |
|---|---|---|
| `accessToken` | string | 24h lifetime |
| `refreshToken` | string | rotates on every use — persisting the new one is mandatory |
| `expiresAt` | Timestamp | `now + expires_in`, compared against a 5-minute skew |
| `locationId` | string | from the token response |
| `locationName` | string \| null | `GET /locations/{id}` at callback time; null if that call failed |
| `companyId` | string | |
| `hlUserId` | string | HighLevel's `userId`, named distinctly so it is never confused with the Firebase uid |
| `scope` | string | what was actually granted, which can differ from what was asked |
| `needsReconnect` | boolean | set only on a definitive `invalid_grant` (D23) |
| `connectedAt` / `updatedAt` | Timestamp | server clock |

**No new collection, and therefore no rules change.** The state is an encrypted token that
is never written anywhere (D3). `CLAUDE.md`'s "any new Firestore collection gets rules and L3
tests in the same commit" does not trigger — but the existing `hlConnections` denial test is
re-asserted, because this is the slice that first puts real tokens in it.

**The state token:**

```
key    = HKDF-SHA256(OAUTH_STATE_SECRET) → 32 bytes
iv     = 12 random bytes
ct,tag = AES-256-GCM(key, iv, JSON({ uid, exp }))
state  = base64url(iv ‖ ct ‖ tag)
```

`exp` is epoch ms, `now + 5 min`. The random IV is what makes two connects by the same user
in the same second produce different states, so the payload carries no nonce of its own
(D6). Opening it is: decrypt — which verifies the GCM auth tag, and therefore rejects any
tampering before the plaintext is trusted — then check `exp`. That order matters: an expired
forgery is rejected as a forgery, and a caller never learns whether a token they forged
would otherwise have been in date.

**Indexes:** none.

## API contracts

### `POST /api/hl/connect`

Auth: Firebase ID token (`Authorization: Bearer`) **and** `email_verified` true (D26). App Check required.

- **200** → `{ "authorizeUrl": "https://marketplace.gohighlevel.com/oauth/chooselocation?..." }`
- **401** `unauthenticated` — no or invalid ID token
- **401** `app_check_failed` — missing or invalid App Check token
- **403** `email_unverified`
- **500** `internal`

### `GET /api/oauth/callback`

Auth: **none** — this is HighLevel's redirect. The encrypted state is the authorisation.
Always responds **302**; never renders a body.

| Condition | `Location` |
|---|---|
| Success | `/hl/callback?status=connected` |
| `?error=access_denied` from HighLevel | `/hl/callback?status=error&code=denied` |
| State absent, malformed, tampered, or expired | `/hl/callback?status=error&code=invalid_state` |
| Token exchange returns non-2xx, or the body fails its schema | `/hl/callback?status=error&code=exchange_failed` |
| `userType !== "Location"` or `locationId` absent | `/hl/callback?status=error&code=wrong_account_type` |

### `GET /api/hl/connection`

Auth: ID token + `email_verified`.

- **200** → `{ "connected": false }`
- **200** → `{ "connected": true, "locationId": "…", "locationName": "…" | null, "connectedAt": "<ISO>", "needsReconnect": false }`
- **401** / **403** as above

Tokens and `expiresAt` are never in the response.

### `DELETE /api/hl/connection`

Auth: ID token + `email_verified`. App Check required.

- **200** → `{ "ok": true }` — idempotent; disconnecting when not connected is a success
- **401** / **403** as above

### `/hl/callback` (SPA route)

Access class: `protected` — signed in and verified. A lapsed session bounces to
`/signin?redirect=/hl/callback?...` and returns after sign-in.

## Edge cases and failure modes

| Case | What the user sees | Retry? |
|---|---|---|
| User clicks Deny at HighLevel | Alert: "Connection cancelled." Connect button still there | Yes, by clicking again |
| State expired (>5 min), tampered, or malformed | Alert: "That connection link expired. Try connecting again." | Yes |
| Callback URL replayed with a spent code | The exchange fails at HighLevel → `exchange_failed`; the existing connection is untouched | Yes |
| Code exchange fails (bad code, redirect mismatch, HL 5xx) | Alert: "Couldn't complete the connection. Try again." | Yes |
| Token response is an Agency token, or has no `locationId` | Alert naming the cause: connect a **sub-account**, not an agency | Yes |
| `GET /locations/{id}` fails after a successful exchange | **Connected**, with the location id shown in place of the name | Not needed — the connection works |
| Already connected, user connects again | The new location replaces the old one | n/a |
| Session lapsed while the user was at HighLevel | Sign-in, then straight back to `/hl/callback` and on to the dashboard | Automatic |
| Two requests refresh an expired token at once | One rotates; the other reads the winner's token inside the transaction | Automatic |
| Refresh returns `invalid_grant` | **Reconnect required**, with a Connect button | Yes, by reconnecting |
| Refresh fails transiently (network, 5xx) | Nothing — the stored refresh token is untouched (D23) | Automatic next call |
| Status fetch fails | Alert: "Couldn't load connection status." with a Retry button | Yes |
| Unauthenticated call to any `/api/hl/*` | 401 | n/a |
| Authenticated but unverified | 403 — the gate holds for non-browser callers too (D26) | n/a |

## Acceptance criteria

**Connect**

- **AC-1** — Given a verified signed-in user, when they `POST /api/hl/connect`, then the response is 200 and `authorizeUrl` points at `HL_AUTHORIZE_BASE + /oauth/chooselocation`.
- **AC-2** — Given that response, then `authorizeUrl` carries `response_type=code`, the configured `client_id`, `redirect_uri` equal to `HL_REDIRECT_URI` byte for byte, `loginWindowOpenMode=self`, and a `state`.
- **AC-3** — Given that response, then `scope` contains every scope in the code constant, space-separated and URL-encoded.
- **AC-4** — Given that response, then `state` decrypts under the key derived from `OAUTH_STATE_SECRET` to the caller's uid with an `exp` five minutes ahead, and the raw uid does not appear anywhere in `authorizeUrl`.
- **AC-5** — Given two calls by the same user in the same second, then the two `state` values differ, because the IV is freshly random per seal.
- **AC-6** — Given no ID token, when `POST /api/hl/connect`, then 401.
- **AC-7** — Given a signed-in but **unverified** user, then 403 `email_unverified`.
- **AC-8** — Given a missing App Check token in a deployed-style environment, then 401 `app_check_failed`.

**Callback**

- **AC-9** — Given a valid state and a code the token endpoint accepts, when the callback runs, then `hlConnections/{uid}` is written with `accessToken`, `refreshToken`, `locationId`, `expiresAt` and `connectedAt`, and the response is 302 to `/hl/callback?status=connected`.
- **AC-10** — Given a state whose ciphertext, IV or auth tag has been altered by even one byte, then decryption fails, the response is 302 to `?code=invalid_state`, and no connection is written.
- **AC-11** — Given a state whose `exp` has passed, then 302 to `?code=invalid_state` and no connection is written.
- **AC-12** — Given a `state` that is absent, not valid base64url, or shorter than the minimum iv+tag length, then 302 to `?code=invalid_state`.
- **AC-13** — Given a callback replayed with a code HighLevel has already consumed, then 302 to `?code=exchange_failed` and the existing connection is unchanged.
- **AC-14** — Given `?error=access_denied`, then 302 to `?code=denied`.
- **AC-15** — Given the token endpoint returns 400, then 302 to `?code=exchange_failed` and no connection is written.
- **AC-16** — Given a token response whose `userType` is `Company` or which has no `locationId`, then 302 to `?code=wrong_account_type` and no connection is written.
- **AC-17** — Given a successful exchange, then the exchange request was `application/x-www-form-urlencoded`, carried `user_type=Location`, and sent **no** `Version` header.
- **AC-18** — Given a successful exchange, then `GET /locations/{locationId}` was called with `Version: 2021-07-28` and its `name` is stored as `locationName`.
- **AC-19** — Given that location lookup fails, then the connection is still written with `locationName: null` and the redirect is still `status=connected`.
- **AC-20** — Given a user who is already connected, when they complete the flow against a different location, then `hlConnections/{uid}` holds the new `locationId` and exactly one document exists for that uid.
- **AC-21** — Given any callback outcome, then no access token, refresh token, authorization code, state token or derived key appears in the logs.

**Status and disconnect**

- **AC-22** — Given a user who has never connected, when they `GET /api/hl/connection`, then 200 `{ connected: false }`.
- **AC-23** — Given a connected user, then 200 with `connected: true`, `locationId`, `locationName` and `connectedAt`, and **no** `accessToken`, `refreshToken` or `expiresAt` in the body.
- **AC-24** — Given a connected user, when they `DELETE /api/hl/connection`, then 200 and `hlConnections/{uid}` no longer exists.
- **AC-25** — Given a user who is not connected, when they `DELETE /api/hl/connection`, then 200 `{ ok: true }`.
- **AC-26** — Given user A is connected, when user B calls `GET /api/hl/connection`, then B's own status is returned and never A's.

**Token refresh**

- **AC-27** — Given a connection whose `expiresAt` is more than 5 minutes away, when `getAccessToken` is called, then the stored token is returned and no HighLevel request is made.
- **AC-28** — Given a connection expiring within the 5-minute skew, then a refresh is performed and the **new** `refreshToken`, `accessToken` and `expiresAt` are persisted.
- **AC-29** — Given two concurrent `getAccessToken` calls on an expired connection, then exactly one refresh request reaches HighLevel and both callers return the same token.
- **AC-30** — Given a refresh that returns `invalid_grant`, then `needsReconnect` becomes true and the stored `refreshToken` is left in place.
- **AC-31** — Given a refresh that fails with a 500 or a network error, then `needsReconnect` stays false and the stored `refreshToken` is unchanged.
- **AC-32** — Given no connection for the uid, then `getAccessToken` rejects with a not-connected error rather than returning undefined.

**Rules**

- **AC-33** — Given a connection's owner, then reading or writing `hlConnections/{ownUid}` is denied; given any other signed-in client, likewise.

**UI**

- **AC-34** — Given the dashboard is mounting, then the connection panel shows a loading state until status resolves.
- **AC-35** — Given `{ connected: false }`, then the panel shows "Not connected" and an enabled Connect button.
- **AC-36** — Given `{ connected: true }`, then the panel shows the location name and a Disconnect button, and no Connect button.
- **AC-37** — Given `connected: true` with `locationName: null`, then the panel shows the location id.
- **AC-38** — Given `needsReconnect: true`, then the panel shows a reconnect prompt and a Connect button.
- **AC-39** — Given the status request fails, then the panel shows an error state with a Retry control, and Retry re-issues the request.
- **AC-40** — Given `/hl/callback?status=connected`, then the route shows a finishing state, refreshes connection status, and replaces history with `/dashboard` — so going back does not return to the callback URL.
- **AC-41** — Given `/hl/callback?status=error&code=<code>`, then the code is written to the store, the URL still lands on a clean `/dashboard`, and the panel renders that code's message; given an unrecognised code, a generic failure message.
- **AC-42** — Given the Connect button is clicked, then it is disabled while the request is in flight, so a double-click mints only one state.
- **AC-43** — Given a signed-out user opens `/hl/callback?status=connected`, then the guard sends them to sign-in and returns them to `/hl/callback` afterwards.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| 1–3 | L1 | `functions/src/hl/authorize.spec.ts` | URL composition: base, params, exact `redirect_uri`, scope encoding |
| 4, 5 | L1 | `functions/src/hl/state.spec.ts` | Seal/open round trip, uid and `exp` payload, two seals of one payload differ |
| 6, 7 | L4 | `tests/integration/hl-connect.spec.ts` | 401 without a token, 403 unverified |
| 8 | L1 | `functions/src/hl/connect.spec.ts` | App Check middleware is mounted on the route |
| 9 | L4 | `tests/integration/hl-callback.spec.ts` | Happy path against the fake HL: document shape and redirect |
| 10–12 | L1 | `functions/src/hl/state.spec.ts` | Flipped byte in ciphertext/IV/tag, expired `exp`, malformed input all rejected |
| 10–12 | L4 | `tests/integration/hl-callback.spec.ts` | Each rejection reaches `?code=invalid_state` with no write |
| 13 | L4 | `tests/integration/hl-callback.spec.ts` | Replayed callback: spent code → `exchange_failed`, connection untouched |
| 14–16 | L4 | `tests/integration/hl-callback.spec.ts` | Deny, exchange failure, wrong account type |
| 17 | L1 | `functions/src/hl/exchange.spec.ts` | Content-type, `user_type`, absence of `Version` |
| 18, 19 | L4 | `tests/integration/hl-callback.spec.ts` | Location name stored; lookup failure degrades to null |
| 20 | L4 | `tests/integration/hl-callback.spec.ts` | Reconnect replaces, one document per uid |
| 21 | L1 | `functions/src/lib/log.spec.ts` | Extends Slice 1's redaction test to token, code and state fields |
| 22–26 | L4 | `tests/integration/hl-connection.spec.ts` | Status shapes, secret fields absent, idempotent delete, cross-user isolation |
| 27, 28, 32 | L1 | `functions/src/hl/token.spec.ts` | Skew arithmetic, refresh triggering, not-connected error |
| 29 | L4 | `tests/integration/hl-refresh.spec.ts` | Concurrent callers: one rotation, one shared token |
| 30, 31 | L4 | `tests/integration/hl-refresh.spec.ts` | `invalid_grant` vs transient failure |
| 33 | L3 | `tests/rules/firestore.spec.ts` | `hlConnections` denied to owner and stranger alike |
| 34–39, 42 | L2 | `frontend/src/components/ConnectionPanel.spec.ts` | Every panel state, error copy per code, double-click guard |
| 40, 41 | L2 | `frontend/src/views/HlCallbackView.spec.ts` | Finishing state, store write, `replace` not `push` |
| 43 | L1 | `frontend/src/router/guard.spec.ts` | `/hl/callback` is `protected` and round-trips through sign-in |
| **Demo** | L5 | `tests/e2e/highlevel.spec.ts` | Connect → fake authorize → callback → name on screen → disconnect |

## Definition of done

- [ ] Every AC above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`, `test:e2e`
- [ ] No new Firestore collection this slice; the `hlConnections` denial test is re-asserted
- [ ] F8 error paths handled for this surface: every failure mode above renders user-facing copy
- [ ] Loading, empty and error states exist for the connection panel and `/hl/callback`
- [ ] No secrets in source; `functions/.env.example` gains `OAUTH_STATE_SECRET`, `HL_AUTHORIZE_BASE`, `HL_TOKEN_BASE`
- [ ] Runs clean on `firebase emulators:start` from a fresh clone, with the fake HL server
- [ ] README delta if setup steps changed
- [ ] PR opened with demo evidence; **human approves before merge**

Slice-specific:

- [ ] `HIGHLEVEL_PLATFORM.md` §9 walked against the sandbox, every response body saved to `tests/fixtures/highlevel/`
- [ ] Refresh rotation confirmed by hand: the returned refresh token differs, and the old one then fails
- [ ] `HL_CLIENT_SECRET` and `OAUTH_STATE_SECRET` in Secret Manager for the deployed environment, not plain env vars
- [ ] `@gohighlevel/api-client` added as a **devDependency** and imported by nothing at runtime

## Risks

1. **Redirect URI exact match.** `HL_REDIRECT_URI`, the marketplace app field, the authorize URL and the token exchange must be one identical string. A trailing slash in one is the classic lost hour. Mitigated by reading it from one env var everywhere and asserting it in AC-2.
2. **Scope changes force re-authorization.** D18 takes the full list up front. If the build discovers a missing scope, every existing install must reconnect — cheap now, expensive after the Loom is recorded.
3. **Rotation-on-use.** The reason for D13. AC-29 is the test that matters; if it is flaky, the design is wrong, not the test.
4. **A key we cannot rotate without breaking in-flight connects.** Rotating `OAUTH_STATE_SECRET` changes the HKDF output entirely, so every state minted in the previous 5 minutes fails to decrypt. That is an acceptable blast radius, and it is 5 minutes rather than 10 because of D7 — but it is the cost of D3 and is worth knowing before someone rotates a secret at 3pm on a demo day.
5. **The fake HighLevel server is new test infrastructure** and is the largest single piece of scaffolding in this slice. If it starts costing more than it returns, the named fallback is D14's alternative — e2e hits the callback directly and the Connect button is covered at L2 only.
6. **Slice size.** Four endpoints, a state module, a token module, two front-end surfaces and a fake server. It is one coherent vertical so it stays one PR, but if it needs cutting, the cut line is the refresh machinery (D13) moving to Slice 8 — everything else is load-bearing for the demo.
7. **Sandbox has no data yet.** Not blocking for this slice — connecting and reading the location name needs no contacts — but Slice 8 onward is unusable without seeding, and Slice 13 owns the script.
