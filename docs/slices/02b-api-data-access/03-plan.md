# Slice 02b — API-only data access · Technical plan

**PRD:** `02-prd.md` (approved) · **Branch:** `slice/02b-api-data-access` · **Date:** 2026-08-17

## Approach

Two new Cloud Function routes — `GET` and `PUT /api/users/me` — take over the one job the
browser still did against Firestore, and they are built out of the pieces Slice 2 already
proved: `withVerifiedUser` for the token-and-`email_verified` check, `asyncHandler` +
`HttpError` for error shape, `getDb()` for the Admin SDK handle, and the parse-don't-assert
stored-document schema pattern from `functions/src/hl/connection.ts`. The one genuinely new
backend piece is `functions/src/lib/parse.ts` — `parseBody(schema, req)` — which is the Zod
half of the boundary the architecture decision names, and which Slice 3 inherits.

On the frontend the private `request<T>()` inside `frontend/src/lib/hlApi.ts` is lifted
verbatim into `frontend/src/lib/apiClient.ts` and `hlApi.ts` is refactored onto it; because
`hlApi.spec.ts` mocks `@/lib/firebase` and `@/lib/appCheck` — the two modules `apiClient`
also imports — that suite passes unmodified over the refactored code, which is the
assertion that the extraction changed nothing. `ensureProfile()` then leaves `stores/auth.ts`
for a new `stores/profile.ts` fed by `lib/profileApi.ts`, and a new `AccountCard.vue`
renders it with the four states. Only once no module under `frontend/src` imports
`firebase/firestore` do the enforcement layers land: `db` and the Firestore emulator wiring
come out of `lib/firebase.ts`, `users/{uid}` drops to `allow read, write: if false`, ESLint
bans the import, an L1 test scans the source tree, and `scripts/check-no-firestore.mjs`
greps the built bundle in CI.

The task order is deliberate on one point: **the rules change lands after the frontend
migration, not before.** Reversed, there is a run of commits in which the client write is
denied and nothing has replaced it, so a fresh sign-up in that window gets no profile
document at all. It is a transient that never ships, but ordering it away costs nothing.

*Alternatives considered.* A route factory or generic CRUD helper for the two routes —
rejected, two routes is not enough evidence to abstract from (PRD, out of scope). A
transaction-free `set(..., { merge: true })` upsert — rejected, it makes "`createdAt` is set
once and never rewritten" true only for sequential callers, and two tabs is the ordinary
case. `Timestamp.now()` instead of `FieldValue.serverTimestamp()`, which would let the
handler answer without re-reading — rejected, D19 names `serverTimestamp()`. Passing the
whole decoded ID token out of `withVerifiedUser` so the handler gets `email` for free —
rejected, it changes a signature every Slice 2 handler already implements, to save one
`getUser(uid)` call.

## Plan decisions

Decisions this plan had to take that the PRD did not settle. Each is a real choice with a
rejected alternative, recorded here so the build stage does not re-litigate it.

| # | Question | Decision | Rationale |
|---|---|---|---|
| P1 | The PRD's user flow has the dashboard calling `ensure()` (PUT, D5) on mount, and separately describes a read path calling `GET`. Which does the app actually call? | **Only `ensure()`.** `ProfileStore.load()` and `profileApi.getProfile()` ship with L1 and L4 coverage but no view calls them in this slice. | D5 is binding and behaviour-preserving: the three `ensureProfile()` call sites become three `ensure()` call sites, no more. The alternative — `AccountCard` issuing its own `GET` on mount while `DashboardView` issues a `PUT` — puts two in-flight requests into one store with no AC governing which result wins, i.e. a race introduced by a plan rather than by the brief. `load()` is not dead weight: it is the read half of the contract Slice 3's `projects` store copies, and it is the only producer of the `loaded && profile === null` state that `AccountCard`'s empty state (AC-19) renders. A code comment says so at the definition. |
| P2 | Where does the `PUT` handler get the `email` it stores (D6 says "the token / the Admin Auth record", not the body)? | **`getAdminAuth().getUser(uid).email`.** | Authoritative, and contained: `withVerifiedUser` passes only a uid, and widening it to pass the decoded token changes a signature four existing handlers implement in order to save one Admin call on a route that already does a transaction. |
| P3 | `PUT` returns the stored profile, but `serverTimestamp()` is a sentinel until it commits. | **Transaction commits, then re-read the document and project it through the same schema `GET` uses.** | One projection function, so the two routes cannot drift in shape. Costs one extra read on a route called once per session. |
| P4 | What runs `scripts/check-no-firestore.spec.mjs`? Root `test:unit` runs only the `functions` and `frontend` vitest projects today. | **A new root `vitest.config.mts` including `scripts/**/*.spec.mjs`, a `test:scripts` npm script, and `test:unit` extended to call it.** | The alternative is a spec with no runner, which is the failure mode the test exists to prevent. Root `tsconfig.json` does not include the new config or the `.mjs` files, matching how `scripts/test-emulator-config.mjs` is already treated. |
| P5 | How does the L1 source scan avoid matching itself? | **Skip its own filename, and build the needle by concatenation.** | A scanner that trips on its own source is a test nobody can write, and both halves are one line each. |
| P6 | `scripts/check-no-firestore.mjs` against a directory that does not exist. | **Exit non-zero**, with a message naming `npm run build`. | Exiting 0 on a missing `dist` means the CI step passes loudest exactly when the build did not run — a security check that reports success on absence of evidence. |

## Verified before planning

- **The marker is real and present today.** `npx vite build` in `frontend/` on `main`, then
  `grep -rl "firestore.googleapis.com" dist/` → `dist/assets/firebase-CdRV33_-.js`
  (598.62 kB / 181.59 kB gzipped). D13 and R3 hold on a *production*-mode build, not only the
  emulator build the PRD measured. The shrink of that chunk is the PR's demo evidence.
- `frontend/src` imports `firebase/firestore` in exactly three places: `lib/firebase.ts`,
  `stores/auth.ts`, and the `vi.mock` in `lib/firebase.spec.ts`. `tests/rules/firestore.spec.ts`
  also imports it and is **outside** the frontend ESLint root, so the ban does not touch it.
- `functions/` has no vitest config; vitest's default include picks up `src/**/*.spec.ts`,
  so `functions/src/users/schema.spec.ts` and `functions/src/lib/parse.spec.ts` need no wiring.
- `requireAppCheck` no-ops under `FUNCTIONS_EMULATOR`, so L4 `PUT`s need no attestation token.
- The e2e emulator marker (`data-genesis-emulator`) lives inside the same
  `MODE === 'emulator'` block as `connectFirestoreEmulator`. **The block stays; only the
  Firestore line goes.** Deleting the block would silently disarm the e2e suite's guard
  against running against real Firebase.

## File map

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/lib/parse.ts` | New | `parseBody(schema, req)` → parsed data, or `HttpError(400, msg, 'invalid_body')` |
| `functions/src/lib/parse.spec.ts` | New | L1: success returns typed data; failure throws with status 400 and code `invalid_body`; absent body parses as `{}` |
| `functions/src/users/schema.ts` | New | `USERS`, `DISPLAY_NAME_MAX`, `profileBodySchema` (`.strict()`), `storedProfileSchema`, `Profile` wire type, `toProfile()` |
| `functions/src/users/schema.spec.ts` | New | L1: unknown key / wrong type / over-length rejected; stored schema rejects a missing `email`; `toProfile` emits ISO-8601 |
| `functions/src/users/profile.ts` | New | `handleGetProfile`, `handlePutProfile` |
| `functions/src/users/index.ts` | New | `usersRouter` — `GET /users/me`, `PUT /users/me` (attested) |
| `functions/src/api/index.ts` | Edit | Mount `usersRouter` at `/` and `/api`, before the 404 |
| `tests/integration/helpers.ts` | Edit | Add `putJson(path, body, headers)` |
| `tests/integration/users-profile.spec.ts` | New | L4: AC-1 … AC-11 |
| `firestore.rules` | Edit | `users/{uid}` → `allow read, write: if false`; delete `signedIn()`, `isOwner()`, `verified()`; rewrite the header comment |
| `tests/rules/firestore.spec.ts` | Edit | Every `users/{uid}` case becomes a denial; `hlConnections` / `authThrottle` / unknown-collection cases re-asserted; `profile()` and `seedProfile()` helpers survive as seeds only |
| `frontend/src/lib/apiClient.ts` | New | `request<T>(path, init)` + private `authHeader()`, lifted verbatim from `hlApi.ts` |
| `frontend/src/lib/apiClient.spec.ts` | New | L1: ID token header, App Check header, `ApiError` mapping, network failure → status 0, 429 copy |
| `frontend/src/lib/hlApi.ts` | Edit | Delete the private `authHeader`/`request`; import `request` from `./apiClient` |
| `frontend/src/lib/hlApi.spec.ts` | **Unchanged** | AC-23 — an untouched suite over refactored code is the assertion |
| `frontend/src/lib/profileApi.ts` | New | `Profile` type, `getProfile()`, `ensureProfile()` |
| `frontend/src/lib/profileApi.spec.ts` | New | L1: paths and verbs; `{ profile: null }` returned as a value |
| `frontend/src/stores/profile.ts` | New | `profile`, `loading`, `loaded`, `error`, `ensure()`, `load()` |
| `frontend/src/stores/profile.spec.ts` | New | L1: `ensure()` issues `PUT /api/users/me` with both headers; error and empty states |
| `frontend/src/components/AccountCard.vue` | New | Loading / loaded / empty / error+Retry; new home of `data-testid="dashboard-email"` |
| `frontend/src/components/AccountCard.spec.ts` | New | L2: AC-17 … AC-20 |
| `frontend/src/views/DashboardView.vue` | Edit | Renders `AccountCard`; `onMounted` calls `profile.ensure()`; drops `useAuthStore` and the "signed in as" line |
| `frontend/src/views/DashboardView.spec.ts` | Edit | Mock the profile store instead of the auth store; AC-21 |
| `frontend/src/views/VerifyEmailView.vue` | Edit | `auth.ensureProfile()` → `profile.ensure()` |
| `frontend/src/views/VerifyEmailView.spec.ts` | Edit | Mock the profile store for that call |
| `frontend/src/views/AuthActionView.vue` | Edit | `store.ensureProfile()` → `profile.ensure()` |
| `frontend/src/views/AuthActionView.spec.ts` | Edit | Same |
| `frontend/src/stores/auth.ts` | Edit | Delete `ensureProfile`, `USERS_COLLECTION`, the `firebase/firestore` import and the `db` import |
| `frontend/src/stores/auth.spec.ts` | Edit | Delete the `ensureProfile` describe block and the `firebase/firestore` mock |
| `frontend/src/lib/firebase.ts` | Edit | Delete `db`, `databaseId`, `getFirestore`, `connectFirestoreEmulator`. **Keep the `MODE === 'emulator'` block and its `data-genesis-emulator` marker.** |
| `frontend/src/lib/firebase.spec.ts` | Edit | Drop the `firebase/firestore` mock and the `db` assertion; assert no `db` export and a clean boot (AC-27) |
| `frontend/src/lib/no-firestore.spec.ts` | New | L1: scans `frontend/src` for `firebase/firestore` imports (AC-24) |
| `frontend/src/env.d.ts` | Edit | Remove `VITE_FIRESTORE_EMULATOR_PORT` and `VITE_FIREBASE_DATABASE_ID` |
| `frontend/vite.config.ts` | Edit | Remove both from `EMULATOR_ENV` |
| `frontend/eslint.config.js` | Edit | `no-restricted-imports.patterns` bans `firebase/firestore` and its subpaths (AC-25) |
| `frontend/.env.example` | Edit | Remove `VITE_FIREBASE_DATABASE_ID` and its comment block |
| `.env.example` | Edit | Same, and fix the `FIRESTORE_DATABASE_ID` cross-reference that names it |
| `scripts/check-no-firestore.mjs` | New | Exports `MARKER` + `filesContainingMarker(dir)`; CLI exits non-zero on a hit or a missing directory |
| `scripts/check-no-firestore.spec.mjs` | New | L1: clean fixture passes, marked fixture fails, missing directory fails |
| `vitest.config.mts` | New | Root config, `include: ['scripts/**/*.spec.mjs']` (P4) |
| `package.json` | Edit | `test:scripts` script; `test:unit` calls it |
| `.github/workflows/ci.yml` | Edit | Step after Build: `node scripts/check-no-firestore.mjs frontend/dist` |
| `tests/e2e/auth.spec.ts` | Edit | AC-28 — assert the account card's loaded state; correct the stale "Firestore read" comments |

## Task list

Each task is one red-green-refactor cycle and one commit pair (`test:` then `feat:`/`refactor:`).
Every task leaves `npm test` green.

### T1 — `parseBody`, the Zod half of the boundary  → AC-8, AC-9

- **Red:** `functions/src/lib/parse.spec.ts` — "returns the parsed data on a valid body";
  "throws HttpError 400 with code `invalid_body` on an unknown key"; "carries Zod's own
  message so the caller learns which field"; "treats an absent body as `{}`".
- **Green:** `functions/src/lib/parse.ts`:
  ```ts
  export function parseBody<T>(schema: ZodType<T>, req: Request): T {
    const parsed = schema.safeParse(req.body ?? {})
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? 'Check the details and try again.',
        'invalid_body',
      )
    }
    return parsed.data
  }
  ```
  The `?? {}` is deliberate and documented: `express.json()` already yields `{}` for a
  bodyless request whose content-type it does not match, and the substitution covers the
  case where the middleware never ran at all. It relaxes nothing — `.strict()` still
  rejects every unknown key.
- **Refactor:** none expected. Do **not** move `handleRegister` onto it in this slice —
  that route's 400 uses code `invalid_request`, and changing it is a contract change with
  no AC behind it.
- **Known gap, deliberately not closed:** a syntactically invalid JSON body is rejected by
  `body-parser` before any route runs, and the terminal handler turns that non-`HttpError`
  into a 500. That is pre-existing (`/auth/register` has it too), no AC covers it, and
  fixing it means touching the shared error handler. Noted, not scoped.

### T2 — the users schemas  → AC-8, AC-9, AC-11

- **Red:** `functions/src/users/schema.spec.ts` — the `PUT` body: `{}` accepted;
  `{ displayName: 'Alice' }` accepted; `{ displayName: null }` accepted; `{ uid: 'bob' }`
  rejected; `{ email: 'x@y.test' }` rejected; `{ displayName: 42 }` rejected; an 81-character
  `displayName` rejected and 80 accepted. The stored document: a complete document parses;
  one missing `email` fails; one missing `createdAt` fails; a non-string `displayName`
  falls back to `null` via `.catch(null)`. `toProfile()` emits ISO-8601 strings.
- **Green:** `functions/src/users/schema.ts`, mirroring `hl/connection.ts`'s structural
  `timestamp` custom type:
  ```ts
  export const USERS = 'users'
  export const DISPLAY_NAME_MAX = 80

  export const profileBodySchema = z
    .object({ displayName: z.string().trim().max(DISPLAY_NAME_MAX).nullable().optional() })
    .strict()

  export const storedProfileSchema = z.object({
    email: z.string().min(1),
    displayName: z.string().nullable().catch(null),
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  export interface Profile {
    email: string
    displayName: string | null
    createdAt: string
    updatedAt: string
  }

  export function toProfile(stored: z.infer<typeof storedProfileSchema>): Profile
  ```
  `.strict()` is the load-bearing call (D7/R1): it is what makes a body carrying `uid` or
  `email` a 400 rather than a silently dropped field.
- **Refactor:** the structural `timestamp` schema now exists twice — here and in
  `hl/connection.ts`. Leave both. Two occurrences is a coincidence; Slice 3 is the third
  and the moment to lift it into `functions/src/lib/`.

### T3 — `GET /api/users/me`  → AC-3, AC-4, AC-6, AC-7, AC-11

- **Red:** `tests/integration/users-profile.spec.ts`, `describe('GET /api/users/me')` —
  "returns the profile once one exists, with ISO-8601 timestamps"
  (`expect(new Date(s).toISOString()).toBe(s)` for both); "answers 200 `{ profile: null }`
  rather than 404 when there is none"; "refuses an unauthenticated caller with 401 and
  creates nothing"; "refuses an unverified caller with 403"; "fails closed on a stored
  document with no `email`, answering `{ profile: null }`".
- **Green:** `functions/src/users/profile.ts` — `handleGetProfile(_req, res, uid)`: read
  `${USERS}/${uid}`, `!exists` → `{ profile: null }`, `safeParse` failure →
  `logAuthEvent('profile.unreadable', { outcome: 'invalid' })` then `{ profile: null }`,
  otherwise `{ profile: toProfile(parsed.data) }`. Structurally identical to
  `handleGetConnection`. `functions/src/users/index.ts` mounts it through
  `asyncHandler(withVerifiedUser(...))`, **unattested** (D16); `functions/src/api/index.ts`
  mounts `usersRouter` at both `/` and `/api` before the 404, following the note in
  `hl/index.ts` about never using `router.use` for middleware on a doubly-mounted router.
- **Refactor:** none expected.

### T4 — `PUT /api/users/me`  → AC-1, AC-2, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10

- **Red:** same file, `describe('PUT /api/users/me')` — "creates the document and returns it,
  with the email from the Auth record and `displayName: null`"; "a second PUT preserves
  `createdAt` byte-for-byte and advances `updatedAt`"; "sets and then clears `displayName`";
  "rejects `{ uid: <bob's uid> }` with 400 `invalid_body`, leaving both documents untouched";
  "rejects `{ email: 'attacker@example.test' }` the same way"; "rejects an 81-character and a
  non-string `displayName`"; "refuses an unauthenticated caller with 401 and creates nothing";
  "refuses an unverified caller with 403"; "alice's calls return alice's email, never bob's,
  and leave bob's `updatedAt` unchanged".
  Two notes for whoever writes these: the AC-2 test must sleep ~50 ms between the two `PUT`s,
  because the wire format is millisecond-precision ISO and two back-to-back writes can land
  inside one millisecond — a flake, not a bug. And `tests/integration/helpers.ts` needs a
  `putJson(path, body, headers)` alongside the existing `postJson`/`getJson`/`deleteJson`.
- **Green:** `handlePutProfile(req, res, uid)`:
  1. `const body = parseBody(profileBodySchema, req)` — **first**, so a rejected body writes
     nothing (AC-8's "no document written, the caller's included").
  2. `const email = (await getAdminAuth().getUser(uid)).email?.trim() ?? ''`. Empty is
     unreachable in this product — every account is created by `/auth/register` with an
     address — so it is guarded rather than stored: log `profile.no_email` and throw
     `HttpError(500, 'Internal error', 'internal')`. An empty email written here would make
     `GET` answer `{ profile: null }` for that user until a repair. **No AC and no test;
     defensive.**
  3. `getDb().runTransaction` over `${USERS}/${uid}`: on absent, set
     `{ email, displayName: body.displayName ?? null, createdAt: serverTimestamp(),
     updatedAt: serverTimestamp() }`; on present, merge `{ email, updatedAt: serverTimestamp() }`
     plus `displayName` **only when the key was present in the body** — `'displayName' in body`,
     which under `exactOptionalPropertyTypes` is the difference between "clear it" (explicit
     `null`) and "leave it" (absent). A transaction rather than a bare merge so that two tabs
     ensuring at once cannot both write `createdAt`.
  4. Re-read, `storedProfileSchema.safeParse`, respond `{ profile: toProfile(...) }`. A parse
     failure here is after our own complete write: log `profile.unreadable` and throw
     `HttpError(500, 'Internal error', 'internal')`. **No AC and no test; defensive.**
  Route: `usersRouter.put('/users/me', attested, asyncHandler(withVerifiedUser(handlePutProfile)))`
  — attested, unlike the `GET` (D16), matching `DELETE /hl/connection`.
- **Refactor:** pull the projection used by both handlers into one place if T3 and T4 ended
  up with two copies.

### T5 — extract `apiClient` and refactor `hlApi` onto it  → AC-23

- **Red:** `frontend/src/lib/apiClient.spec.ts` — "sends the ID token as a Bearer header";
  "sends the App Check header"; "reads a fresh token per request"; "throws `ApiError` before
  fetching when nobody is signed in"; "maps a network failure to status 0 with actionable
  copy"; "prefers the server's message on a failure"; "tells a throttled caller to wait".
  Mock `@/lib/firebase` and `@/lib/appCheck` exactly as `hlApi.spec.ts` does.
- **Green:** `frontend/src/lib/apiClient.ts` holding `authHeader()` (private) and
  `request<T>()` (exported), moved **verbatim** from `hlApi.ts` — same header merge order,
  same `ApiError` construction. `hlApi.ts` deletes its copies and imports `request`.
- **Refactor:** `hlApi.ts`'s module docstring keeps its "none of them reads Firestore"
  paragraph; it is now true of the whole frontend rather than of one module, and the comment
  should say so.
- **The assertion is a negative one:** `hlApi.spec.ts` is not edited. If it needs editing,
  the extraction was not verbatim.

### T6 — `profileApi`  → AC-22 (parsing half)

- **Red:** `frontend/src/lib/profileApi.spec.ts` — "`getProfile()` GETs `/api/users/me`";
  "returns `null` when the server answers `{ profile: null }`, as a value and not an error";
  "`ensureProfile()` PUTs `/api/users/me`"; "surfaces the server's message on a 400".
- **Green:** `frontend/src/lib/profileApi.ts` over `request` from `./apiClient`.
  `ensureProfile()` sends `body: '{}'` with `Content-Type: application/json` so the request
  deterministically reaches the route as `{}` and actually exercises the parse boundary.
  `getProfile(): Promise<Profile | null>`; `ensureProfile(): Promise<Profile>` — the `PUT`
  never answers null on success.
- **Refactor:** none expected.

### T7 — the profile store  → AC-22

- **Red:** `frontend/src/stores/profile.spec.ts` — "`ensure()` issues `PUT /api/users/me`
  carrying an Authorization and an App Check header" (asserted through a mocked `fetch`, as
  `hlApi.spec.ts` does, so the header assembly is genuinely exercised); "stores the profile
  it gets back"; "records the server's message and clears `loading` on a failure"; "a second
  `ensure()` after a failure clears the error"; "`load()` leaves `profile` null and sets
  `loaded` when the server answers `{ profile: null }`"; "`loading` is true only for the
  first request in flight".
- **Green:** `frontend/src/stores/profile.ts`, shaped like `stores/hl.ts` — an explicit
  `ProfileStore` interface, `loading` true only on first load so a refetch does not blank the
  card, `error: Ref<string | null>` from `err instanceof Error ? err.message : <fallback>`,
  and `loaded` to distinguish "not fetched yet" from "fetched, and there is nothing". Comment
  on `load()` per P1: read half of the contract, Slice 3's `projects` store is its first
  in-app caller.
- **Refactor:** none expected.

### T8 — `AccountCard`  → AC-17, AC-18, AC-19, AC-20

- **Red:** `frontend/src/components/AccountCard.spec.ts` — "shows the loading state and no
  email while the request is in flight"; "shows `displayName` when there is one, the email
  otherwise"; "puts the address in `data-testid=\"dashboard-email\"`"; "renders a Member
  since date from `createdAt`"; "shows the empty state and no error when the profile is
  null"; "shows the server's message with a Retry button on a failure"; "clicking Retry
  re-issues the request".
- **Green:** `frontend/src/components/AccountCard.vue`, following `ConnectionPanel.vue`'s
  structure exactly — a `Card` with `data-testid="account-card"`, then
  `v-if` loading → `v-else-if` error → `v-else-if` profile → `v-else` empty. Test ids:
  `account-loading` (animate-pulse skeletons), `account-error` + `account-retry`,
  `account-empty` ("Setting up your profile…"), `account-name`, `dashboard-email`,
  `account-member-since`. Retry calls `profile.ensure()`.
  Date formatting is pinned — `Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short',
  year: 'numeric', timeZone: 'UTC' })` — because an unpinned locale or zone makes the
  assertion depend on the machine CI happens to run on.
- **Refactor:** none expected.

### T9 — wire the views onto the profile store, and delete `authStore.ensureProfile`  → AC-21

- **Red:** `frontend/src/views/DashboardView.spec.ts` — "ensures the profile on mount";
  "still renders the connection panel and the projects card when the profile request fails"
  (AC-21; the sign-out control lives in `App.vue`, not this view, and is covered by the e2e
  — stated here so the gap is deliberate rather than missed). Update
  `VerifyEmailView.spec.ts` and `AuthActionView.spec.ts` to expect `profile.ensure()` where
  they expect `ensureProfile` today. `frontend/src/stores/auth.spec.ts` loses its
  `ensureProfile` describe block and its `firebase/firestore` mock.
- **Green:** `DashboardView.vue` renders `<AccountCard />`, calls `profile.ensure()` in
  `onMounted`, and drops both `useAuthStore` and the "You're signed in as …" paragraph —
  the card now says who you are, and keeping both would duplicate `dashboard-email`.
  `VerifyEmailView.vue` and `AuthActionView.vue` swap `auth.ensureProfile()` for
  `profile.ensure()`. `stores/auth.ts` deletes `ensureProfile`, `USERS_COLLECTION`, the
  `ensureProfile` member of `AuthStore`, and both the `firebase/firestore` and `db` imports.
- **Refactor:** `stores/auth.ts`'s docstrings still describe Firestore rules as the thing
  that makes an unverified session inert. After this slice the enforcement is
  `withVerifiedUser` and rules are the backstop; correct the comments in `auth.ts` and
  `VerifyEmailView.vue` rather than leaving them describing an architecture that no longer
  exists.

### T10 — remove `db`, the Firestore emulator wiring, and the two env vars  → AC-27

- **Red:** `frontend/src/lib/firebase.spec.ts` — "exposes app and auth, and no `db`"
  (`expect('db' in mod).toBe(false)`); "boots with neither `VITE_FIREBASE_DATABASE_ID` nor
  `VITE_FIRESTORE_EMULATOR_PORT` set" (stub `import.meta.env` for the module, import it,
  expect no throw). Remove the `firebase/firestore` mock from that file.
- **Green:** `lib/firebase.ts` drops the `firebase/firestore` import, the `databaseId`
  `required()` call, and the `db` export; `connectFirestoreEmulator` goes from the emulator
  block, **and the block itself and its `data-genesis-emulator` marker stay**. Remove both
  variables from `frontend/src/env.d.ts`, from `EMULATOR_ENV` in `frontend/vite.config.ts`,
  from `frontend/.env.example`, and from `.env.example` — including the root file's
  `FIRESTORE_DATABASE_ID` comment, which cross-references the removed frontend variable.
- **Refactor:** the `required()` docstring's example is still correct; leave it.

### T11 — rules to deny-all, and the L3 suite rewritten  → AC-12, AC-13, AC-14, AC-15, AC-16

- **Red:** `tests/rules/firestore.spec.ts` rewritten so that **every case is a denial**.
  The `users/{uid}` block becomes: verified owner denied read; denied create; denied update;
  denied delete; a different verified user denied read and write; an unauthenticated client
  denied read and write. `hlConnections` and `authThrottle` keep their existing cases
  verbatim (AC-15 — re-asserted because the file was rewritten), as does the
  unknown-collection case (AC-16). `seedProfile()` stays, since update and delete need
  something to be denied *on*; the `describe('users/{uid} — the owner')` block with its three
  `assertSucceeds` goes entirely.
- **Green:** `firestore.rules` — delete `signedIn()`, `isOwner()` and `verified()`, and
  replace the `users/{uid}` block with:
  ```
  match /users/{uid} {
    allow read, write: if false;
  }
  ```
  Rewrite the header comment to state what the file now is: enforcement lives in the API
  routes, which authenticate the caller and scope every query by the uid from the token;
  this file is the backstop that makes a mistake in a route a bug rather than a breach, and
  every match block in it is a denial.
- **Refactor:** none. Do not delete `firestore.indexes.json` — it is untouched and still
  deployed.

### T12 — the ESLint ban and the source scan  → AC-24, AC-25

- **Red:** `frontend/src/lib/no-firestore.spec.ts` — "no file under `frontend/src` imports
  from `firebase/firestore`". Recursively walk `src`, read every `.ts`/`.vue`, match
  `/from\s+['"]firebase\/firestore/`, and report the offenders by path so a failure names
  the file. Per P5 it skips its own filename and builds the needle by concatenation.
  Verify the test is genuinely red first — run it on the tree *before* T10 landed, or add a
  throwaway import, confirm the failure, and remove it.
- **Green:** `frontend/eslint.config.js` — add to the existing `no-restricted-imports` entry:
  ```js
  patterns: [
    {
      group: ['firebase/firestore', 'firebase/firestore/*'],
      message:
        'The frontend never talks to Firestore directly. Every read and write goes through a Cloud Function route that verifies the ID token and scopes by the uid in it — see CLAUDE.md and docs/slices/02b-api-data-access/.',
    },
  ],
  ```
  `patterns` rather than `paths` so `firebase/firestore/lite` is covered too. The existing
  `firebase/auth` `paths` entry stays untouched.
- **Refactor:** none. `npm run lint` already runs with `--max-warnings 0`, so the rule needs
  no CI wiring of its own (AC-25).

### T13 — the bundle check  → AC-26

- **Red:** `scripts/check-no-firestore.spec.mjs` — "passes on a directory with no marker";
  "fails on a directory containing `firestore.googleapis.com`, naming the file"; "fails on a
  directory that does not exist". Fixtures are built with `mkdtempSync(join(tmpdir(), …))`,
  not committed. Needs the P4 wiring in the same commit or the spec has no runner.
- **Green:**
  - `scripts/check-no-firestore.mjs`, in the style of `scripts/test-emulator-config.mjs`
    (`#!/usr/bin/env node`, node: imports, a docstring that says why it exists): exports
    `MARKER = 'firestore.googleapis.com'` and `filesContainingMarker(dir)`; the CLI block is
    guarded by `import.meta.url === pathToFileURL(process.argv[1]).href` so importing it in
    the spec does not run it. Directory from `process.argv[2]`, defaulting to
    `frontend/dist`. Missing directory → non-zero with a message naming `npm run build`
    (P6). Hit → non-zero listing the offending files. Clean → exit 0 with one line.
  - `vitest.config.mts` at the repo root, `include: ['scripts/**/*.spec.mjs']`,
    `environment: 'node'`.
  - `package.json`: `"test:scripts": "vitest run"`, and `test:unit` becomes
    `npm --prefix functions run test && npm --prefix frontend run test && npm run test:scripts`.
  - `.github/workflows/ci.yml`: a step **after** Build —
    `- name: No Firestore SDK in the bundle` / `run: node scripts/check-no-firestore.mjs frontend/dist`.
- **Refactor:** none.
- **Confirm by hand in this task:** `npm run build && node scripts/check-no-firestore.mjs frontend/dist`
  exits 0. Measured on `main` the same command finds `dist/assets/firebase-*.js`. If it still
  finds something after T10, the cause is a transitive import and the fix belongs in this
  slice (R3) — not a deferral.

### T14 — the end-to-end path  → AC-28

- **Red:** `tests/e2e/auth.spec.ts` — after `Continue` lands on `/dashboard`, assert
  `account-card` is visible and `account-member-since` has rendered, alongside the existing
  `dashboard-email` assertion; and assert the same after `page.reload()`. That is the proof
  the address now comes from `GET`/`PUT /api/users/me`.
- **Green:** no production code — the assertion should pass on the work already done. If it
  does not, the failure is real and belongs to whichever earlier task owns it.
- **Refactor:** the file's docstring and two inline comments still say "the dashboard's
  Firestore read succeeds" and "the Firestore-backed session is live". Rewrite them: what is
  now being proved is that the refreshed ID token satisfied `withVerifiedUser`'s
  `email_verified` check on the profile routes.

## Firestore rules changes

The whole file, after T11 — `hlConnections` and `authThrottle` unchanged, `users/{uid}`
reduced, three helper functions deleted with their last caller:

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // --- user profile ---------------------------------------------------
    match /users/{uid} {
      allow read, write: if false;
    }

    // --- HighLevel OAuth tokens -----------------------------------------
    match /hlConnections/{uid} {
      allow read, write: if false;
    }

    // --- auth rate-limit counters ---------------------------------------
    match /authThrottle/{key} {
      allow read, write: if false;
    }
  }
}
```

The header comment is rewritten to say that enforcement lives in the API routes and this
file is the backstop, so a reader can tell at a glance that no `allow` here is load-bearing.

**The L3 tests that prove it** (`tests/rules/firestore.spec.ts`, every one a denial):

| Case | AC |
|---|---|
| Verified owner denied `getDoc` on `users/{uid}` | AC-12 |
| Verified owner denied `setDoc` (create), `updateDoc`, `deleteDoc` on their own profile | AC-13 |
| A different verified user denied read and write on `users/alice` | AC-14 |
| An unauthenticated client denied read and write on `users/alice` | AC-14 |
| Verified owner denied read, write and delete on `hlConnections/{uid}`; stranger and anon denied | AC-15 |
| Every client denied read and write on `authThrottle/{key}` | AC-15 |
| `projects/anything` and `somethingNew/doc` denied to a verified user | AC-16 |

`seedProfile()` (via `withSecurityRulesDisabled`) stays, because update and delete need a
document to be denied on. The three `assertSucceeds` cases in
`describe('users/{uid} — the owner')` are deleted — there is nothing left that succeeds.

## Dependencies

**None.** `zod` is already a `functions` dependency; `vitest` is already a root
devDependency, which is what P4's root config runs on. `firebase` stays in the frontend's
`dependencies` — Auth and App Check need it (D11). Nothing is added or removed from any
`package.json` except the `test:scripts` script.

## Manual verification

On emulators, from a clean tree:

1. `npm run dev` — emulators plus the SPA in emulator mode.
2. Sign up with a fresh address; get held at the verification gate; open the link the Auth
   emulator issued.
3. Land on `/dashboard`. The account card shows a brief loading state, then the address and
   **Member since \<today\>**. The connection panel renders beside it, unchanged.
4. Refresh. The card renders again; in the Firestore emulator UI, `users/{uid}`'s `createdAt`
   has not moved and `updatedAt` has.
5. In devtools' network tab: `PUT /api/users/me` carries `Authorization: Bearer …`; there is
   **no** request to `firestore.googleapis.com` and no Firestore listen channel.
6. Stop the functions emulator and refresh. The card shows its error state with a Retry
   button; the connection panel and the header's sign-out still work. Start the emulator,
   click Retry, and the card fills in (D17, AC-21).
7. `curl -X PUT $API/api/users/me -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"uid":"someone-else"}'`
   → `400 {"error":…,"code":"invalid_body"}`, and no document written.
8. `npm run build && node scripts/check-no-firestore.mjs frontend/dist` → exits 0. On `main`
   the same command exits non-zero naming `dist/assets/firebase-*.js`; the `firebase-*.js`
   chunk should also have shrunk noticeably from 598 kB. **Both numbers go in the PR as the
   demo evidence.**
9. `npm test` (typecheck, lint, unit, rules, integration) and `npm run test:e2e` both green.

## AC coverage

Every acceptance criterion maps to at least one task; none is unmapped.

| AC | Task | AC | Task |
|---|---|---|---|
| AC-1 | T4 | AC-15 | T11 |
| AC-2 | T4 | AC-16 | T11 |
| AC-3 | T3 | AC-17 | T8 |
| AC-4 | T3 | AC-18 | T8 |
| AC-5 | T4 | AC-19 | T8 |
| AC-6 | T3, T4 | AC-20 | T8 |
| AC-7 | T3, T4 | AC-21 | T9 |
| AC-8 | T1, T2, T4 | AC-22 | T6, T7 |
| AC-9 | T1, T2, T4 | AC-23 | T5 |
| AC-10 | T4 | AC-24 | T12 |
| AC-11 | T2, T3 | AC-25 | T12 |
| AC-12 | T11 | AC-26 | T13 |
| AC-13 | T11 | AC-27 | T10 |
| AC-14 | T11 | AC-28 | T14 |

Two code paths carry **no** AC and **no** test, both in T4 and both flagged above: an Auth
record with no email, and a document that fails to parse immediately after we wrote it. Both
are unreachable in this product and both fail closed with a 500 and a log line. They are
recorded rather than tested because a test for them would have to fake a state the system
cannot produce.

## Estimate

| Task | Estimate |
|---|---|
| T1 `parseBody` | 30 min |
| T2 users schemas | 45 min |
| T3 `GET /api/users/me` | 1 h |
| T4 `PUT /api/users/me` | 2 h |
| T5 `apiClient` extraction | 45 min |
| T6 `profileApi` | 30 min |
| T7 profile store | 45 min |
| T8 `AccountCard` | 1 h 15 min |
| T9 view wiring + auth store cleanup | 1 h 15 min |
| T10 remove `db` and env vars | 45 min |
| T11 rules + L3 rewrite | 1 h |
| T12 ESLint ban + source scan | 45 min |
| T13 bundle check + CI wiring | 1 h |
| T14 e2e | 30 min |
| **Total** | **≈ 12 h 45 min** — a day and a half |

Nothing individually exceeds half a day. **T4 is the one to watch:** it carries nine ACs, the
transaction, and R1's whole defence. If it runs long, the cause will be the `PUT`'s
create-versus-touch branching, and the split to make is T4a (create and touch, AC-1/AC-2/AC-5)
then T4b (the boundary, AC-6 to AC-10) — not dropping the transaction.
