# Slice 01 — Account & session · Review

**Date:** 2026-08-16 · **Branch:** `slice/01-account-session` · **Reviewed:** `main...HEAD`
**Verdict:** ✅ **Approved.** Every finding is closed, the suite is green, and AC-53's console
evidence is recorded below. Ready to ship.

The slice does what it set out to do, and the security reasoning behind it is genuinely
good: the enumeration oracle is closed at the response, the mailbox and the throttle
boundary all at once, and the verification gate is enforced in Firestore rules rather than
only in the router, which is the difference between a real boundary and a courtesy. Three
of the four findings below are one-line fixes. The fourth is a decision, not a defect.

## Suite

Run at review time, after the fixes.

| Check | Result |
|---|---|
| `typecheck` | ✅ 0 errors |
| `lint` | ✅ 0 warnings (`--max-warnings 0`) |
| L1/L2 unit — frontend | ✅ 21 files, 190 passed |
| L1 unit — functions | ✅ 7 files, 85 passed |
| L3 rules | ✅ 16 passed |
| L4 integration | ✅ 4 files, 34 passed |
| L5 e2e | ✅ 2 passed |

**Note on the e2e run.** The first attempt failed with `http://localhost:5173 is already
used` — a development-mode Vite server was on the port, and `reuseExistingServer: false`
refused it. That is the config working exactly as designed: a dev-mode server talks to
*real* Firebase, so reusing it would have tested production while reporting an emulator
pass. The server was stopped and the suite run clean. Worth knowing, because it will happen
to anyone who runs the suite with `npm run dev` already up.

**The build log's suite line is stale** — it records 235 unit / 4 e2e; the tree is at 243
unit / 2 e2e. The e2e cases were consolidated during the auth-UX rework and the log was not
updated.

## AC coverage

Verified against `02-prd.md`. Only deltas are listed; the build log's table covers the rest
and is accurate apart from the AC-52 row corrected below.

| AC | Test | Verified |
|---|---|---|
| 6 | `authApi.spec.ts` — `BANNED` list, asserted against the module surface | ✅ Confirmed by grep: no `createUserWithEmailAndPassword` or `fetchSignInMethodsForEmail` anywhere in `frontend/src` |
| 26 | `redirect.spec.ts` | ✅ `//`, backslash and unknown-route cases all fall back; allowlist is stated positively, which is the right shape |
| 37–44 | `firestore.spec.ts` | ✅ Denials tested first, including the unverified-token case — the one people skip |
| 46–48 | `throttle.spec.ts`, `auth-throttle.spec.ts` | ✅ Counter advances identically for absent addresses; refused attempts do not extend their own lockout |
| 49 | `log.spec.ts` | ✅ Extended by this review — see Finding 1 |
| 8, 9, 10 | — | ⛔ **Dead criteria.** Retired by D31; no transport exists. PRD annotated. |
| 19, 52 | `auth-cleanup.spec.ts` + `index.spec.ts` | ✅ **Now met.** Trigger restored and the deployment surface is asserted. See Finding 4 |
| 50, 51 | `functions/src/auth/appCheck.spec.ts`, `frontend/src/lib/authApi.spec.ts` | ✅ **Now met.** Implemented during the review — see the App Check section. AC-50's "a real forged token is refused by Google" stays manual, as R2 predicted of console-enforced controls |
| 53 | Manual | ✅ **Confirmed 2026-08-16** by the project owner, against the Identity Platform console — see Manual verification |

## Findings

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | Required | **The register log line reopened the enumeration oracle.** `logAuthEvent('register.completed', { emailHash, branch, outcome })` paired an unsalted SHA-256 of the address with `branch: 'new' \| 'existing'`. Email addresses are low-entropy, so that hash is reversible against a wordlist in seconds — which makes any Cloud Logging reader able to ask "does this account exist?", the exact question the uniform response, the identical screens and the existence-blind throttle were all built to refuse. A log sink is a disclosure channel like any other. | **Fixed.** `branch` removed from `AuthLogContext` and the call site. Regression test added asserting on the *type* via `@ts-expect-error`, so the field cannot come back silently. `emailHash` stays — it is what correlates abuse, and alone it discloses nothing. |
| 2 | Required | **The `success` Alert variant spent a reserved token.** `alertVariants` used `--accent` for success, but `style.css` reserves the ember accent for the one live element per view and says so in a comment — "never success, never a decorative highlight" — and defines `--good` for exactly this. Five auth screens render a success alert, so this was about to make the loudest colour in the palette the calmest state's colour, leaving nothing to mark a running generation with in Slice 5. | **Fixed.** Switched to `border-good/40 bg-good/10 text-good`, with the reasoning in a comment at the variant. |
| 3 | Required | **Two icon libraries, one of them unused.** `af825a5` added `@lucide/vue` alongside the existing `lucide-vue-next`. Zero imports of the new one; the single icon import in the tree is `lucide-vue-next`, which is also what `components.json` declares. | **Fixed.** `@lucide/vue` uninstalled, lockfile committed. |
| 4 | Required | **AC-52 was recorded as covered and was not met.** `518e86f` dropped the `onSchedule` export, so `deleteExpiredUnverifiedUsers` never ran in production. `auth-cleanup.spec.ts` reaches it through an emulator-only route, so a green suite proved the *function* worked and said nothing about the *sweep* happening — one of D18's four pre-hijacking mitigations was silently unshipped for two days. | **Fixed.** `cleanupUnverifiedUsers` is exported from `functions/src/index.ts` as a daily `onSchedule` trigger, timezone pinned to UTC so the 24h boundary does not drift with the deploy environment. **And the gap that hid it is closed too:** `index.spec.ts` now asserts the deployment surface — a handler with no trigger is dead code wearing a passing test, and no other test level can see that. |
| 5 | Required | **The PRD carried criteria that can never pass.** AC-8 and AC-10 specify an SMTP2GO transport deleted in `9132424`; AC-9's transport clause went with it. A PRD is the contract a review audits against, so dead criteria make the audit unreliable. | **Fixed.** Annotated in place rather than deleted — the D7 → D8 → D31 trail only reads correctly against the criteria it reversed. AC-10's surviving principle (emulator-only behaviour keyed on `FUNCTIONS_EMULATOR`, never on config) is noted as still live and still exercised by the test-only cleanup route. |
| 6 | Consider | **The slice is too large to review as one PR, by this project's own standard.** 107 files, +8,415 / −779. The review skill's boundary is ~1,000 lines. The PRD predicted this exactly — R1 flagged it and B5 proposed a PR-A / PR-B split — and B5 was never answered, so the split never happened. | Not actionable now without rewriting history. Raised because B5 is still formally unanswered, and because the same pressure applies to Slice 2. |
| 7 | Nit | `af825a5` is titled `refactor` and bundles a docs rewrite, a dependency add, a dependency removal, a component refactor and a file deletion. Convention is imperative and one per green cycle; `ddc430b` added `scripts/set-verified.mjs` and `af825a5` deleted it, so the file exists only inside the branch's history. | Noted, not rewritten. |
| 8 | Nit | The primitives added in `af825a5` — `AlertTitle`, `AlertDescription`, `CardDescription`, `CardFooter` — shipped without component tests, where `Button` has one. | **Fixed**, and writing them found something. `Alert.spec.ts` covers the role-follows-variant behaviour (invisible to a sighted reviewer, so exactly what a test is for) and pins the `--good` token from Finding 2; `Card.spec.ts` pins `CardTitle` as a real heading, which is the accessible name for every auth screen. See Finding 10. |
| 10 | Consider — **found by writing Finding 8's tests** | **`Alert` and `Card` had a leading comment inside `<template>`, making them fragment-rooted.** Vue does still apply attribute fallthrough past sibling comments — `data-testid="verify-resent"` on an `Alert` works, and its test passes — so this was not a production bug. But a fragment has no single root to address, so `mount(Alert).element` resolves to the *comment*, and the component cannot be tested directly at all. That is why these two had no tests: they were untestable, and it looked like a choice. | **Fixed.** Both comments moved into the `<script setup>` block, where `Button`, `Input` and `Label` already keep theirs. No render output changed. |
| 9 | Required | **App Check had no code at all**, though the build log deferred AC-50/51 on "needs console registration". reCAPTCHA v3 was configured on 2026-08-16 and the key added to `frontend/.env`, but grep found **zero** references to App Check in either package. A configured reCAPTCHA key enforces nothing on its own — the client must attach a token and the function must verify it. D24 called this the strongest control available against automated abuse of `register`. | **Fixed — implemented test-first.** See below. |

## App Check — implemented during the review (AC-50, AC-51)

Added after you confirmed reCAPTCHA v3 is configured and the site key is in `frontend/.env`.
Six new tests on the middleware, one on the client, all red before green.

| Piece | File |
|---|---|
| Express middleware verifying `X-Firebase-AppCheck` | `functions/src/auth/appCheck.ts` |
| Admin App Check handle | `getAppCheckService()` in `functions/src/lib/firebase.ts` |
| Client token fetch + header | `frontend/src/lib/appCheck.ts` |
| Header attached to the register call | `frontend/src/lib/authApi.ts` |

Four decisions worth recording, because each one is a place this could have gone wrong:

- **Middleware on the route, not `enforceAppCheck` on the function.** The function-level
  option would have covered the whole `api` function including `/health`, which D17 keeps
  public. Per-route also matches how the throttle is attached, and for the same documented
  reason — the router is mounted at both `/` and `/api`, so `router.use` would run twice.
- **App Check runs *before* the throttle.** An unattested request should cost us nothing,
  and more importantly must not be able to spend a real user's throttle budget — otherwise
  a flood of forged requests locks the victim out of registering and the control becomes a
  denial of service. It also satisfies AC-50's "before any Auth call" literally.
- **The emulator bypass is keyed on `FUNCTIONS_EMULATOR` alone.** There is no App Check
  emulator, so without a bypass the whole e2e and integration suite fails on a control those
  tests are not about — the failure R5 anticipated. It is deliberately *not* a config value:
  a settable flag would be a remotely-configurable way to switch off the control guarding
  account creation. Same signal as the test-only cleanup route (D21), and a test asserts the
  near-miss `'TRUE'` does **not** bypass.
- **Client-side failure degrades to no header, never to a thrown error.** The server is the
  enforcement point and answers 401 with copy a user can act on; throwing in the browser
  would instead put a reCAPTCHA-shaped error on a sign-up form.

**What this does and does not prove.** `appCheck.spec.ts` covers the middleware's decisions —
missing, blank, rejected, verified, bypassed — and `authApi.spec.ts` asserts the header is
actually attached, which matters because the emulator bypasses App Check and would otherwise
let a silently-dropped header pass every test while breaking production. **What no automated
test here proves is that a real forged token is refused by Google**: that needs the deployed
project, so AC-50 remains partly manual, exactly as PRD R2 said of the console-enforced
controls. Verify it once against the deployed function before the Loom.

## What I checked and found sound

Recording this so the absence of findings reads as evidence rather than silence.

- **Firestore rules.** Deny-by-default, `verified()` on every `users/{uid}` operation, an
  explicit key allowlist on create, `createdAt == request.time` so a client cannot backdate,
  `email`/`createdAt` immutable on update, `delete` denied outright. `hlConnections` has no
  `allow` rule of any kind — the token boundary holds ahead of Slice 2 needing it.
- **Throttle arithmetic.** Pure and separately tested. A refused attempt writes nothing, so
  an attacker cannot hold a victim's address shut by continuing to hit it. A window starting
  in the future is treated as fresh rather than honoured, which closes the clock-skew lockout.
  Per-route attachment rather than `router.use` is correct and the reason is documented — the
  router is mounted at both `/` and `/api`, so `use` would double-count.
- **Redirect validation.** Positive character allowlist plus an explicit `//` rejection plus a
  known-route check; re-validated on read from `sessionStorage`, not only on write, because
  any script on the origin can edit it.
- **Log redaction.** Key-name and inline-value scrubbing, circular-reference safe, and
  deliberately never throwing because it runs from catch blocks. The regexes are used in ways
  that avoid the `lastIndex` trap.
- **CORS.** Exact string match with the lookalike-prefix and lookalike-suffix cases called out;
  resolved per request rather than at module scope, because `firebase deploy` analyses the
  module before injecting `.env`.
- **Emulator selection by build mode.** `import.meta.env.MODE` is a build-time literal, so the
  emulator branch is statically eliminated from a production bundle. A runtime flag could not
  give that property, and the `data-genesis-emulator` marker stops Playwright silently testing
  production. This is the strongest single decision in the slice.

## Manual verification

- e2e golden path run locally against the emulators: sign up → held at the gate → verify →
  dashboard → second sign-up for the same address is indistinguishable. Both pass.
- Grep-verified AC-6 across `frontend/src`.
### AC-53 — console controls ✅ confirmed 2026-08-16

Neither control can be tested from this repo: the Auth emulator enforces no password policy
and no enumeration protection, which is why PRD R2 said plainly that a green suite does not
demonstrate either. Both were verified by the project owner in the Identity Platform console.

**Email-enumeration protection:** enabled. This is the one D13 calls load-bearing — sign-in
goes browser-to-Identity-Toolkit directly and we never see it, so our own non-disclosing
`register` endpoint closes sign-up only. Without this, `user-not-found` still leaks on
sign-in and the slice's central property would be half-built.

**Password policy:** enabled, and it matches `functions/src/auth/schema.ts` and
`frontend/src/lib/password.ts` field for field.

| Console setting | Value | Mirrored in code |
|---|---|---|
| Enforcement mode | **Require enforcement** — sign-up fails until the password complies | Both files reject before any Auth call |
| Require uppercase / lowercase / numeric / special | all four ✅ | four `.refine()` calls in `schema.ts` |
| Minimum length | **8** | `PASSWORD_MIN = 8` |
| Maximum length | **50** | `PASSWORD_MAX = 50` |
| Force upgrade on sign-in | ☐ off | — moot: every account was created under this policy |

Two things worth naming because they are what make this real rather than decorative:

1. **"Require enforcement", not "Notify enforcement".** The notify mode would let a
   non-compliant password through and merely report the unmet criteria, which would make our
   server-side check the only barrier and leave `confirmPasswordReset` — client-side —
   accepting passwords `register` refuses.
2. **The direction of any future divergence is what matters.** D30's concern was code being
   *laxer* than the console, which would let someone sign up with a password they could never
   set again on reset. Code and console now agree exactly, so there is no divergence in
   either direction; both files assert their bounds explicitly so the coupling to an
   otherwise-unreadable console setting is visible where it would break.

## Deliberately deferred

| Item | Why | Where it lands |
|---|---|---|
| App Check — deployed verification | Implemented and unit-tested, but no automated test can prove Google refuses a forged token; that needs the deployed project | Manual check before the Loom |
| ~~AC-53 console evidence~~ | ✅ **Closed 2026-08-16** — confirmed and recorded above | — |
| PR-A / PR-B split (B5) | Never answered; the branch grew past the point where splitting is cheap | Raised for Slice 2 |
