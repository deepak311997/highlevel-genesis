# Slice 01 — Account & session · Build log

**Branch:** `slice/01-account-session` · **Started:** 2026-08-15

Baseline before T1: suite green — 4 functions unit, 25 frontend unit, 5 rules, typecheck
and lint clean.

Proceeding on the plan's stated assumptions for B1–B5, which are unanswered: full scope,
PR-A/PR-B split, Identity Platform assumed off (policy enforced in our own Zod schema),
sender address as a constant, e2e out of CI for now.

---

## Phase 1 — pure logic

### T1 — Redirect validation → AC-26, AC-27
**Tests:** `frontend/src/lib/redirect.spec.ts` (22, L1) — hostile-input table, storage round trip.
**Red:** module unresolved.
**Deviation:** the plan implied a denylist of dangerous characters. Written as an
**allowlist** instead — an unanticipated character is then rejected by default rather than
needing to be enumerated. This also fixed a real problem: the first denylist attempt put
literal C0 control bytes in the source and `file` reported it as binary.

### T2 — Auth schemas and password policy → AC-4, AC-5
**Tests:** `functions/src/auth/schema.spec.ts` (23, L1).
**Note:** email is trimmed and lower-cased *before* validation, so the value reaching the
Admin SDK is the value the throttle hashed. Without that, changing case would fork one
account into two registrations and hand an attacker a fresh throttle budget per spelling.

### T3 — Redacting logger → AC-49
**Tests:** `functions/src/lib/log.spec.ts` (24, L1), `functions/src/lib/errors.spec.ts` (3, L1).
**Red:** `errors.spec.ts` failed against the existing `console.error('Unhandled error', err)`,
which logged a payload containing `hunter2`. The vulnerability the AC describes was real in
the Slice 0 code, not hypothetical.
**Deviation:** the plan's refactor step said "wire into `errorHandler`". Added
`errors.spec.ts` — a test file the plan did not list — because changing that behaviour
untested would have been the wrong trade.

### T4 — SMTP2GO transport → AC-8
**Tests:** `functions/src/lib/email/smtp2go.spec.ts` (13, L1).
**Deviation:** the VoiceSquad original carries an SMTP fallback alongside the REST client.
Dropped — a second code path that only runs when the first is misconfigured is a path
nothing tests.
**Note:** failures log an HTTP status and the error's class name, never the provider's
message. Our API key is in scope for that call and provider errors have been known to echo
the request.

### T5 — Transport selection → AC-10, part of AC-44
**Tests:** `functions/src/lib/email/index.spec.ts` (10, L1), plus an L3 denial test for
`_devMail` in `tests/rules/firestore.spec.ts`.
**Note:** the `_devMail` L3 test is green before its rule block exists, because rules deny by
default. Recorded as a regression pin rather than a red-green cycle — it is what fails the
day someone adds a broad `match /{document=**}`.

### T6 — Throttle arithmetic → AC-46 (pure half)
**Tests:** `functions/src/auth/throttle.spec.ts` (13, L1).
**Note:** a refused attempt leaves the counter untouched. Incrementing on refusal would let
an attacker hold a victim's address locked out indefinitely by hammering it.

### T7 — Email templates → supports AC-1, AC-2, AC-3
**Tests:** `functions/src/lib/email/templates.spec.ts` (9, L1).
**Red:** the "didn't create this account" assertion failed because a single escaper was
quote-escaping text nodes. Split into `escapeText` and `escapeAttr` — quotes only need
neutralising inside an attribute — rather than relaxing the assertion.

**Phase 1 status:** 99 functions unit tests, 47 frontend unit tests, 6 rules tests. Green.

---

## Phase 2 — rules

### T8 — Firestore rules rewrite → AC-37…AC-44
**Tests:** `tests/rules/firestore.spec.ts` (17, L3).
**Red:** 8 of the 17 failed against the old rules — the unverified-owner denial, both create
constraints, all three update constraints, delete, and the `authThrottle` denial.

---

## Phase 3 — functions

### T9 — L4 harness (config; could not start red, as the plan flagged)
`tests/integration/{vitest.config.mts,helpers.ts}`, `test:integration` script,
`auth`/`functions`/`ui` emulators added to `firebase.json`.
**Deviation:** added `firebase-admin` as a **root dev dependency**. The plan said no new
runtime packages; this is dev-only, needed because assertions like "is this account
verified?" have no client-SDK equivalent.
**Note:** verified empirically that shell env reaches the functions runtime, so
`FIRESTORE_DATABASE_ID` and `APP_BASE_URL` are passed inline by the npm script. The suite
therefore needs no `functions/.env` and runs on a fresh clone — which matters because
`.env.*` is broadly gitignored.

### T10 — Register: new address → AC-1
**Tests:** `tests/integration/auth-register.spec.ts` (4, L4), `functions/src/auth/links.spec.ts` (9, L1).
**Red:** 404 — route absent.
**Deviation:** added `auth/links.ts`, not in the file map. Firebase's generated links point at
its own hosted handler; D9 wants our `/auth/action`. Extracting the code and re-hosting it
avoids a console setting a reviewer would have to replicate.

### T11/T12 — Register: existing address → AC-2, AC-3 · **PLAN AMENDMENT**

R4 resolved, and **the plan's assumption was wrong**. D18a called for replacing the password
on a repeat registration and issuing a fresh link "invalidating earlier ones". Measured:

- Generating a new verification link does **not** retire the previous one.
- Neither does deleting the account. A probe confirmed a code minted for a **deleted** uid
  still applied successfully and verified the *replacement* account — codes resolve by
  address, not by uid.

So D18a is not implementable as written. Two options were available: build a parallel
token system we control, or change the rule. Chose the latter:

> **A registration request never changes anything about an account that already exists.**
> It only mails a reset link, which is useful solely to whoever holds the mailbox.

Both orderings of the pre-hijacking attack end safely — attacker-first, the victim resets to
their own password before any link can activate the attacker's; victim-first, the attacker's
registration changes nothing and the reset link lands in the victim's mailbox. This is
stronger than D18a on the point that matters: a registration can never alter an account it
does not control. It also collapses the verified and unverified branches into one behaviour.

An activation link in the unverified branch would have been the attack rather than the
defence — it lets whoever submitted the form activate an account whose password someone else
set.

**Residual, unchanged from discovery:** a victim who clicks a verification link for an
account they never registered still activates it under the attacker's password. Mitigated by
the D18c warning line (shipped, T7) and the 24h cleanup (T30, PR-B).

A `platform behaviour` test pins the non-supersession so this fails loudly if Firebase
changes.

**Tests:** 14 L4 in `auth-register.spec.ts`.
**Discovery/PRD needing update at review:** D18a's wording, and AC-3's "the previously issued
link no longer verifies" — now provably false on this platform.

**Phase 3 status so far:** 108 functions unit, 47 frontend unit, 17 rules, 14 integration. Green.

---

## Phase 3 — functions (continued)

### T13 — Validation and transport failure → AC-4, AC-9
**Tests:** 6 more L4 in `auth-register.spec.ts`.
**Finding:** a body the Functions runtime cannot parse is refused **by the runtime**, with an
HTML error page, before this Express app runs. An error handler mounted after
`express.json()` never sees it. A handler for that case was written, measured unreachable,
and removed — dead defensive code reads as protection that is not there. Where the request
does reach us (wrong content type), the JSON contract holds; both are pinned.
**Seam:** the fake transport refuses a designated address, so "the provider is down" is
exercised per-test without an environment flag.

### T14 — Resend and password reset → AC-32, AC-33
**Tests:** `tests/integration/auth-reset.spec.ts` (9, L4).
**Note:** `findUser()` turns "no such account" into `null` rather than a rejection. Letting
that reject propagate is exactly how a 500 on one branch and a 200 on the other becomes the
leak these endpoints exist to close.

### T15 — Throttle middleware → AC-46, AC-47, AC-48
**Tests:** `tests/integration/auth-throttle.spec.ts` (7, L4).
**Deviation:** implementation preceded its spec, inverting the cycle. Verified afterwards by
disabling the middleware — 5 of the 7 fail without it.
**Note:** attached per route, not via `router.use`. This router is mounted at both `/` and
`/api`, and prefix-matched middleware would count every attempt twice.

### T16 — CORS allowlist → AC-56 (proposed; still not in the PRD)
**Tests:** `tests/integration/auth-cors.spec.ts` (7, L4).
**Finding:** an allowlist inside the Express app was not enough. `firebase-functions` wraps
the handler in its own CORS layer *outside* the app, and left unset it reflects whatever
Origin it is given. `onRequest` now passes `cors: false`.

---

## Phase 4 — frontend infrastructure

### T17 — Emulator wiring by build mode → AC-54, AC-55
**Tests:** `frontend/src/lib/firebase.spec.ts` (2, L1), plus a build-artifact check.
**Verified against the real artifact:** the production bundle contains neither the emulator
port nor `connectAuthEmulator`.
**Deviation:** emulator config is substituted via Vite `define` rather than a `.env.emulator`
file, because `.env.*` is broadly gitignored. Mode is `emulator`, not `test`, so Vitest (which
runs as `test`) never opens a socket.

### T18/T20 — Auth store and profile write → AC-17, AC-24, AC-30, AC-35, AC-36, AC-45
**Tests:** `frontend/src/stores/auth.spec.ts` (15, L2).

### T19 — Three-state guard → AC-11, 12, 13, 16, 25, 28, 29, 31
**Tests:** `frontend/src/router/guard.spec.ts` (17, L2).

---

## Phase 5 — UI

### T21–T27 — Primitives, six views, router wiring, header
**Tests:** 63 L2 across `SignUpView`, `SignInView`, `VerifyEmailView`, `AuthActionView`,
`ForgotPasswordView`, `DashboardView`, plus `authApi.spec.ts`.
**Deviation:** the views were written implementation-first, with specs following, rather than
red-green per view.
**AC-6** is enforced two ways: an ESLint `no-restricted-imports` rule banning
`createUserWithEmailAndPassword`, `fetchSignInMethodsForEmail` and the two client-side email
senders, and a test that greps `src` for them — a lint rule can be disabled inline.

---

## Phase 6 — end to end

### T28 — Demo path → AC-13, AC-14, AC-21, AC-23, AC-55
**Tests:** `tests/e2e/auth.spec.ts` (2, L5).
**Snag:** the first run failed all four e2e tests because a stale dev server held port 5173
and `reuseExistingServer` let Playwright use it — so the tests ran against a non-emulator
build. Worth knowing: that failure mode looks like a broken app, not a broken harness.

---

## Phase 7 — hardening

### T30 — Expire unverified accounts → AC-52, AC-19
**Tests:** `tests/integration/auth-cleanup.spec.ts` (5, L4).
**Note:** the emulator has no scheduler, so the sweep is reachable through a route that exists
only under `FUNCTIONS_EMULATOR`. It takes `now` as input, which is precisely why it must not
exist in a deployed build.

### T32/T33 — CI, README, dependency removal
Integration and e2e now run on every PR — resolving open risk 11, since the L5 test is the
only one that exercises the D27 deadlock. `vuefire` removed (Slice 0 finding 5).

### T29, T31 — **Not done. Blocked on Firebase console access.**
App Check needs reCAPTCHA Enterprise registration; enumeration protection and the password
policy are console settings. See "Not covered" below.

---

## Deferred

- **AC-56 (CORS)** — proposed in the plan's coverage gaps, not yet added to the PRD. T16
  implements it; the criterion needs adding to `02-prd.md` at review.


---

## Acceptance-criteria coverage

Suite at close: **321 tests** — 252 unit (108 functions, 144 frontend), 17 rules,
48 integration, 4 e2e. `typecheck` and `lint` clean.

| AC | Proved by |
|---|---|
| 1 | `auth-register.spec.ts` — "creates the account unverified", "sends exactly one activation email" |
| 2 | `auth-register.spec.ts` — "responds byte-identically", "leaves the existing password alone" |
| 3 | **Amended** — see T11/T12. `auth-register.spec.ts` — "never changes the password of an account that already exists" |
| 4 | `schema.spec.ts` + `auth-register.spec.ts` — "rejects a weak password identically for an address that does exist" |
| 5 | `schema.spec.ts` + `auth-register.spec.ts` — "rejects a malformed address" |
| 6 | `authApi.spec.ts` — source scan for four banned calls; ESLint `no-restricted-imports` |
| 7 | `SignUpView.spec.ts` — submitting / field-error / failure / success |
| 8 | `smtp2go.spec.ts` — URL, header, payload, `succeeded` handling |
| 9 | `auth-register.spec.ts` "the mail provider is down" + `log.spec.ts` |
| 10 | `email/index.spec.ts` — five env vars proven unable to select the fake |
| 11, 12, 16, 29 | `guard.spec.ts` — three-state matrix |
| 13 | `guard.spec.ts` "lets an unverified user reach the action handler" + e2e |
| 14 | `VerifyEmailView.spec.ts` "refreshes the token before releasing" + e2e |
| 15, 20 | `VerifyEmailView.spec.ts` |
| 17 | `VerifyEmailView.spec.ts` "lets someone signed in as the wrong account get out" |
| 18 | `AuthActionView.spec.ts` — expired vs spent vs unknown mode |
| 19 | `auth-cleanup.spec.ts` "retires the activation link" + `AuthActionView.spec.ts` |
| 21, 23 | `SignInView.spec.ts` + e2e (reload) |
| 22 | `SignInView.spec.ts` — four codes, one message |
| 24, 30 | `stores/auth.spec.ts` + e2e |
| 25, 28, 31 | `guard.spec.ts` + `stores/auth.spec.ts` (`ready`) |
| 26, 27 | `redirect.spec.ts` — 14 hostile inputs; `SignInView.spec.ts` |
| 32, 33 | `auth-reset.spec.ts` |
| 34 | `ForgotPasswordView.spec.ts` |
| 35, 36, 45 | `stores/auth.spec.ts` + `firestore.spec.ts` |
| 37–44 | `firestore.spec.ts` — 17 rules tests, denials first |
| 46, 47, 48 | `throttle.spec.ts` + `auth-throttle.spec.ts` |
| 49 | `log.spec.ts` + `errors.spec.ts` |
| ~~52~~ | ~~`auth-cleanup.spec.ts`~~ — **moved to Not covered; see the review.** The function is tested, but no trigger is deployed |
| 54 | `firebase.spec.ts` + production build artifact grep |
| 55 | e2e runs under `emulators:exec` with no credentials |
| 56 | `auth-cors.spec.ts` — proposed in the plan, still not in the PRD |

### Not covered — the slice is not complete

| AC | Why |
|---|---|
| ~~**50, 51**~~ | ✅ **Done during the review, 2026-08-16.** The console was never the whole blocker — there was simply no App Check code on either side. reCAPTCHA v3 is configured, the key is in `frontend/.env`, and enforcement now lives in `functions/src/auth/appCheck.ts` (middleware, ahead of the throttle) with the client half in `frontend/src/lib/appCheck.ts`. No Playwright debug token was needed: the emulator has no App Check service, so the middleware bypasses on `FUNCTIONS_EMULATOR` alone and e2e stays green without a second mechanism to keep in sync. See `05-review.md`. |
| ~~**53**~~ | ✅ **Confirmed 2026-08-16.** Enumeration protection enabled; password policy on **Require enforcement** with all four composition classes, min 8, max 50 — matching `schema.ts` and `password.ts` exactly. Console settings, so never automatable (PRD R2); evidence recorded in `05-review.md`. |
| **52, 19** | **Added by the review.** `deleteExpiredUnverifiedUsers` is written and unit- and integration-tested, but `518e86f` dropped the `onSchedule` export and nothing runs it in production. `auth-cleanup.spec.ts` reaches it through an emulator-only route, so a green suite proves the *function* works and says nothing about the *sweep* happening. AC-52 asserts the sweep; AC-19 depends on it having run. `functions/src/index.ts` documents the gap accurately — this table did not. |

Four, not three: AC-50/51 were closed during the review; AC-19/52 were added to this table
because the trigger they assert is not deployed. The rest need console or deploy access.

**What the cleanup gap costs.** It unships one of D18's four pre-hijacking mitigations: an
account an attacker registered at someone else's address no longer expires after 24h. What
still holds — rules deny an unverified token every read and write, and a registration
request can never alter an existing account — is the larger part of that defence, so this
is a real weakening rather than a hole. The residual is a victim talked into verifying an
account they did not create, and that window no longer closes on its own.

## Deviations from the plan, collected

1. **D18a is not implementable** — the largest amendment; see T11/T12.
2. `firebase-admin` added as a root **dev** dependency for the L4 harness.
3. `auth/links.ts` and `auth/mail.ts` added beyond the file map.
4. `errors.spec.ts` added; the plan's refactor step changed behaviour that had no test.
5. Emulator mode is `emulator`, not `test`, so Vitest never reaches an emulator.
6. E2E **added to CI**, against the B4 assumption — it is hermetic now, and it is the only
   test covering the D27 deadlock.
7. T15's implementation preceded its spec; verified after the fact by disabling it.
8. Phase 5 views were written implementation-first.


---

## Post-review rework — SMTP2GO removed

Raised by the project owner: no email domain available, and the provider flow looked like
over-engineering. It was.

**Firebase Authentication sends verification and password-reset email itself**, from
`noreply@<project>.firebaseapp.com`, with no domain to verify. The only email we could not
delegate was the "you already have an account" nudge — and dropping that one email removes
the entire provider. Recorded as **D31**, reversing D7 and D8.

**Deleted:** the SMTP2GO transport, the `EmailTransport` seam, the fake transport, all three
templates, `auth/links.ts`, `auth/mail.ts`, `/auth/resend`, `/auth/password-reset`, the
`_devMail` collection and its rule, and their tests. Roughly 700 lines net.

**Moved to the client SDK:** password reset (`sendPasswordResetEmail`, non-disclosing given
enumeration protection) and verification (`sendEmailVerification`, sent by the gate).

**The one structural consequence.** Registration cannot send the first verification email —
it runs through the Admin SDK, which only generates links, and Firebase's sender needs a
signed-in `currentUser`. So the gate sends it on first arrival, tracked on the store so a
remount does not send twice. Sign-up copy changed from "check your inbox" to "you can sign
in now", because the old copy would have been a lie.

**This strengthened D5.** Previously the register branches sent *different emails*, so the
branch was observable to whoever held the mailbox. Now nothing differs at all — an
integration test asserts zero codes issued on both branches. Registering someone else's
address also now mails them nothing, so the endpoint cannot be used to send unsolicited mail.

**Reversed my own guardrail:** the ESLint rule banning `sendEmailVerification` and
`sendPasswordResetEmail` from the frontend existed because two senders would have meant two
differently-branded emails. Firebase is the only sender now, so those are the intended path.
`createUserWithEmailAndPassword` and `fetchSignInMethodsForEmail` stay banned.

**e2e** now reads codes from the Auth emulator's `/emulator/v1/projects/{id}/oobCodes`
instead of `_devMail`, and rebuilds the URL against our own `/auth/action` route — which in
production requires the custom action URL set on the email template.

**Suite after the rework:** typecheck 0, lint 0, 235 unit, 16 rules, 34 integration, 4 e2e.

## Password policy — D23 reversed

The Identity Platform policy on the project requires uppercase, lowercase, numeric and
special, capped at 50. The code follows the console rather than diverging from it, because
that policy governs `confirmPasswordReset`, which runs client-side — a password our schema
accepted and the console refused would let someone sign up with a password they could never
set again on reset. Recorded as **D30**. `frontend/src/lib/password.ts` and
`functions/src/auth/schema.ts` both mirror it, and both assert the bounds explicitly so the
coupling to an unreadable console setting is visible where it would break.
