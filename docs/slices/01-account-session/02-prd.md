# Slice 01 — Account & session · PRD

**Spec:** F1.1 (extended — see discovery D5) · **Branch:** `slice/01-account-session`
**Discovery:** `01-discovery.md` (31 decisions, 11 open risks) · **Date:** 2026-08-15
**Revised:** 2026-08-16 by the Slice 1 review — see below.

> ### Revision note — what this PRD got wrong
>
> The build reversed three of its own premises, and this document was not kept in step. It
> is the contract the review audits against, so criteria that can never pass make the audit
> unreliable. Corrected here rather than rewritten, because the decision trail only reads
> correctly against the criteria it reversed.
>
> | What changed | Consequence for this PRD |
> |---|---|
> | **D31 — no mail provider.** Firebase Auth sends verification and reset mail itself; SMTP2GO, the `EmailTransport` seam, the fake transport, the templates and `_devMail` were all deleted in `9132424`. | AC-8 and AC-10 are dead; AC-9's transport half is dead and its logging half survives. `/api/auth/resend` and `/api/auth/password-reset` no longer exist. The `_devMail` collection no longer exists. |
> | **D29 — Firebase retires no outstanding oob code.** Measured against the emulator. | AC-3 was rewritten during the build (already reflected below). **R4 is closed** — the supersession assumption it hedged proved false, and the design changed rather than the assumption holding. |
> | **`518e86f` dropped the scheduled cleanup trigger.** The function is written and tested; nothing runs it. | **AC-52 is not met, and AC-19 depends on it.** Both moved to "not covered" in `04-build-log.md`. |
> | **App Check was never written.** Deferred as "needs console registration"; reCAPTCHA v3 was configured on 2026-08-16 and the key added to `frontend/.env`. | AC-50 and AC-51 became buildable and are implemented by the review — see `05-review.md` Finding 9. |
>
> **Six test-matrix rows pointed at files that do not exist** (`auth/validate.spec.ts`,
> `lib/auth.spec.ts`, `email/smtp2go.spec.ts`, `email/index.spec.ts`, `auth-reset.spec.ts`,
> `auth-appcheck.spec.ts`). Corrected in the matrix.

## Problem

Genesis has rails and a health check, and nothing else. There is no way to become a user:
no sign up, no sign in, no session, no identity for Firestore rules to scope against.
Every slice after this one — projects, chat, files, the HighLevel connection — is defined
in terms of "the authenticated user", so until that user exists, nothing else can be built.

## In scope

- Sign up, sign in, sign out, session persisting across refresh
- Server-side registration that does not disclose whether an address is already registered
- Email verification, ~~delivered via SMTP2GO~~ **sent by Firebase Auth (D31)**, with a
  blocking gate before any application route
- Password reset, ~~through the same non-disclosing function~~ **through the client SDK,
  non-disclosing because enumeration protection is enabled (D31)**
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

~~**`_devMail/{id}`**~~ — **deleted with the mail provider (D31).** The collection no longer
exists and has no rule of its own; deny-by-default covers it, which is what AC-44 now
verifies. The principle it carried — emulator-only behaviour is selected by
`FUNCTIONS_EMULATOR` alone, never by a config value (D21) — is still live, and its surviving
users are the test-only cleanup route and the App Check bypass.

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

### ~~`POST /api/auth/resend`~~ · ~~`POST /api/auth/password-reset`~~ — **both deleted (D31)**

Both existed only to route mail through our own provider. Firebase Auth sends verification
and reset mail itself, so the gate calls `sendEmailVerification` and the forgot-password
screen calls `sendPasswordResetEmail`, both client-side. Reset stays non-disclosing because
email-enumeration protection is enabled on the project (D13), not because we proxied it.

### Scheduled: `cleanupUnverifiedUsers` `[B]` — **written, not deployed**

`onSchedule`, daily. Deletes Auth users with `emailVerified === false` created more than 24h
ago. No HTTP surface.

> ⚠️ **`518e86f` dropped the trigger.** `deleteExpiredUnverifiedUsers` is implemented and
> tested, but no `onSchedule` export exists, so the sweep never runs in production. AC-52
> asserts the sweep and is therefore **not met**; AC-19 depends on it having run. The
> integration test reaches the function through an emulator-only route, so a green suite
> proves the function and says nothing about the schedule. `functions/src/index.ts` carries
> the full note, including what the gap costs against D18.

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

> **⚠️ Retired by D31 — AC-8, AC-9 and AC-10 below are dead criteria.** Genesis has no mail
> provider: Firebase Authentication sends the verification and reset email itself. The
> SMTP2GO transport, the `EmailTransport` seam, the fake transport and the `_devMail`
> collection were all deleted in `9132424`, so nothing in this subsection can pass or fail.
> They are left in place rather than deleted because the decision trail (D7 → D8 → D31) only
> reads correctly against the criteria it reversed. **AC-9's surviving half** — a mail
> failure must not turn registration into a non-`200` — is now vacuous for the same reason:
> registration sends no email at all. Recorded by the Slice 1 review.

- **AC-8** `[A]` ~~Given a message, when the SMTP2GO transport sends it, then it POSTs to
  `https://api.smtp2go.com/v3/email/send` with an `X-Smtp2go-Api-Key` header and a
  `{ sender, to, subject, text_body, html_body }` body, and reports success only when
  `data.succeeded >= 1`.~~ **Dead — no transport exists.**
- **AC-9** `[A]` ~~Given the transport throws or reports zero sends, when registration runs,
  then the endpoint still returns `200 { ok: true }` and~~ the failure is logged without the
  request payload. **The logging half survives and is covered by `log.spec.ts`; the
  transport half is dead.**
- **AC-10** `[A]` ~~The fake transport is selected when `FUNCTIONS_EMULATOR` is set and the
  real one otherwise; no configuration value can select the fake transport in production.~~
  **Dead — but the principle it protected is still live and still tested:** emulator-only
  behaviour is selected by `FUNCTIONS_EMULATOR` alone, never by config. The surviving user
  of that rule is the test-only cleanup route in `functions/src/auth/index.ts`.

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
| 4, 5 | L1 | `functions/src/auth/schema.spec.ts` *(was `validate.spec.ts`)* | Zod schema rejects before any Auth call |
| 4 | L4 | `tests/integration/auth-register.spec.ts` | No Auth call, no email, for weak password on an existing address |
| 6 | L1 | `frontend/src/lib/authApi.spec.ts` *(was `lib/auth.spec.ts`)* | `BANNED` list — client auth module exposes no password-signup call |
| 7 | L2 | `frontend/src/views/SignUpView.spec.ts` | Submitting, field-error, failure, success states |
| ~~8~~ | — | — | **Dead (D31)** — no transport exists |
| ~~9~~ | — | — | **Dead (D31)** — registration sends no email, so there is no send to fail |
| 9, 49 | L1 | `functions/src/lib/log.spec.ts` | Redaction of password, oobCode, links, bodies; **and that no field names the registration branch** (review Finding 1) |
| ~~10~~ | — | — | **Dead (D31).** The surviving principle is exercised by `appCheck.spec.ts` and the test-only cleanup route |
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
| 32 | L2 | `frontend/src/views/ForgotPasswordView.spec.ts` *(was `auth-reset.spec.ts`, L4)* | Identical screen for known and unknown address — the endpoint it tested no longer exists (D31); Firebase's own enumeration protection is what makes this hold |
| 33 | L5/manual | — | **Not automated.** Reset now runs entirely through the client SDK against Identity Toolkit; the emulator's oob flow is covered by the e2e verification path, but "new password signs in, old one does not" is verified manually |
| 34 | L2 | `frontend/src/views/ForgotPasswordView.spec.ts` | Submitting, success, failure states |
| 35, 36, 45 | L2 | `frontend/src/stores/auth.spec.ts` | Create-vs-update branch; failure does not block |
| 37–44 | L3 | `tests/rules/firestore.spec.ts` | Owner, stranger, anon, unverified, key allowlist, immutability, delete, sibling collections |
| 46, 47, 48 | L4 | `tests/integration/auth-throttle.spec.ts` | Limit boundary; identical for unknown address; IP rotation ineffective |
| 50, 51 | L1 | `functions/src/auth/appCheck.spec.ts` *(was L4 `auth-appcheck.spec.ts`)* | Missing / malformed / rejected token → 401 before any Auth call; verified token passes; emulator bypasses. **L4 is impossible — the emulator has no App Check service to reject against** (PRD R2 again) |
| 52 | ⛔ | `tests/integration/auth-cleanup.spec.ts` | Tests the **function**, not the sweep. **AC-52 not met** — no trigger is deployed |
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

**R4 — oob-code supersession is assumed.** ✅ **Closed, and the assumption was false.**
Measured against the emulator: Firebase retires no outstanding code, and a code minted for a
*deleted* uid still verified the replacement account — codes resolve by address, not by uid.
AC-3 was rewritten to the stronger rule that a registration never alters an account that
already exists, and a `platform behaviour` test pins it so a Firebase change fails loudly.
See D29.

**R5 — App Check can silently break e2e.** AC-51 exists precisely to catch it, and ships in
the same commit as AC-50.

## Blocked

Discovery left five items that need your answer. None block starting PR-A's early tasks, but
each blocks a specific criterion.

- **B1 — SMTP2GO sender identity.** ✅ **Moot (D31).** There is no provider and no sender
  identity to choose; Firebase sends from `noreply@<project>.firebaseapp.com`.
- **B2 — Identity Platform tier.** ✅ **Answered by D30 and confirmed 2026-08-16.** The
  project is on Identity Platform, the policy is live and set to *Require enforcement* —
  minimum 8, maximum 50, all four composition classes — and `functions/src/auth/schema.ts`
  and `frontend/src/lib/password.ts` mirror it field for field. AC-53 closed; evidence in
  `05-review.md`.
- **B3 — What "runs clean from a fresh clone" means now.** Four controls live in the console,
  not the repo. Proposal: the emulator path stays fully runnable without any of them, and the
  README states which controls exist only in the deployed project. Blocks the DoD checkbox.
- **B4 — E2E in CI.** ✅ **Answered: added to CI** (`d789f96`), against this PRD's own
  assumption. It is hermetic, and it is the only test covering the D27 deadlock.
- **B5 — Approve the PR split.** ⛔ **Never answered, and the moment passed.** The branch
  landed as one change of **107 files, +8,415 / −779** — six times the review skill's
  ~1,000-line boundary, which is exactly what R1 predicted. Recorded so the same pressure is
  visible before Slice 2 starts rather than after.
