# Slice 01 — Account & session · Discovery

**Spec:** F1.1 (extended — see D5) · **Depends on:** Slice 0 · **Date:** 2026-08-15

## The demo

Sign up with an email and password, sign in before verifying and get held at a
verify-your-email gate that will not let you reach the dashboard, click the emailed link,
continue through to the dashboard, refresh and stay signed in, sign out — and repeating the
sign-up with the same address produces the identical "check your inbox" screen rather than
admitting the account exists.

## Decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Google SSO alongside email + password? | **Out.** Email + password only. | Day 1 also carries Slice 2, the plan's highest-risk slice. Google popup flows are awkward to e2e-test, and the assignment mandates only email + password. Settles `IMPLEMENTATION_PLAN.md` §8's open item. |
| D2 | Where does a signed-in user land? | **A placeholder `/dashboard`** showing the signed-in email and a sign-out control, plus signed-in state in the header. | Gives the route guard something real to protect. Slice 3 replaces the body with the project list; the shell stays. |
| D3 | Who writes `users/{uid}`? | **The client**, under strict allowlist rules. Server-derived state never lands here. | With no privileged fields in the document, rules *are* the enforcement layer — this is the intended Firestore-without-a-backend posture. See "Data shape" for the rule contract and D4 for the extra gate. |
| D4 | How is the unverified-user gate enforced? | **In Firestore rules** (`request.auth.token.email_verified == true`), not only by a client-side `signOut()`. | A client check is a courtesy an attacker can skip by holding the token. Putting it in rules makes it real, it is L3-testable, and it is what renders a pre-hijacked account inert (S1). |
| D5 | Sign-up copy when the address is already registered? | **The full email-based registration flow.** Every sign-up returns an identical "check your inbox" response; the email itself branches — activation link for a new address, "you already have an account, here's a reset link" for an existing one. | Generic UI copy alone is theatre: an attacker reads `EMAIL_EXISTS` off the Identity Toolkit response, not our form. Only a uniform server response closes the oracle. Scope cost was raised and reaffirmed. |
| D6 | Where does account creation happen? | **A Cloud Function using the Admin SDK.** The client never calls `createUserWithEmailAndPassword`. | Forced by D5 — the client SDK throws `auth/email-already-in-use` on the wire, so branching client-side closes nothing. |
| D7 | What sends the email? | **SMTP2GO REST API**, porting the transport shape from `VoiceSquad/backend-core/usecases/email_service.py` to TypeScript. Key in **Firebase Secret Manager**, never `.env` in source. | Already a proven integration the user operates; one API key, no SMTP configuration, trivial to stub from a fixture. |
| D8 | Does password reset stay client-side? | **No — it moves to the same function.** | The "you already have an account" email *is* a reset link. Leaving forgot-password on Firebase's client-side template would send two differently-branded emails for one action. Consolidating also makes reset non-disclosing for free. |
| D9 | Who handles the emailed action links? | **Our own SPA route `/auth/action`**, handling `mode=verifyEmail` and `mode=resetPassword` via `applyActionCode` / `confirmPasswordReset`. `mode` is validated against an allowlist, never passed through. | We already generate the links server-side for both flows, so Firebase's hosted handler buys nothing and looks unbranded in the Loom. One route, two modes. |
| D10 | Unauthenticated user hits a protected route? | **Redirect to `/signin?redirect=<path>`** and return there after sign-in. The guard waits for the first auth-state resolution before deciding; signed-in users hitting `/signin` bounce to `/dashboard`. See D19 for validation and D25 for the third guard state. | Without the resolution wait, every refresh of a protected page flashes the sign-in screen. Slice 3+ adds deep links worth returning to. |
| D11 | Email verification required before the dashboard? | **Yes** — a consequence of D5, reversing the earlier "no verification" leaning. Sign-in itself succeeds, then the user is **held at a blocking gate** before any application route. See D25 for the gate. | The activation link is the mechanism that makes the uniform response honest; without a verification gate, the flow is decorative. |
| D12 | Rate limiting on the register endpoint? | **Required, not deferred.** Per-email throttle primary, per-IP best-effort, in an Admin-SDK-only `authThrottle` collection. See D21. | `register` is public, unauthenticated, and sends email. Unthrottled it is an email-bomb and a cost vector. `PRODUCT_SPEC.md` F10.4 lists rate limiting as a bonus; here it is a precondition of shipping the endpoint at all. |
| D13 | Enumeration protection in the Firebase console? | **Required, and load-bearing.** Verify and enable before the slice ships. | Sign-in goes browser-to-Identity-Toolkit directly and we never see it, so D6 closes sign-up only. Without this, `user-not-found` still leaks on sign-in and `fetchSignInMethodsForEmail` leaks outright. Enabling it also changes sign-in error codes, so the client's error mapping is written against the *protected* behaviour. We never call `fetchSignInMethodsForEmail`. |
| D14 | Is a display name collected at sign-up? | **No.** Form is email + password only; `displayName` stays in the rules allowlist for later. | Nothing in Slices 1–13 reads it. Adding the field later costs one rule that is already written. |
| D15 | How do L5 tests run, given the app points at real Firebase? | **Restore Auth + Functions emulators for tests only**, selected by Vite **build mode** rather than a runtime flag, so a production bundle cannot contain emulator wiring. | Slice 0 removed emulator wiring from `frontend/src/lib/firebase.ts`. E2E must be hermetic and CI-runnable without secrets. |
| D16 | How does e2e read the emailed link? | **A fake transport** recording sent mail to an Admin-SDK-only collection the test reads back. SMTP2GO is never called in automated tests. Selection is gated per D21. | `CLAUDE.md`: external services are always stubbed from fixtures. Mechanics finalised in the tech plan. |
| D17 | Does `/health` stay public? | **Yes**, unchanged. | It is a diagnostic that predates auth. Locking it down belongs with Slice 13's deployment pass. |

### Security decisions

Added after a security pass over D1–D17. Findings are labelled **S1**–**S6**: S1→D18,
S2→D19, S3→D20, S5→D21, S6→D22. **S4** — that sign-in leaks through Identity Toolkit no
matter what our own endpoints do — is answered by D13 above, which the pass promoted from
housekeeping to load-bearing.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D18 | **S1** — account pre-hijacking: an attacker registers the victim's address, the victim clicks "verify", and the account becomes verified under the attacker's password. | **Keep the password field.** Mitigate with four measures: (a) a repeat registration for an existing *unverified* account overwrites the password and issues a fresh link, invalidating earlier ones; (b) unverified accounts are deleted after 24h by a scheduled function; (c) the verification email carries an explicit "if you didn't create this account, ignore this" line; (d) D4's rule gate stands. | Email + password at sign-up is the standard pattern and passwordless-set-via-link is a significant UX departure. The attack class is real (Sudhodanan & Paverd, 2022) but largely defused here: D4 makes an unverified account inert — every read and write is denied — and Firebase revokes refresh tokens on password change, so a victim's reset kills both the attacker's password and any live session. The residual window is a victim who clicks verify and has not yet reset. |
| D19 | **S2** — is the `?redirect=` target validated? | **Strict same-origin path allowlist.** Must begin with a single `/`; reject protocol-relative `//`, backslashes, and anything resolving to an unknown route. Falls back to `/dashboard`. | Unvalidated, `?redirect=https://evil.com` — or `//evil.com`, which passes a naive "starts with `/`" check — sends a freshly-authenticated user off-site. Pure-function check, so it gets an L1 test with hostile inputs. |
| D20 | **S3** — how is the throttle keyed? | **Per-email is primary and authoritative; per-IP is best-effort.** The email counter increments for addresses that do not exist, exactly as for ones that do. Emails are hashed before use as a key. | Behind Hosting the function reads `X-Forwarded-For`, which the client controls, so an IP-only throttle is bypassable by rotating the header. Incrementing only for real accounts would make the 429 itself the enumeration oracle D5 exists to close. |
| D21 | **S5** — how is the fake email transport selected? | **Runtime emulator detection** (`FUNCTIONS_EMULATOR`), never an env var or config flag. | D16's transport records live action links into Firestore. Selecting it by a settable flag means one misconfiguration writes real password-reset links into a database. `FUNCTIONS_EMULATOR` cannot be true in production. |
| D22 | **S6** — credentials in logs. | **Never log request bodies, passwords, `oobCode`s, or action links.** Errors are logged by code and by hashed email only; the error serialiser is written so a thrown Firebase error cannot carry the payload into Cloud Logging. | D6 routes plaintext passwords through our function, so any incidental body logging puts credentials in Cloud Logging. Covered by an explicit L1 test on the log helper. |
| D23 | Password policy, and where enforced? | **NIST SP 800-63B aligned:** minimum 8, at least 64 accepted, no composition rules, no forced rotation. Enforced **server-side via Firebase Auth's password policy**, with Zod validation on the form as the usability layer. | Passwords are set through Identity Toolkit, so client validation alone is bypassable by calling the API directly. Server-side enforcement is the only real one. Note: the password-policy setting is an Identity Platform feature — confirm the project's tier during build (open risk 7). Validation runs before any Auth call, so a weak-password rejection never depends on whether the address exists. |
| D24 | App Check on the auth endpoints? | **Yes — enforced on `/api/auth/*`.** Debug tokens configured for the emulator and Playwright runs. | The strongest available control against automated abuse of `register`, and it also covers the sign-in path we cannot otherwise throttle (S3, S4). Cost: reCAPTCHA Enterprise console setup a reviewer must replicate, and a real risk of silently breaking e2e — so debug-token wiring lands in the same commit as enforcement, not later. |
| D25 | How is an unverified user stopped from reaching the dashboard? | **A blocking gate route, `/verify-email`.** Sign-in completes and the session persists, but the router guard sends an authenticated-and-unverified user to the gate from *every* application route. The gate shows the address the link went to, a throttled resend, a "continue" control, and sign-out. Verified users hitting `/verify-email` bounce to `/dashboard`. Any pending `?redirect=` target survives the gate, so the user still lands where they meant to go. | Preferred over rejecting at the sign-in form: the user can resend, open the link in another tab, and continue without re-entering credentials. Letting the session exist is safe precisely because of D4 — an unverified token is denied every Firestore read and write, so the gate is a UX affordance layered over an enforcement boundary that already holds. The guard therefore has **three** states, not two: unauthenticated, authenticated-unverified, authenticated-verified. |
| D26 | Does the gate hold for non-browser callers? | **Every authenticated Cloud Function checks `email_verified` on the decoded ID token**, not merely that a token is present. Standing contract for Slices 2, 5 and 8. | D25 is a router guard, and a router guard stops nobody who calls the API directly with a valid token. D4 covers Firestore; this covers the function surface. Recorded here because Slice 1 is where the rule originates, and Slice 2's OAuth callback is the first endpoint that would otherwise inherit the gap. |
| D27 | Which routes does the gate **not** apply to? | **`/auth/action` is exempt in every auth state**, as are `/signin`, `/signup`, `/forgot-password` and `/verify-email` itself. Routes are classified explicitly — `public`, `auth-flow`, `protected` — rather than the guard defaulting to protection. | Without this the design deadlocks: the verification link lands on `/auth/action`, and an authenticated-unverified user — precisely who the link is for — would be bounced to the gate before `applyActionCode` could run, with no way to ever verify. An exemption list that is derived from route metadata, not hardcoded, is also what stops Slice 3+ from silently adding an unguarded route. |
| D28 | Session persistence? | **`browserLocalPersistence`** — Firebase's default, chosen rather than inherited. Session survives tab close and browser restart until explicit sign-out. | F1.1 requires persistence across refreshes; local persistence is the ordinary choice for a builder tool people leave open. Recorded because "we took the default" and "we decided" read identically in code, and a reviewer cannot tell which happened. |

## Explicitly out of scope

- Google SSO and any second auth provider → **stretch**, revisit Day 5 (D1)
- HighLevel connection, tokens, location name → **Slice 2**
- Projects list, real dashboard content → **Slice 3** (Slice 1 ships the placeholder)
- Profile editing UI (`displayName`), avatars → no slice yet; rules support it (D14)
- Breached-password screening (HIBP k-anonymity) → README improvements list; D23 covers policy only
- Account deletion, email change, MFA → not in `PRODUCT_SPEC.md`
- Generic cross-app error-state audit → **Slice 12**

## Edge cases to handle

- **Sign-up with an already-registered, verified address** — identical response and screen;
  the existing-account email arrives instead (D5). The password is **not** touched
- **Sign-up with an address registered but never verified** — overwrite the password with
  the new submission, issue a fresh link, invalidate earlier ones (D18). Do not create a
  second account, do not error
- **Sign-in before verifying** — sign-in succeeds, then the guard holds the user at
  `/verify-email`; Firestore rules deny independently (D4, D25)
- **Unverified user types `/dashboard` directly, or any future route** — guard redirects to
  the gate. The gate is the default destination for *any* protected route while unverified,
  not a special case of the dashboard
- **Unverified user reloads while sitting on the gate** — stays on the gate; the session
  persisted, so they are not bounced back to sign-in
- **User verifies in a second tab while the gate is open in the first** — the gate polls
  `user.reload()` on a modest interval and also offers an explicit continue control, so
  neither tab strands the user
- **Continue pressed before the claim refreshes** — the gate forces `getIdToken(true)`
  before navigating. Skipping this is the trap: the token still says
  `email_verified: false`, so the dashboard would load and then fail every Firestore read
  against D4 (open risk 6)
- **Verified user navigates to `/verify-email`** — bounced to `/dashboard`
- **Signing out from the gate** — supported, so a user who signed in as the wrong account is
  not stuck
- **Deep link plus gate** — `/signin?redirect=/projects/abc` → gate → verify → lands on
  `/projects/abc`, not `/dashboard` (D19 validation still applies). The target is held in
  `sessionStorage`, not only in the URL: verifying in the *same* tab navigates away to
  `/auth/action` and would otherwise lose it
- **Clicking the verification link while signed in and unverified** — `/auth/action` is
  guard-exempt, so `applyActionCode` runs. Without D27 this is a deadlock, not a nuisance
- **Clicking a link for an account the 24h cleanup already deleted** — the code resolves to
  no user; message is "That link is no longer valid — sign up again", not a raw error
- **Authenticated-but-unverified user navigates to `/signin` or `/signup`** — sent to the
  gate, not to `/dashboard`, so they are not bounced twice
- **Unverified caller hits a Cloud Function directly** — rejected on the decoded token's
  `email_verified` claim, independently of the router (D26)
- **Verification link reused, expired, or superseded** — `/auth/action` distinguishes
  already-verified (send them to sign-in) from expired or superseded (offer a resend)
- **Password reset link reused or expired** — same treatment on the `resetPassword` branch
- **Unverified account older than 24h** — deleted; the address is free to register again (D18)
- **First verified session ever** — `users/{uid}` does not exist; the client writes it. The
  write is idempotent and runs at the start of *every verified session*, so an interrupted
  sign-up self-heals. It must branch create-vs-update: the create rule requires `createdAt`,
  the update rule forbids it. It must **not** fire at sign-in, before the gate — the create
  rule requires `email_verified`, so an unverified write is denied by design (D3, D4, D25)
- **Just-verified user's first Firestore read** — the ID token still carries
  `email_verified: false` until refreshed; the verification path forces `getIdToken(true)`
  (open risk 6)
- **Refresh on a protected route** — guard waits for auth-state resolution, no sign-in flash (D10)
- **Deep link while signed out** — captured in `?redirect=` and honoured after sign-in, subject to D19
- **Hostile `?redirect=` value** — `//evil.com`, `https://evil.com`, `/\evil.com`, unknown
  route — all fall back to `/dashboard` (D19)
- **Verified user navigates to `/signin` or `/signup`** — bounced to `/dashboard`
- **Two tabs, sign out in one** — the other reacts to the auth-state change and redirects
- **Offline / Firebase unreachable** — sign-in surfaces a network error, not a credential error
- **Rate limit tripped** — 429 with a plain "try again in a few minutes" (D12)
- **App Check token missing or invalid** — request rejected before any Auth or email work (D24)

## Failure modes and what the user sees

| Failure | User sees | Retry? |
|---|---|---|
| Wrong password or unknown address | "Email or password is incorrect." Never distinguishes the two. | Yes, subject to throttle |
| Sign-up, any branch | "Check your inbox to finish setting up your account." Identical every time. | Resend, throttled |
| Password reset request, any address | "If an account exists for that address, we've sent a reset link." | Resend, throttled |
| SMTP2GO send fails | Registration still returns `{ ok: true }` — the response must not vary. Failure is logged server-side (by code, no payload — D22) and the user recovers via resend. | Via resend |
| Verification link expired or superseded | "That link is no longer valid." with a resend control. | Yes |
| Verification link already used | "Your email is already verified — sign in." | N/A |
| Unverified user reaches the gate | "Verify your email to continue" naming the address the link went to, with resend, continue, and sign-out controls. Not an error state — it is a normal step with its own screen. | Resend, throttled |
| Continue pressed but still unverified | "We can't see a verification yet — check your inbox, or resend the link." Stays on the gate. | Yes |
| Unverified caller hits a function directly | `403` with a generic message; the API never explains the gate. | After verifying |
| Rate limit tripped | "Too many attempts. Try again in a few minutes." | After the window |
| App Check rejection | Same generic "Something went wrong" — never explains the control. | Yes |
| Weak password | Inline field error before any Auth call, so it never depends on whether the address exists (D23). | Yes |
| Network failure / function down | "Something went wrong. Check your connection and try again." | Yes |
| Firestore write of `users/{uid}` fails | Sign-in still succeeds; the write retries on next sign-in. Never blocks the session. | Automatic |

Every new screen ships loading, empty, and error states per `IMPLEMENTATION_PLAN.md` §3.

## Data shape

**`users/{uid}`** — client-written, rules-enforced allowlist (D3):

```
{ email: string, displayName: string | null, createdAt: timestamp, updatedAt: timestamp }
```

Rule contract, replacing today's blanket `allow read, write: if isOwner(uid)`:

- `read` — owner only, and `request.auth.token.email_verified == true` (D4)
- `create` — owner, verified, `keys().hasOnly(['email','displayName','createdAt','updatedAt'])`,
  `createdAt == request.time`
- `update` — owner, verified, `diff(resource.data).affectedKeys().hasOnly(['displayName','updatedAt'])`,
  `updatedAt == request.time`
- `delete` — denied

**`authThrottle/{key}`** — Admin SDK only, `allow read, write: if false` (D12, D20). **One
document per key**, not one per request: an email key (`email:<hash>`, authoritative) and an
IP key (`ip:<hash>`, best-effort), each holding a counter and a window start. A request
increments both and is refused if either is over. Needs a TTL policy or a cleanup pass so it
does not grow unbounded.

**Test-mail collection** (D16) — Admin SDK only, written only when `FUNCTIONS_EMULATOR` is
set (D21). Name settled in the tech plan.

`hlConnections/{uid}` is untouched — it stays `allow read, write: if false` and remains
where all server-derived state belongs (D3).

## Contracts

All under the existing `/api` Hosting rewrite. Zod-validated at the boundary, App Check
enforced (D24). Every response is deliberately uniform across the exists / does-not-exist
branches.

```
POST /api/auth/register        { email, password }  → 200 { ok: true }
POST /api/auth/resend          { email }            → 200 { ok: true }
POST /api/auth/password-reset  { email }            → 200 { ok: true }
```

Non-200s are limited to causes that carry no existence signal: `400` invalid payload or
weak password (validated before any Auth call), `401` App Check failure, `429` throttled,
`500` unexpected. CORS is restricted to the app origin — these are same-origin through the
Hosting rewrite and must not be reachable with a wildcard origin.

Sign-in, sign-out, session persistence, and `/auth/action` stay in the client SDK — none of
them need to hide anything the API does not already hide.

**Routes**, classified by the metadata the guard reads (D27):

| Route | Class | Guard behaviour |
|---|---|---|
| `/`, `/health` | `public` | Always reachable (D17) |
| `/signup`, `/signin`, `/forgot-password` | `auth-flow` | Verified users → `/dashboard`; unverified → the gate |
| `/auth/action` | `auth-flow`, **always exempt** | Never redirected, in any auth state — this is what breaks the deadlock (D27) |
| `/verify-email` | the gate (D25) | Unverified only; verified users → `/dashboard` |
| `/dashboard` | `protected` | Unauthenticated → `/signin?redirect=`; unverified → the gate |

The guard resolves three states — unauthenticated, authenticated-unverified,
authenticated-verified — and routes declare their class rather than the guard defaulting to
protection, so a route added in Slice 3+ cannot end up silently unguarded.

**Authenticated endpoints** added from Slice 2 onward reject a decoded token whose
`email_verified` is false with `403` (D26). None exist in this slice; the contract is
recorded here because Slice 1 originates it.

**Scheduled:** an `onSchedule` function deletes unverified users older than 24h (D18).

## Open risks

1. **SMTP2GO sender identity.** Sending needs a verified sender domain. Reusing the
   VoiceSquad account's verified domain is the cheap path; a new domain needs DNS
   verification and could block the build. **Confirm before the tech plan.**
2. **Timing side-channel.** The two register branches do different work
   (`createUser` vs `getUserByEmail` + `generatePasswordResetLink`), so response times may
   differ measurably even though the payloads are identical. Constant-time is impractical
   here; accepted as residual risk, mitigated by D12's throttle and D24's App Check. Worth
   stating in the README rather than claiming a stronger guarantee than we have.
3. **Slice size.** D5–D9, D11, D12, D18, D24 and D25 roughly double Slice 1: a Cloud
   Function, an email transport, a secret, a verification route, a gate route with a
   three-state guard, a throttle, App Check, a scheduled cleanup, and their L4 tests — on
   Day 1, beside the plan's riskiest slice. Raised and reaffirmed. If Day 1 slips, the
   cheapest deferrals to Slice 12 are, in order: D18's scheduled cleanup, D12's throttle,
   D9's custom action route. D25's gate is **not** on that list — it is the blocker the user
   asked for and the visible half of D4.
4. **Emulator restoration** (D15) touches `frontend/src/lib/firebase.ts`, `firebase.json`
   and `playwright.config.ts`, all of which Slice 0 deliberately pointed at real Firebase.
   Build-mode selection is what keeps a dev or production build from reaching an emulator.
5. **App Check versus the test suite** (D24). Enforcement can silently break Playwright and
   the emulator path. Debug-token wiring ships in the same commit as enforcement, and the
   e2e suite is run before that commit is called green.
6. **Stale `email_verified` claim.** D4 reads the claim from the ID token, which does not
   update on its own — a just-verified user carries `email_verified: false` until the token
   refreshes. Now assigned to a specific place rather than left floating: D25's gate calls
   `user.reload()` then `getIdToken(true)` before it releases anyone to `/dashboard`. Get
   this wrong and the symptom is misleading — the dashboard loads, then every Firestore read
   fails with permission-denied. Deserves a named test of its own.
7. **Identity Platform tier.** D23's server-side password policy — and possibly D13's
   enumeration protection — are Identity Platform features. If the project is not upgraded,
   D23 degrades to client-side validation only, which is a material weakening. **Confirm the
   project's auth tier before the tech plan**; it is a console fact, not a repo fact.
8. **Superseding oob codes** (D18a). The mitigation assumes generating a new verification
   link invalidates the previous one for that user. If Firebase does not guarantee this,
   we store a per-attempt nonce and check it in `/auth/action`. **Verify empirically during
   the build** — do not assume.
9. **Fresh-clone setup versus the definition of done.** `IMPLEMENTATION_PLAN.md` §3 requires
   the project to run clean from a fresh clone. This slice adds four things a clone cannot
   provide: enumeration protection (D13), a password policy (D23), App Check registration
   (D24), and an SMTP2GO key with a verified sender (D7). None live in the repo. The honest
   answer is that the emulator path must stay fully runnable without any of them — App Check
   in debug mode, the fake transport per D21, policy enforced only client-side locally — and
   the README must state plainly which controls exist only in the deployed project. Worth
   settling in the PRD, because it changes what "runs clean" is allowed to mean.
10. **D23 and D24 have no automated coverage.** The Auth emulator enforces neither password
    policy nor App Check, so the only tests we can write cover our client-side validation
    and our debug-token wiring — not the controls themselves. They need manual verification
    against the real project, recorded as demo evidence rather than claimed as tested. Say
    so in the review; a green suite here does not mean these hold.
11. **E2E does not run in CI.** Slice 0 wired typecheck, lint, unit and rules; `npm test`
    deliberately excludes `test:e2e`, so the L5 test this slice adds — the one covering the
    gate, the deadlock in D27, and the token refresh in open risk 6 — would never run on a
    pull request. Pre-existing, but this is the first slice where the untested path is the
    slice's whole point. Either CI gains an emulator job or the PRD states that L5 is a
    local-only gate.
