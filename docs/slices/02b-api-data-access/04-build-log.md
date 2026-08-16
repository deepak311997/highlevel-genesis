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

## T5 — extract `apiClient`, refactor `hlApi` onto it → AC-23

- **Tests (L1):** `frontend/src/lib/apiClient.spec.ts` — 9 cases: Bearer header, App Check
  header, a fresh token per request, the caller's own headers preserved alongside them, a
  throw before fetching when signed out, network failure → status 0, the server's message
  preferred, 429 copy, and the parsed body on success.
- **Code:** `frontend/src/lib/apiClient.ts`, lifted verbatim; `hlApi.ts` imports `request`.
- **The assertion is the negative one:** `git diff frontend/src/lib/hlApi.spec.ts` is empty. The
  suite was not touched and passes over the refactored code, which is AC-23.

## T6 — `profileApi` → AC-22 (parsing half)

- **Tests (L1):** `frontend/src/lib/profileApi.spec.ts` — 6 cases: `GET`s the path, unwraps the
  envelope, returns `null` as a value; `PUT`s with `'{}'` and a JSON content type; returns the
  stored profile; surfaces a refusal.
- **Code:** `frontend/src/lib/profileApi.ts`.

## T7 — the profile store → AC-22

- **Tests (L1):** `frontend/src/stores/profile.spec.ts` — 7 cases, asserted through a **mocked
  `fetch`** rather than a mocked client, so AC-22's header claim is made against the request
  that would actually go on the wire.
- **Code:** `frontend/src/stores/profile.ts`. `load()` ships with L1 coverage and no in-app
  caller, per plan decision P1, and says so at its definition.

## T8 — `AccountCard` → AC-17 … AC-20

- **Tests (L2):** `frontend/src/components/AccountCard.spec.ts` — 9 cases: loading with no
  address; display name; fallback to the address; `dashboard-email`; the member-since date;
  the empty state with no error; the error with its message and Retry; Retry re-issuing; and
  the error winning over stale content.
- **Code:** `frontend/src/components/AccountCard.vue`. Locale and time zone pinned to `en-GB`
  and UTC, so the rendered date does not depend on the machine.

## T9 — the views onto the profile store; `authStore.ensureProfile` deleted → AC-21

- **Tests (L2):** `DashboardView.spec.ts` rewritten (renders the card, ensures on mount, and
  AC-21 — the connection panel and projects card survive a failed profile request);
  `VerifyEmailView.spec.ts` and `AuthActionView.spec.ts` now mock the profile store;
  `stores/auth.spec.ts` loses its `ensureProfile` block and its `firebase/firestore` mock.
- **Code:** the three views call `profile.ensure()`; `stores/auth.ts` drops `ensureProfile`,
  `USERS_COLLECTION`, and both the `firebase/firestore` and `db` imports.
- **Refactor:** the docstrings in `auth.ts`, `VerifyEmailView.vue` and `AuthActionView.vue` that
  described Firestore rules as the thing making an unverified session inert now name
  `withVerifiedUser` and its `email_verified` check, with rules as the backstop.

## T10 — remove `db`, the emulator wiring, and the two env vars → AC-27

- **Tests (L1):** `frontend/src/lib/firebase.spec.ts` — no `db` export; boots with neither
  `VITE_FIREBASE_DATABASE_ID` nor `VITE_FIRESTORE_EMULATOR_PORT` set. Both were genuinely red.
  The `firebase/firestore` mock is gone from the file, because there is nothing left to mock.
- **Code:** `lib/firebase.ts`, `env.d.ts`, `vite.config.ts`, `frontend/.env.example`,
  `.env.example` (including the `FIRESTORE_DATABASE_ID` comment that cross-referenced the
  removed frontend variable). **The `MODE === 'emulator'` block and its `data-genesis-emulator`
  marker were kept** — deleting them would silently disarm the e2e suite's guard.

## T11 — rules to deny-all, L3 suite rewritten → AC-12 … AC-16

- **Tests (L3):** `tests/rules/firestore.spec.ts` rewritten so that **every case is an
  `assertFails`**; `assertSucceeds` is no longer imported.
- **Code:** `firestore.rules` — `users/{uid}` reduced to `allow read, write: if false`;
  `signedIn()`, `isOwner()` and `verified()` deleted with their last caller; header comment
  rewritten to say the file is the backstop and enforcement lives in the routes.
- **A red step that had to be earned:** written the obvious way, the create and update denials
  passed against the *old* rules too — `createdAt: new Date()` violated the old
  `createdAt == request.time` pin, and a bare `updateDoc` violated the old `updatedAt` pin, so
  both were denied for reasons unrelated to this change. They now send exactly the payload the
  old owner-scoped rules **accepted** (`serverTimestamp()` on create; `displayName` plus
  `updatedAt` on update), which made all three `users/{uid}` cases genuinely red before the
  rules changed and genuinely load-bearing after.

## T12 — the ESLint ban and the source scan → AC-24, AC-25

- **Tests (L1):** `frontend/src/lib/no-firestore.spec.ts` — recursive scan of `frontend/src`,
  reporting offenders by path. Per P5 it skips its own filename and builds the needle by
  concatenation.
- **Code:** `frontend/eslint.config.js` — `no-restricted-imports.patterns` covering
  `firebase/firestore` and its subpaths, alongside the untouched `firebase/auth` `paths` entry.
- **Both were verified red by hand:** a throwaway `frontend/src/lib/__trap.ts` importing `doc`
  from `firebase/firestore` made the scan fail naming that file, and made `npm run lint` fail
  with the ban's message. The trap was then deleted and both went green.
- **Deviation:** the plan's scan resolves `src` from `import.meta.url`. Under jsdom
  `import.meta.url` is an `http:` URL and `fileURLToPath` rejects it, so the scan resolves from
  `process.cwd()` instead — which is `frontend/` under both `npm --prefix frontend run test`
  and the root `test:unit`. Noted at the constant.

## T13 — the bundle check → AC-26

- **Tests (L1, root project):** `scripts/check-no-firestore.spec.mjs` — 4 cases: clean bundle;
  a hit, named by path; a nested hit; and a missing directory, which throws naming
  `npm run build`. Fixtures under `mkdtempSync(tmpdir())`, never committed.
- **Code:** `scripts/check-no-firestore.mjs` (exports `MARKER` and `filesContainingMarker`, CLI
  guarded by the `import.meta.url` check), `vitest.scripts.config.mts`, the `test:scripts` npm
  script with `test:unit` calling it, and the CI step after Build.
- **Confirmed by hand:** `npm run build && node scripts/check-no-firestore.mjs frontend/dist`
  exits 0. **Demo evidence — the `firebase-*.js` chunk went from 598.62 kB / 181.59 kB gzipped
  on `main` to 166.03 kB / 54.84 kB gzipped**, and the marker is gone. No transitive pull
  survived, so R3 did not fire.

### Plan amendment — the root vitest config must not be auto-discovered

P4 specifies a root `vitest.config.mts`. Adding one broke `npm run test:unit`: **Vitest resolves
its config by walking *up* from the working directory**, so a root `vitest.config.mts` became the
config for `functions/`, which has none of its own. Its suite then ran with
`include: scripts/**/*.spec.mjs` and reported "No test files found, exiting with code 1" — 183
passing tests silently replaced by a failure.

**Corrected route:** the file is `vitest.scripts.config.mts` and `test:scripts` passes it with
`--config`. A config only reachable by name cannot leak downward at all, so no future package
has to declare a config of its own purely to defend itself. The alternative — adding
`functions/vitest.config.mts` — fixes today's symptom and leaves the next package exposed.

## T14 — the end-to-end path → AC-28

- **Tests (L5):** `tests/e2e/auth.spec.ts` — after `Continue` lands on `/dashboard`, the account
  card is visible, `dashboard-email` carries the registered address, and
  `account-member-since` has rendered; all three re-asserted after `page.reload()`.
  `account-member-since` is derived from the stored `createdAt`, so it only renders if the
  server actually wrote the document.
- **Code:** none, as the plan predicted — the assertions passed on the work already done.
- **Refactor:** the file's docstring and the two inline comments that said "the dashboard's
  Firestore read succeeds" and "the Firestore-backed session is live" now say what is actually
  being proved: the refreshed ID token satisfied `withVerifiedUser`'s `email_verified` check on
  the profile route.

## Deferred

Nothing. Every task in the plan landed, and no work was found that the plan did not cover.

The two code paths the plan flagged as carrying no AC and no test — an Auth record with no
email, and a document that fails to parse immediately after we wrote it — remain untested by
design. Both are unreachable in this product and both fail closed with a 500 and a log line;
a test for either would have to fake a state the system cannot produce.
