# Slice 02b — API-only data access · Build log

**Plan:** `03-plan.md` (approved) · **PRD:** `02-prd.md` · **Branch:** `slice/02b-api-data-access`
· **Started:** 2026-08-17

Appended as the build runs, one entry per red-green-refactor cycle, so a session that dies
mid-slice can be picked up from here.

## Before starting

- Branched from `main` at `daf1c03` with a clean tree.
- Baseline `npm test` (typecheck, lint, unit, rules, integration) green — exit 0, 70 L4
  tests passing. No pre-existing failure to report.

## T1 — `parseBody`, the Zod half of the boundary → AC-8, AC-9

- **Tests (L1):** `functions/src/lib/parse.spec.ts` — 5 cases: valid body returns parsed data;
  unknown key throws `HttpError` 400 `invalid_body`; Zod's own message survives so the caller
  learns which field; an absent body parses as `{}`; a wrong-typed value is refused.
- **Code:** `functions/src/lib/parse.ts`.
- **Deviation from plan:** none. `handleRegister` deliberately left on its own `invalid_request`
  code, as the plan directs.

## T2 — the users schemas → AC-8, AC-9, AC-11

- **Tests (L1):** `functions/src/users/schema.spec.ts` — 13 cases across `profileBodySchema`
  (empty body, name, explicit null, `uid` rejected, `email` rejected, wrong type rejected,
  81 rejected / 80 accepted, trimmed before measuring) and `storedProfileSchema` (complete
  document parses; missing `email` and missing `createdAt` both fail; a wrong-typed
  `displayName` degrades to `null`), plus `toProfile` emitting ISO-8601.
- **Code:** `functions/src/users/schema.ts`.
- **Deviation:** the structural `timestamp` schema is duplicated with `hl/connection.ts`, as the
  plan directs — two occurrences is a coincidence, Slice 3 is the moment to lift it.

## T3 — `GET /api/users/me` → AC-3, AC-4, AC-6, AC-7, AC-11

- **Tests (L4):** `tests/integration/users-profile.spec.ts`, `describe('GET /api/users/me')` —
  profile returned with ISO-8601 timestamps; 200 `{ profile: null }` rather than 404; 401 with
  nothing created; 403 for an unverified token; fails closed on a document with no `email`.
- **Code:** `functions/src/users/profile.ts`, `functions/src/users/index.ts`, and the
  `usersRouter` mount at `/` and `/api` in `functions/src/api/index.ts`.
- **Deviation:** none.

## T4 — `PUT /api/users/me` → AC-1, AC-2, AC-5, AC-6 … AC-10

- **Tests (L4):** same file, `describe('PUT /api/users/me')` — creates and returns with the
  email from the Auth record; a second `PUT` preserves `createdAt` and advances `updatedAt`;
  sets, leaves alone and clears `displayName`; rejects `{ uid }` and `{ email }` with 400
  `invalid_body` leaving both documents untouched; rejects an 81-character and a non-string
  name; 401 and 403 with nothing created; alice's calls return alice's email and leave bob's
  `updatedAt` unchanged. Plus one in the `GET` block: **"is repaired by a following `PUT`"**,
  the second half of AC-11.
- **Code:** `handlePutProfile` in `functions/src/users/profile.ts`; `putJson` added to
  `tests/integration/helpers.ts`; the `PUT` route mounted attested (D16).
- **Refactor:** the projection both routes use is one private `readProfile(uid)`, so `GET` and
  `PUT` cannot drift in wire shape — the refactor the plan anticipated for this task.

### Plan amendment — the touch branch must heal, not just touch

The plan's T4 green step says: *"on present, merge `{ email, updatedAt: serverTimestamp() }`
plus `displayName` only when the key was present in the body."* That is wrong for AC-11's
second half, and the test caught it: a stored document missing `createdAt` **exists**, so the
merge branch runs, writes `email` and `updatedAt`, and leaves `createdAt` absent. The document
stays unparseable, `GET` goes on answering `{ profile: null }` forever, and the `PUT` itself
hits its own defensive post-write parse and answers 500. D18's "a subsequent `PUT` repairs it"
would have been false.

**Corrected route:** the transaction branches on whether the stored document *parses*, not on
whether it exists. Anything that does not parse is rewritten whole. A `createdAt` that is still
a usable Timestamp survives the rewrite — losing it would silently reset the account's age —
and `serverTimestamp()` is used when there is nothing to preserve. `firestoreTimestamp` is
exported from `users/schema.ts` for that check rather than re-declared.

This is strictly closer to the PRD than the plan text was; no AC changed.
