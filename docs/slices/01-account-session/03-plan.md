# Slice 01 — Account & session · Technical plan

**PRD:** `02-prd.md` (55 ACs) · **Branch:** `slice/01-account-session` · **Date:** 2026-08-15

**Assumptions**, since B1–B5 are unanswered. Each is cheap to revise; none block starting.

- **B5 assumed approved** — PR-A then PR-B. The task order below is identical either way;
  the split only decides where the PR boundary falls (after T26).
- **B1** — sender address `no-reply@` on a domain already verified in the SMTP2GO account.
  Only a constant changes if wrong.
- **B2** — Identity Platform assumed **not** enabled. T2 therefore enforces the password
  policy in our own Zod schema server-side, which works on either tier. If the project is
  upgraded, the console policy becomes a second layer rather than a replacement.
- **B3** — emulator path runs with no console setup; README states which controls are
  deployed-only.
- **B4** — e2e stays out of CI for now; T30 adds the job and is the first thing to cut.

## Approach

The API surface extends the Express app that already exists rather than introducing
callables: `createApiApp()` mounts routers at both `/` and `/api` to satisfy the emulator
and the Hosting rewrite, and it already has `asyncHandler` and a terminal `errorHandler`
worth reusing. An `authRouter` joins `healthRouter` there. Everything that can be a pure
function is one — redirect validation, the password schema, log redaction, the SMTP2GO
payload builder, throttle-window arithmetic — so the majority of the ACs are L1-testable
with no Firebase in the loop, and the emulator-bound L4 tests are reserved for the three
register branches, the throttle, and reset. Email delivery sits behind an `EmailTransport`
interface with two implementations chosen by `FUNCTIONS_EMULATOR`, which is what makes both
the e2e link-reading and D21's production safety fall out of the same seam. On the frontend
a Pinia auth store owns `onAuthStateChanged` and exposes a `ready` promise, and the router
guard reads a `meta.access` class off each route — the guard never guesses.

**Alternatives that lost:**

- *Callable functions* — a second calling convention, and it abandons the existing error
  handler and dual-mount pattern for no gain.
- *vuefire's `getCurrentUser()`* — genuinely suited to the guard, but it needs the VueFire
  plugin and brings reactive Firestore bindings we do not use. A ~40-line store is explicit
  and trivially mockable in L2 guard tests. **Consequence:** `vuefire` then has no user at
  all and should be removed from `frontend/package.json`, closing Slice 0's finding 5 rather
  than letting it rot.
- *Guard protecting by default* — safer-sounding, but it is what produced the `/auth/action`
  deadlock (D27). Explicit per-route classes fail loudly instead.
- *Firebase's hosted action handler* — free, but unbranded in the Loom, and we generate the
  links ourselves anyway (D9).

## File map

### Functions — new

| File | What |
|---|---|
| `functions/src/auth/index.ts` | `authRouter`, mounts the three routes |
| `functions/src/auth/register.ts` | Three-branch registration (D5, D18) |
| `functions/src/auth/resend.ts` | Re-issue verification link |
| `functions/src/auth/reset.ts` | Password-reset link |
| `functions/src/auth/schema.ts` + `.spec.ts` | Zod schemas, password policy (D23) |
| `functions/src/auth/throttle.ts` + `.spec.ts` | Window arithmetic and the Firestore counter |
| `functions/src/auth/appCheck.ts` | App Check middleware `[B]` |
| `functions/src/lib/email/types.ts` | `EmailTransport`, `EmailMessage` |
| `functions/src/lib/email/smtp2go.ts` + `.spec.ts` | REST transport, ported from VoiceSquad |
| `functions/src/lib/email/devMail.ts` | Firestore-recording fake |
| `functions/src/lib/email/index.ts` + `.spec.ts` | Transport selection on `FUNCTIONS_EMULATOR` |
| `functions/src/lib/email/templates.ts` + `.spec.ts` | Activation, already-registered, reset bodies |
| `functions/src/lib/log.ts` + `.spec.ts` | Redacting logger (D22) |
| `functions/src/cleanup.ts` | Scheduled unverified-account sweep `[B]` |

### Functions — edited

| File | What |
|---|---|
| `functions/src/api/index.ts` | Mount `authRouter`; replace `cors({ origin: true })` with an origin allowlist |
| `functions/src/index.ts` | Export `cleanupUnverifiedUsers`; declare the `SMTP2GO_API_KEY` secret |
| `functions/.env.example` | `SMTP2GO_API_KEY`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, `APP_BASE_URL` |

### Frontend — new

| File | What |
|---|---|
| `frontend/src/stores/auth.ts` + `.spec.ts` | Session, `ready` promise, `users/{uid}` write |
| `frontend/src/lib/redirect.ts` + `.spec.ts` | Same-origin path validation (D19) |
| `frontend/src/lib/authApi.ts` + `.spec.ts` | Typed POSTs to `/api/auth/*` |
| `frontend/src/router/guard.ts` + `.spec.ts` | Three-state guard reading `meta.access` |
| `frontend/src/views/SignUpView.vue` + `.spec.ts` | |
| `frontend/src/views/SignInView.vue` + `.spec.ts` | |
| `frontend/src/views/ForgotPasswordView.vue` + `.spec.ts` | |
| `frontend/src/views/VerifyEmailView.vue` + `.spec.ts` | The gate (D25) |
| `frontend/src/views/AuthActionView.vue` + `.spec.ts` | `verifyEmail` / `resetPassword` (D9) |
| `frontend/src/views/DashboardView.vue` + `.spec.ts` | Placeholder (D2) |
| `frontend/src/components/ui/input/`, `label/`, `alert/` | Primitives that do not exist yet |

### Frontend — edited

| File | What |
|---|---|
| `frontend/src/router/index.ts` | Six routes, `meta.access` on all of them including `/` and `/health`, install guard |
| `frontend/src/lib/firebase.ts` | Emulator connect under `import.meta.env.MODE === 'test'` (D15) |
| `frontend/src/App.vue` | Signed-in email and sign-out in the header |
| `frontend/src/main.ts` | Await `authStore.ready` before `mount` |
| `frontend/eslint.config.js` | `no-restricted-syntax` banning `createUserWithEmailAndPassword` (AC-6) |
| `frontend/package.json` | Remove `vuefire` |

### Root — edited/new

| File | What |
|---|---|
| `firestore.rules` | `users` rewrite, `authThrottle`, `_devMail` |
| `tests/rules/firestore.spec.ts` | Rewritten for the new contract |
| `tests/integration/*.spec.ts`, `vitest.config.mts` | **New level.** Slice 0 left L4 with no cases |
| `tests/e2e/auth.spec.ts` | The demo path |
| `firebase.json` | `auth` and `functions` emulators restored |
| `package.json` | `test:integration`, emulator scripts |
| `.github/workflows/ci.yml` | Integration job; e2e job `[B]`, subject to B4 |

## Task list

Each task is one red-green-refactor cycle and one commit pair (`test:` then `feat:`).
Tasks that **cannot** start red are marked and explained — per the skill's ordering rules,
they are named rather than quietly skipped.

### Phase 1 — pure logic, no Firebase

**T1 — Redirect validation** → AC-26, AC-27
- **Red:** `frontend/src/lib/redirect.spec.ts` — a table of hostile inputs (`//evil.com`,
  `https://evil.com`, `/\evil.com`, `javascript:alert(1)`, `///`, `/dashboard`, unknown path)
  each asserting the resolved target.
- **Green:** `safeRedirect(raw, knownPaths)` returning `/dashboard` for anything not a known
  single-slash same-origin path.
- **Refactor:** add the `sessionStorage` store/consume pair the gate needs.

**T2 — Auth schemas and password policy** → AC-4, AC-5
- **Red:** `functions/src/auth/schema.spec.ts` — rejects malformed email, rejects a 7-char
  password, accepts 8, accepts 64+, applies no composition rule.
- **Green:** Zod schemas in `functions/src/auth/schema.ts`.
- **Refactor:** share the shape with the frontend form via an exported type.

**T3 — Redacting logger** → AC-49
- **Red:** `functions/src/lib/log.spec.ts` — a line built from an object containing
  `password`, `oobCode`, a link and a whole body contains none of those values; a thrown
  Firebase error carrying a payload does not leak it.
- **Green:** `logAuthEvent(code, { emailHash })` with an allowlist of loggable keys.
- **Refactor:** wire into `errorHandler` so unhandled errors use it too.

**T4 — SMTP2GO transport** → AC-8
- **Red:** `functions/src/lib/email/smtp2go.spec.ts` — stubbed `fetch` asserts URL, the
  `X-Smtp2go-Api-Key` header, the payload shape, `succeeded >= 1` → true, `0` → false, throw
  → false.
- **Green:** port `Smtp2GoClient` from `VoiceSquad/backend-core/usecases/email_service.py`.
- **Refactor:** extract `EmailTransport` in `types.ts`.

**T5 — Transport selection** → AC-10
- **Red:** `functions/src/lib/email/index.spec.ts` — fake iff `FUNCTIONS_EMULATOR` is set;
  no other variable can select it.
- **Green:** `getTransport()`.

**T6 — Throttle arithmetic** → AC-46 (pure half)
- **Red:** `functions/src/auth/throttle.spec.ts` — window rollover, boundary at N and N+1,
  hashing is stable and one-way.
- **Green:** pure `evaluate(counter, now)`; Firestore I/O stays out until T13.

**T7 — Email templates** → supports AC-1, AC-2, AC-3
- **Red:** `functions/src/lib/email/templates.spec.ts` — activation body contains the link
  and the "if you didn't create this account" line (D18c); already-registered body contains
  a reset link and no activation link.
- **Green:** three template builders.

### Phase 2 — rules

**T8 — Firestore rules rewrite** → AC-37 … AC-44
- **Red:** `tests/rules/firestore.spec.ts` — every denial case first (see below).
- **Green:** rules per the section below.
- **Refactor:** extract `verified()` alongside the existing `signedIn()` / `isOwner()`.

### Phase 3 — functions

**T9 — L4 harness** → enables everything in this phase
- **Cannot start red.** It is a vitest config, an `emulators:exec` script and a test-env
  helper; there is no behaviour to assert until T10 uses it. Proven by T10's red test
  failing for the right reason.
- **Green:** `tests/integration/vitest.config.mts` mirroring `tests/rules/`, plus
  `test:integration` in the root `package.json`, `fileParallelism: false`.

**T10 — Register: new address** → AC-1
- **Red:** `tests/integration/auth-register.spec.ts` — `200 { ok: true }`, unverified user
  exists, exactly one `_devMail` doc with the activation template.
- **Green:** `register.ts` happy path, `authRouter` mounted in `createApiApp`.

**T11 — Register: existing verified** → AC-2
- **Red:** response byte-identical to T10; password unchanged (old password still signs in);
  `_devMail` holds the already-registered template.
- **Green:** the `getUserByEmail` branch.

**T12 — Register: existing unverified** → AC-3
- **Red:** no second user; password replaced; new link works; **prior link no longer
  verifies**.
- **Green:** `updateUser({ password })` + fresh link.
- **Blocked on R4** — if Firebase does not supersede the prior oob code, this task also adds
  a per-attempt nonce checked in `/auth/action`. **Verify before writing the green step.**

**T13 — Register: validation and transport failure** → AC-4, AC-9
- **Red:** weak password on an *existing* address → `400`, no Auth call, no mail; transport
  throwing → still `200 { ok: true }` and a redacted log line.
- **Green:** validate-before-Auth ordering; swallow transport failure.

**T14 — Resend and password-reset** → AC-32, AC-33
- **Red:** `tests/integration/auth-reset.spec.ts` — identical response for known and unknown
  address; reset link sets a password that works while the old one fails.
- **Green:** `resend.ts`, `reset.ts`.

**T15 — Throttle middleware** → AC-46, AC-47, AC-48
- **Red:** `tests/integration/auth-throttle.spec.ts` — N+1 → `429`; identical boundary for an
  address that does not exist; rotating `X-Forwarded-For` does not raise the ceiling.
- **Green:** Firestore counter on T6's arithmetic, applied to all three routes.

**T16 — CORS allowlist** → **no AC covers this** (see gaps)
- **Red:** `tests/integration/auth-cors.spec.ts` — a disallowed `Origin` gets no
  `Access-Control-Allow-Origin`.
- **Green:** replace `cors({ origin: true })` in `api/index.ts` with an allowlist.

### Phase 4 — frontend infrastructure

**T17 — Emulator wiring by build mode** → AC-54, AC-55
- **Red:** `frontend/src/lib/firebase.spec.ts` — connect helpers called in `test` mode, not
  called otherwise.
- **Green:** guard the `connectAuthEmulator` / `connectFirestoreEmulator` calls on
  `import.meta.env.MODE`; restore `auth` and `functions` to `firebase.json`.

**T18 — Auth store** → AC-17, AC-24, AC-30, AC-45
- **Red:** `frontend/src/stores/auth.spec.ts` — `ready` resolves only after the first
  `onAuthStateChanged` emission; sign-out clears state; a `users/{uid}` write failure leaves
  the session intact.
- **Green:** Pinia store wrapping the Firebase SDK.

**T19 — Three-state guard** → AC-11, AC-12, AC-13, AC-16, AC-25, AC-28, AC-29, AC-31
- **Red:** `frontend/src/router/guard.spec.ts` — a matrix of {unauthenticated,
  authenticated-unverified, verified} × {`public`, `auth-flow`, `protected`,
  `/auth/action`, `/verify-email`}. **AC-13 and AC-28 are the two that matter**: the exempt
  route in the middle state, and no resolution before `ready`.
- **Green:** `guard.ts` reading `meta.access`; `meta` added to every route including `/` and
  `/health`.

**T20 — `users/{uid}` write** → AC-35, AC-36
- **Red:** create on first verified session with exactly the four keys; second session
  updates and leaves `createdAt` alone; **never attempted while unverified**.
- **Green:** create-vs-update branch in the store, called from the verified transition.

### Phase 5 — UI

**T21 — UI primitives** → supports Phase 5
- **Cannot start red.** `Input`, `Label` and `Alert` are presentational primitives matching
  the existing `Button`/`Card` house style; their behaviour is asserted by the view tests
  that consume them.

**T22 — SignUpView** → AC-6, AC-7
- **Red:** submitting / field-error / failure / success states; the success screen is
  reached identically for a `200` regardless of branch. Plus the ESLint rule for AC-6.
- **Green:** view + `authApi.register`.

**T23 — SignInView** → AC-21, AC-22
- **Red:** `auth/invalid-credential` and `auth/user-not-found` render the *same* string.
- **Green:** view + error mapping written against D13's protected behaviour.

**T24 — VerifyEmailView (the gate)** → AC-14, AC-15, AC-20
- **Red:** shows the address; continue while unverified keeps you there; **continue after
  verification calls `reload()` then `getIdToken(true)` before navigating** (open risk 6);
  resend in-flight and error states.
- **Green:** the gate, with a modest `reload()` poll.

**T25 — AuthActionView** → AC-18
- **Red:** expired, already-applied, and out-of-allowlist `mode` each produce a distinct
  non-technical message.
- **Green:** `applyActionCode` / `confirmPasswordReset` behind a mode allowlist.

**T26 — ForgotPasswordView** → AC-34
- **Red:** submitting, success, failure states; identical copy in all cases.

**T27 — Dashboard and header** → AC-23, AC-24
- **Red:** renders the signed-in email; sign-out clears and redirects.

### Phase 6 — end to end

**T28 — L5 demo path** → AC-13, AC-14, AC-21, AC-23, AC-55
- **Red:** `tests/e2e/auth.spec.ts` — sign up → gate → read the link from `_devMail` → verify
  → dashboard → reload → sign out. One test, per §2.
- **Green:** whatever integration bug it exposes.

### Phase 7 — hardening `[B]`

**T29 — App Check** → AC-50, AC-51 · **T30 — Scheduled cleanup** → AC-52, AC-19 ·
**T31 — Console controls, manual evidence** → AC-53 (not automatable) ·
**T32 — CI integration + e2e jobs** (config; subject to B4) ·
**T33 — `.env.example`, README delta, remove `vuefire`**

## Firestore rules changes

```
function verified() {
  return signedIn() && request.auth.token.email_verified == true;
}

match /users/{uid} {
  allow read: if isOwner(uid) && verified();
  allow create: if isOwner(uid) && verified()
    && request.resource.data.keys().hasOnly(['email','displayName','createdAt','updatedAt'])
    && request.resource.data.createdAt == request.time;
  allow update: if isOwner(uid) && verified()
    && request.resource.data.diff(resource.data).affectedKeys()
         .hasOnly(['displayName','updatedAt'])
    && request.resource.data.updatedAt == request.time;
  allow delete: if false;
}

match /authThrottle/{key} { allow read, write: if false; }
match /_devMail/{id}      { allow read, write: if false; }
```

L3 tests, denial cases first — an allow test passes against wide-open rules, which is the
existing file's stated principle:

| Test | AC |
|---|---|
| Stranger cannot read or write `users/alice` | 37 |
| Anonymous cannot read or write | 38 |
| Owner with `email_verified: false` cannot read or write | **39** |
| Create with an extra key rejected; `createdAt != request.time` rejected | 40 |
| Update touching `email` or `createdAt` rejected; `displayName` alone accepted | 41 |
| Owner cannot delete | 42 |
| `hlConnections/alice` still denied to its owner | 43 |
| `authThrottle` and `_devMail` denied to everyone | 44 |
| Verified owner can create then update | 35, 36 |

`authenticatedContext('alice', { email_verified: true })` supplies the custom claim.

## Dependencies

No new runtime packages. `zod` and `firebase-admin` are already in `functions`; `pinia` and
`firebase` are already in `frontend`. SMTP2GO is a REST call over the platform `fetch` — the
VoiceSquad implementation uses `httpx` only because Python has no built-in.

**Removed:** `vuefire` from `frontend/package.json` (see Approach).

**Secret:** `SMTP2GO_API_KEY` via `firebase functions:secrets:set`, declared on the `api`
function. Never in `.env` in source.

## Manual verification

1. `npm run emulators` (auth + firestore + functions), `npm run dev`.
2. `/dashboard` → bounced to `/signin?redirect=%2Fdashboard`.
3. Sign up. Screen says "Check your inbox".
4. Sign up **again**, same address, different password — the screen is indistinguishable.
5. Sign in → held at `/verify-email`, showing the address.
6. Read the link from the `_devMail` collection in the emulator UI; open it in the same tab.
7. Land on `/dashboard`, not `/signin` — and **no permission-denied in the console**, which
   is the open-risk-6 check.
8. Reload → still signed in. Sign out → `/signin`.
9. Submit sign-up 6× rapidly → `429`.
10. **Deployed only:** confirm enumeration protection and the password policy in the console;
    screenshot for AC-53.

## Coverage gaps

Every AC maps to at least one task. Two gaps run the other way:

- **T16 (CORS) has no AC.** The PRD's contract section mandates an origin allowlist but
  never made it a criterion. Proposed **AC-56**: *a request from a disallowed origin
  receives no `Access-Control-Allow-Origin` header.* Add it to the PRD.
- **AC-53 has no automatable test** and is carried by T31 as manual evidence. Already
  recorded as PRD R2; repeated here so the build stage does not mistake it for an oversight.

## Estimate

| Phase | Tasks | Estimate |
|---|---|---|
| 1 — pure logic | T1–T7 | 6h |
| 2 — rules | T8 | 2h |
| 3 — functions | T9–T16 | 11h |
| 4 — frontend infra | T17–T20 | 6.5h |
| 5 — UI | T21–T27 | 9h |
| 6 — e2e | T28 | 2.5h |
| **PR-A subtotal** | **T1–T28** | **~37h** |
| 7 — hardening | T29–T33 | ~7h |
| **Total** | **33 tasks** | **~44h** |

**Over half a day:** T10–T12 (the register branches, ~7h combined) and T19 (the guard
matrix, 2.5h) are the two clusters where the risk sits.

**Read this number against the schedule.** `IMPLEMENTATION_PLAN.md` §5 allocates Day 1 to
slices 0, 1 **and** 2. At ~44h this slice alone is the entire five-day budget, and Slice 2 —
the one the plan calls riskiest — has not started. Discovery's open risk 3 said the slice
had roughly doubled; the file-by-file plan says it is closer to five times the original.
This is a scope decision, not an engineering one, and it needs an answer before T1. Options,
cheapest first:

1. **Revert D5** to generic copy plus enumeration protection (D13). Deletes T4, T5, T7, T11,
   T12, T14, T25, T30 and most of T24 — roughly **−18h**, and D13 still closes the sign-in
   oracle. Costs the uniform sign-up response, which is the thing you chose twice.
2. **Keep D5, defer the gate's polish** — no `/auth/action` route, use Firebase's hosted
   handler (reverses D9): **−4h**, and the Loom looks less finished.
3. **Keep everything, re-cut the schedule** — Slice 1 takes two days, and Slices 7 and 11
   come off the plan per §5's "if you fall behind" guidance.

My recommendation is **3**, because option 1 discards the security posture you deliberately
chose and option 2 saves too little to matter. But it means saying now that Slices 7 and 11
are unlikely to ship.
