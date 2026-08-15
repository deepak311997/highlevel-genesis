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

## Deferred

- **AC-56 (CORS)** — proposed in the plan's coverage gaps, not yet added to the PRD. T16
  implements it; the criterion needs adding to `02-prd.md` at review.
