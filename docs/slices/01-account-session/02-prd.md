# Slice 01 — Account & session · PRD

**Spec:** F1.1 (extended — see discovery D5) · **Branch:** `slice/01-account-session`
**Discovery:** `01-discovery.md` (28 decisions, 11 open risks) · **Date:** 2026-08-15

## Problem

Genesis has rails and a health check, and nothing else. There is no way to become a user:
no sign up, no sign in, no session, no identity for Firestore rules to scope against.
Every slice after this one — projects, chat, files, the HighLevel connection — is defined
in terms of "the authenticated user", so until that user exists, nothing else can be built.

## In scope

- Sign up, sign in, sign out, session persisting across refresh
- Server-side registration that does not disclose whether an address is already registered
- Email verification, delivered via SMTP2GO, with a blocking gate before any application route
- Password reset, through the same non-disclosing function
- A three-state route guard (unauthenticated / authenticated-unverified / verified)
- A placeholder `/dashboard` proving the guard protects something real
- `users/{uid}` written by the client under allowlist rules, plus `email_verified` enforced in rules
- Rate limiting on the auth endpoints
- Restoring the Auth and Functions emulators for tests only
- App Check on `/api/auth/*`, and a scheduled cleanup of stale unverified accounts

## Out of scope

| Deferred | Picked up by |
|---|---|
| Google SSO and any second provider | Stretch, Day 5 (D1) |
| HighLevel connection, tokens, location name | Slice 2 |
| Real dashboard content, project list | Slice 3 |
| Profile editing UI for `displayName` | No slice yet; rules already permit it (D14) |
| Breached-password screening (HIBP) | README improvements list (D23) |
| Account deletion, email change, MFA | Not in `PRODUCT_SPEC.md` |
| Cross-app error-state audit | Slice 12 |

## Proposed PR split

Writing the criteria out confirms discovery's open risk 3: this is **not one reviewable
PR**. It is roughly 40 files across six new screens, four Cloud Functions, a rules rewrite,
an email transport, and five levels of test. Proposed split, both halves vertical and
demoable:

- **PR-A — the flow works.** Everything a user touches, plus the throttle and the rules.
  Demo: the full golden path including the gate.
- **PR-B — the flow is hardened.** App Check, scheduled cleanup, the console-enforced
  controls and their manual evidence, CI. Demo: an unthrottled bot refused, a stale
  unverified account gone.

The throttle stays in PR-A deliberately — D12 calls it a precondition of shipping a public
email-sending endpoint at all, so PR-A must not merge without it. Every AC below is tagged
`[A]` or `[B]`. **This split needs your approval** (see Blocked, B5).

## User flow

1. Visitor opens `/dashboard`. Guard redirects to `/signin?redirect=/dashboard`.
2. Visitor follows "Create an account" to `/signup`, enters email and password.
3. Client validates the password against the policy, then `POST /api/auth/register`.
4. Function creates the Auth user (unverified) and emails an activation link. Screen shows
   "Check your inbox" — **identically** to what an already-registered address would show.
5. Visitor signs in at `/signin` before clicking the link. Sign-in succeeds; the guard sends
   them to `/verify-email`, not the dashboard.
6. The gate shows the address, a resend control, a continue control, and sign-out.
7. Visitor opens the emailed link → `/auth/action?mode=verifyEmail&oobCode=…`. The route is
   guard-exempt, so `applyActionCode` runs and the address is verified.
8. Gate detects verification (poll or continue), forces `getIdToken(true)`, and releases the
   user to `/dashboard` — or to the original `?redirect=` target.
9. Client writes `users/{uid}` on this first verified session.
10. Dashboard shows the signed-in email and a sign-out control. **Demo ends here:** refresh
    → still signed in; sign out → back to `/signin`.

## Data model

**`users/{uid}`** — client-written, rules-enforced (D3, D4):

```ts
{ email: string; displayName: string | null; createdAt: Timestamp; updatedAt: Timestamp }
```

Rules replace today's blanket `allow read, write: if isOwner(uid)`:

| Op | Condition |
|---|---|
| `read` | owner **and** `request.auth.token.email_verified == true` |
| `create` | owner, verified, `keys().hasOnly(['email','displayName','createdAt','updatedAt'])`, `createdAt == request.time` |
| `update` | owner, verified, `diff(resource.data).affectedKeys().hasOnly(['displayName','updatedAt'])`, `updatedAt == request.time` |
| `delete` | denied |

**`authThrottle/{key}`** — Admin SDK only, `allow read, write: if false`. One document per
key: `email:<sha256>` (authoritative) and `ip:<sha256>` (best-effort). Shape
`{ count: number; windowStart: Timestamp }`. A request increments both and is refused if
either is over. Needs a TTL policy (D12, D20).

**`_devMail/{id}`** — Admin SDK only, `allow read, write: if false`. Written **only** when
`FUNCTIONS_EMULATOR` is set (D21). Shape `{ to, subject, textBody, htmlBody, createdAt }`.

**`hlConnections/{uid}`** — unchanged, still `allow read, write: if false`. Regression-tested
here because the rules file is being rewritten.

No composite indexes required; every access is a document get by id.

## API contracts

All under the existing `/api` Hosting rewrite, region `asia-south1`. Zod-validated at the
boundary. CORS restricted to the app origin — never a wildcard.

### `POST /api/auth/register`

| | |
|---|---|
| Auth | None. App Check enforced `[B]` |
| Request | `{ email: string; password: string }` |
| Success | `200 { ok: true }` — **byte-identical** whether or not the address exists |
| Errors | `400` invalid payload or weak password · `401` App Check `[B]` · `429` throttled · `500` unexpected |

Behaviour by branch, all returning the same body:

- **New address** → `createUser({ emailVerified: false })`, `generateEmailVerificationLink`, send activation email
- **Existing, verified** → password untouched, `generatePasswordResetLink`, send "you already have an account" email
- **Existing, unverified** → `updateUser({ password })`, fresh verification link, prior links superseded (D18)

### `POST /api/auth/resend`

Request `{ email: string }` → `200 { ok: true }` always. Same error codes. Re-issues a
verification link for an unverified account; sends nothing for an address that does not
exist or is already verified — the response does not change either way.

### `POST /api/auth/password-reset`

Request `{ email: string }` → `200 { ok: true }` always. Same error codes. Sends a reset
link when the account exists; sends nothing otherwise.

### Scheduled: `cleanupUnverifiedUsers` `[B]`

`onSchedule`, daily. Deletes Auth users with `emailVerified === false` created more than 24h
ago. No HTTP surface.

### Client-SDK, not endpoints

Sign-in, sign-out, session persistence, `applyActionCode`, `confirmPasswordReset`. None of
them can hide anything `/api/auth/*` does not already hide, and D13's enumeration protection
is what closes sign-in.

### Standing contract (no endpoint in this slice)

Every authenticated Cloud Function from Slice 2 onward rejects a decoded token whose
`email_verified` is false with `403` (D26).

## Acceptance criteria

### Sign up

- **AC-1** `[A]` Given no account for `a@x.test`, when the user submits sign-up, then a
  `200 { ok: true }` is returned, an unverified Auth user exists, exactly one activation
  email is sent to that address, and the screen shows "Check your inbox".
- **AC-2** `[A]` Given a **verified** account for `a@x.test`, when the user submits sign-up
  with a different password, then the response body and status are identical to AC-1, the
  screen is identical, the stored password is **unchanged**, and the email sent is the
  "you already have an account" variant containing a reset link.
- **AC-3** `[A]` **Revised during the build — the original was not achievable.** It required
  "the previously issued link no longer verifies"; measured, Firebase retires no outstanding
  code, and deleting the account does not either. Now: given an **unverified** account for
  `a@x.test`, when sign-up is submitted again with a different password, then no second
  account is created, the stored password is **unchanged**, and the email sent is a reset
  link — never a fresh activation link, which would let whoever submitted the form activate
  an account whose password someone else set. See discovery D29.
- **AC-4** `[A]` Given a password that misses the policy — under 8 characters, over 50, or
  lacking an uppercase, lowercase, numeric or special character — when sign-up is submitted,
  then a `400` is returned with a field-level error, **no** Auth call is made and **no** email
  is sent, and this holds identically whether or not the address exists. Every failure returns
  the *same* message, so the error cannot report which rules a candidate already satisfies.
  *(Composition rules per discovery D30, which reverses D23.)*
- **AC-5** `[A]` Given a malformed email, when sign-up is submitted, then a `400` with a
  field-level error is returned and no Auth call is made.
- **AC-6** `[A]` The frontend bundle contains no call to `createUserWithEmailAndPassword`.
- **AC-7** `[A]` `/signup` renders a submitting state, a field-error state, and a
  request-failure state distinct from the success screen.

### Email transport

- **AC-8** `[A]` Given a message, when the SMTP2GO transport sends it, then it POSTs to
  `https://api.smtp2go.com/v3/email/send` with an `X-Smtp2go-Api-Key` header and a
  `{ sender, to, subject, text_body, html_body }` body, and reports success only when
  `data.succeeded >= 1`.
- **AC-9** `[A]` Given the transport throws or reports zero sends, when registration runs,
  then the endpoint still returns `200 { ok: true }` and the failure is logged without the
  request payload.
- **AC-10** `[A]` The fake transport is selected when `FUNCTIONS_EMULATOR` is set and the
  real one otherwise; no configuration value can select the fake transport in production.

### Verification gate

- **AC-11** `[A]` Given an unverified account, when the user signs in with correct
  credentials, then sign-in succeeds and the user lands on `/verify-email`, not `/dashboard`.
- **AC-12** `[A]` Given an authenticated-unverified session, when the user navigates directly
  to `/dashboard`, then they are redirected to `/verify-email`.
- **AC-13** `[A]` Given an authenticated-unverified session, when the user opens
  `/auth/action?mode=verifyEmail&oobCode=…`, then the route renders and applies the code — it
  is **not** redirected to the gate. *(The deadlock guard; see D27.)*
- **AC-14** `[A]` Given a valid verification link, when it is applied, then the account
  becomes verified, the gate forces a token refresh, and the user reaches `/dashboard` with
  no permission-denied error on the first Firestore read.
- **AC-15** `[A]` Given the account is still unverified, when "continue" is pressed, then the
  user stays on the gate and sees "We can't see a verification yet".
- **AC-16** `[A]` Given a verified session, when the user navigates to `/verify-email`, then
  they are redirected to `/dashboard`.
- **AC-17** `[A]` Given the gate, when sign-out is pressed, then the session is cleared and
  the user lands on `/signin`.
- **AC-18** `[A]` An expired or superseded code, an already-applied code, and a malformed
  `mode` each produce a distinct, non-technical message; `mode` outside the allowlist is
  rejected rather than passed through.
- **AC-19** `[B]` Given the 24h cleanup has deleted the account, when its verification link
  is opened, then the message is "That link is no longer valid — sign up again", not a raw
  Firebase error.
- **AC-20** `[A]` `/verify-email` shows the address the link was sent to, and renders
  loading, resend-in-flight, and error states.

### Sign in, session, guard

- **AC-21** `[A]` Given a verified account, when correct credentials are submitted, then the
  user lands on `/dashboard`.
- **AC-22** `[A]` A wrong password and an unregistered address produce the **same** message,
  "Email or password is incorrect".
- **AC-23** `[A]` Given a signed-in session, when the page is reloaded, then the user is
  still signed in and still on the same route.
- **AC-24** `[A]` Given a signed-in session, when sign-out is pressed, then the session is
  cleared and `/dashboard` is no longer reachable.
- **AC-25** `[A]` Given no session, when `/dashboard` is requested, then the user is sent to
  `/signin?redirect=%2Fdashboard` and, after signing in, lands on `/dashboard`.
- **AC-26** `[A]` Given a hostile `redirect` value — `//evil.com`, `https://evil.com`,
  `/\evil.com`, `javascript:alert(1)`, or a path matching no route — the user lands on
  `/dashboard` and is never navigated off-origin.
- **AC-27** `[A]` Given `?redirect=/health` captured before the gate, when verification
  completes **in the same tab**, then the user still lands on `/health`.
- **AC-28** `[A]` Given a signed-in session, when a protected route is reloaded, then the
  sign-in screen is never rendered, not even for one frame.
- **AC-29** `[A]` A verified user visiting `/signin` or `/signup` is sent to `/dashboard`; an
  authenticated-unverified user visiting either is sent to `/verify-email`.
- **AC-30** `[A]` Given two tabs signed in, when one signs out, then the other leaves the
  protected route without a manual reload.
- **AC-31** `[A]` `/` and `/health` remain reachable with no session (D17 regression).

### Password reset

- **AC-32** `[A]` A reset request for a registered address and for an unregistered one return
  identical status and body, and the screen shows "If an account exists for that address,
  we've sent a reset link" in both cases.
- **AC-33** `[A]` Given a valid reset link, when a new password is confirmed, then the new
  password signs in and the old one does not.
- **AC-34** `[A]` `/forgot-password` renders submitting, success, and failure states.

### `users/{uid}` and rules

- **AC-35** `[A]` Given a first verified session, when the app loads, then `users/{uid}`
  exists with exactly `email`, `displayName`, `createdAt`, `updatedAt`, and `createdAt`
  equals the server time of the write.
- **AC-36** `[A]` Given the document already exists, when a later verified session starts,
  then the write succeeds as an update and `createdAt` is unchanged.
- **AC-37** `[A]` A different signed-in user can neither read nor write `users/{uid}`.
- **AC-38** `[A]` An unauthenticated client can neither read nor write `users/{uid}`.
- **AC-39** `[A]` An authenticated user whose token carries `email_verified: false` can
  neither read nor write `users/{uid}`.
- **AC-40** `[A]` A create carrying any key outside the allowlist is rejected; a create whose
  `createdAt` is not `request.time` is rejected.
- **AC-41** `[A]` An update touching `email` or `createdAt` is rejected; an update of
  `displayName` alone is accepted.
- **AC-42** `[A]` `delete` on `users/{uid}` is denied to the owner.
- **AC-43** `[A]` `hlConnections/{uid}` remains unreadable and unwritable by its owner.
- **AC-44** `[A]` `authThrottle/{key}` and `_devMail/{id}` are unreadable and unwritable by
  any client, authenticated or not.
- **AC-45** `[A]` Given the `users/{uid}` write fails, when the session starts, then the user
  still reaches `/dashboard` and the failure does not surface as a blocking error.

### Rate limiting

- **AC-46** `[A]` Given the per-email limit is N per window, when N+1 registrations are
  submitted for the same address, then the last returns `429` with "Too many attempts".
- **AC-47** `[A]` The per-email counter increments identically for an address that exists and
  one that does not — the `429` boundary reveals nothing about existence.
- **AC-48** `[A]` Given a rotating `X-Forwarded-For`, when N+1 registrations are submitted for
  the same address, then the per-email limit still refuses the last one.

### Logging

- **AC-49** `[A]` The log helper redacts `password`, `oobCode`, action links, and whole
  request bodies; a thrown Firebase error carrying a payload does not put it in the log line.

### Hardening `[B]`

- **AC-50** `[B]` A request to `/api/auth/register` without a valid App Check token is
  rejected before any Auth call or email send.
- **AC-51** `[B]` The debug-token path lets the emulator and Playwright runs pass App Check.
- **AC-52** `[B]` The scheduled cleanup deletes unverified users older than 24h, and leaves
  verified users and unverified users younger than 24h untouched.
- **AC-53** `[B]` Email-enumeration protection and the password policy are confirmed enabled
  on the real project, with evidence recorded in the review. *(Console-enforced; see R2.)*

### CORS

- **AC-56** `[A]` Given a request carrying an `Origin` that is not on the allowlist, when it
  reaches any `/api` route, then no `Access-Control-Allow-Origin` header is returned; matching
  is exact, so neither a lookalike prefix nor a lookalike suffix is accepted. *(Proposed in
  the technical plan's coverage gaps and implemented in T16; folded into the PRD here.)*

### Build and infrastructure

- **AC-54** `[A]` A production build contains no emulator host wiring.
- **AC-55** `[A]` `npm run test:e2e` runs against the Auth, Functions and Firestore
  emulators with no real Firebase credentials and no network calls to SMTP2GO.

## Test matrix

| AC | Level | Test file | Asserts |
|---|---|---|---|
| 1, 2, 3 | L4 | `tests/integration/auth-register.spec.ts` | Response identical across branches; Auth state per branch; email variant sent |
| 4, 5 | L1 | `functions/src/auth/validate.spec.ts` | Zod schema rejects before any Auth call |
| 4 | L4 | `tests/integration/auth-register.spec.ts` | No Auth call, no email, for weak password on an existing address |
| 6 | L1 | `frontend/src/lib/auth.spec.ts` | Client auth module exposes no password-signup call |
| 7 | L2 | `frontend/src/views/SignUpView.spec.ts` | Submitting, field-error, failure, success states |
| 8 | L1 | `functions/src/lib/email/smtp2go.spec.ts` | URL, header, payload shape, `succeeded` handling |
| 9 | L4 | `tests/integration/auth-register.spec.ts` | Transport throws → still `200 { ok: true }` |
| 9, 49 | L1 | `functions/src/lib/log.spec.ts` | Redaction of password, oobCode, links, bodies |
| 10 | L1 | `functions/src/lib/email/index.spec.ts` | Transport selection keyed only on `FUNCTIONS_EMULATOR` |
| 11, 12, 16, 29 | L2 | `frontend/src/router/guard.spec.ts` | Three-state resolution per route class |
| 13 | L2 | `frontend/src/router/guard.spec.ts` | `/auth/action` exempt in every auth state |
| 13, 14 | L5 | `tests/e2e/auth.spec.ts` | Demo path: signup → gate → verify → dashboard |
| 14 | L2 | `frontend/src/views/VerifyEmailView.spec.ts` | `reload()` then `getIdToken(true)` before navigating |
| 15, 20 | L2 | `frontend/src/views/VerifyEmailView.spec.ts` | Still-unverified message; address shown; loading/error states |
| 17, 24, 30 | L2 | `frontend/src/stores/auth.spec.ts` | Sign-out clears state and notifies subscribers |
| 18 | L2 | `frontend/src/views/AuthActionView.spec.ts` | Expired / applied / bad-mode messages; mode allowlist |
| 19 | L4 | `tests/integration/auth-cleanup.spec.ts` | Code for a deleted user resolves to the "sign up again" branch |
| 21, 23 | L5 | `tests/e2e/auth.spec.ts` | Sign in, reload, still signed in |
| 22 | L2 | `frontend/src/views/SignInView.spec.ts` | Identical copy for both failure codes |
| 25, 26, 27 | L1 | `frontend/src/lib/redirect.spec.ts` | Hostile-input table; `sessionStorage` round trip |
| 25, 29 | L2 | `frontend/src/router/guard.spec.ts` | Capture and honour `?redirect=` |
| 28 | L2 | `frontend/src/router/guard.spec.ts` | No route resolution before first auth-state emission |
| 31 | L2 | `frontend/src/router/guard.spec.ts` | `/`, `/health` classed `public` |
| 32 | L4 | `tests/integration/auth-reset.spec.ts` | Identical response for known and unknown address |
| 33 | L4 | `tests/integration/auth-reset.spec.ts` | New password works, old fails |
| 34 | L2 | `frontend/src/views/ForgotPasswordView.spec.ts` | Submitting, success, failure states |
| 35, 36, 45 | L2 | `frontend/src/stores/auth.spec.ts` | Create-vs-update branch; failure does not block |
| 37–44 | L3 | `tests/rules/firestore.spec.ts` | Owner, stranger, anon, unverified, key allowlist, immutability, delete, sibling collections |
| 46, 47, 48 | L4 | `tests/integration/auth-throttle.spec.ts` | Limit boundary; identical for unknown address; IP rotation ineffective |
| 50, 51 | L4 | `tests/integration/auth-appcheck.spec.ts` | Missing token rejected; debug token accepted |
| 52 | L4 | `tests/integration/auth-cleanup.spec.ts` | Age and verified-state selection |
| 53 | Manual | `05-review.md` | Console evidence — no automated coverage possible (R2) |
| 54 | L1 | `frontend/src/lib/firebase.spec.ts` | Production build mode produces no emulator connect call |
| 55 | L5 | `tests/e2e/auth.spec.ts` | Suite green with emulators only |

L4 is a new level for this repo — Slice 0's review recorded it as having no cases. It needs
`tests/integration/vitest.config.mts` and an `emulators:exec` script, mirroring
`tests/rules/`.

**L5 is one file, one demo path** (AC-13, 14, 21, 23, 55), per `IMPLEMENTATION_PLAN.md` §2.

## Definition of done

From `IMPLEMENTATION_PLAN.md` §3:

- [ ] Every AC above maps to a named, passing test (except AC-53, manual by necessity)
- [ ] `typecheck`, `lint`, `test:unit`, `test:rules`, `test:e2e` all green
- [ ] New collections (`authThrottle`, `_devMail`) have rules **and** rules tests
- [ ] F8 error paths handled for this slice's surface
- [ ] Loading, empty, and error states on all six new screens
- [ ] No secrets in source; `.env.example` updated
- [ ] Runs clean on emulators from a fresh clone — **scope qualified by B3**
- [ ] README delta written
- [ ] PR opened with demo evidence; human approves before merge

Slice-specific:

- [ ] `frontend/.env.example` and `functions/.env.example` list `SMTP2GO_API_KEY`, the
      sender address, and the App Check site key, all without values
- [ ] Manual evidence recorded for AC-53 and for the D18a oob-code supersession check
- [ ] No `createUserWithEmailAndPassword` anywhere in `frontend/`

## Risks

**R1 — Slice size.** Addressed by the PR split above; unresolved until B5 is answered.

**R2 — Two controls cannot be tested.** The Auth emulator enforces neither App Check nor the
password policy, so AC-50/51 cover our wiring and AC-53 cannot be automated at all. The
review must say plainly that a green suite does not demonstrate these hold.

**R3 — Timing side-channel remains.** The three register branches do measurably different
work. The bodies are identical; the response times are not. Mitigated by the throttle and
App Check, not eliminated. The README states this rather than claiming uniformity.

**R4 — oob-code supersession is assumed.** AC-3 depends on a new verification link
invalidating the previous one. If Firebase does not guarantee it, a per-attempt nonce is
needed and AC-3's implementation changes. Verify before building AC-3.

**R5 — App Check can silently break e2e.** AC-51 exists precisely to catch it, and ships in
the same commit as AC-50.

## Blocked

Discovery left five items that need your answer. None block starting PR-A's early tasks, but
each blocks a specific criterion.

- **B1 — SMTP2GO sender identity.** Which verified sender address should Genesis send from?
  Reusing the VoiceSquad account's verified domain is the cheap path. Blocks AC-1.
- **B2 — Identity Platform tier.** Is the Firebase project upgraded? If not, D23's password
  policy cannot be enforced server-side and degrades to client-side validation only — a real
  weakening, and AC-53 changes to "confirmed unavailable". Blocks AC-53.
- **B3 — What "runs clean from a fresh clone" means now.** Four controls live in the console,
  not the repo. Proposal: the emulator path stays fully runnable without any of them, and the
  README states which controls exist only in the deployed project. Blocks the DoD checkbox.
- **B4 — E2E in CI.** `npm test` excludes `test:e2e`, so the L5 test covering the gate and
  the D27 deadlock would never run on a PR. Add an emulator job to CI, or accept L5 as a
  local-only gate and say so? Blocks AC-55's value.
- **B5 — Approve the PR split.** One PR of ~40 files, or PR-A then PR-B?
