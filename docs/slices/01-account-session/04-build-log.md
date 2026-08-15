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

## Deferred

- **AC-56 (CORS)** — proposed in the plan's coverage gaps, not yet added to the PRD. T16
  implements it; the criterion needs adding to `02-prd.md` at review.
