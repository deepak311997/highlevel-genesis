# Slice 02b — API-only data access · PRD

**Spec:** F9.4 (architecture) · **Branch:** `slice/02b-api-data-access` · **Depends on:** 2 · **Date:** 2026-08-17

## Problem

Genesis has two data-access patterns and is about to grow a third collection under
whichever one gets typed first. Slice 1 let the browser write `users/{uid}` with the
Firestore client SDK under owner-scoped rules; Slice 2 kept `hlConnections/{uid}` entirely
server-side, denied to every client including its owner. Both work. Having both is the
problem: every collection from Slice 3 on has to re-litigate which one it belongs to, the
rules file has to carry two philosophies at once, and a reviewer reading `firestore.rules`
cannot tell whether an `allow` is the enforcement or the backstop.

**The decision was taken on 2026-08-17 and is recorded in `IMPLEMENTATION_PLAN.md` §8:
data access is API-only.** It is retroactive, so this slice pays the migration cost once,
on the one collection that predates it, before Slice 3 adds a second.

## The demo

Sign in and see the dashboard's account card render your profile — name, address, member
since — fetched from `GET /api/users/me` rather than from Firestore, then show that
`frontend/dist` contains no Firestore SDK at all: `grep -rl "firestore.googleapis.com"
frontend/dist` returns nothing, where on `main` today it returns `assets/firebase-*.js`.

## Decisions

No interview was run: this slice ships under the unattended loop, so every question below
was answered from `IMPLEMENTATION_PLAN.md` §0/§4/§8, `CLAUDE.md`'s non-negotiables,
`PRODUCT_SPEC.md` §5, and the merged code of Slices 1 and 2. The rejected alternative is
recorded for each load-bearing one, because a decision with no rejected alternative was
not a decision.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Does this slice migrate `users/{uid}`, or only establish the pattern for new collections? | **Migrate.** `users/{uid}` moves behind the API here, and the client-write rules for it are deleted in the same commit. | The whole point is that the codebase carries **one** data-access pattern before Slice 3. Establishing the pattern while leaving a counterexample in the tree means every later slice inherits the question this slice exists to close, and the counterexample is the one a reader finds first — it is in the auth store, on the golden path. Rejected: pattern-only, migrate later. "Later" is Slice 13, and Slice 13 is the deliverables slice. |
| D2 | What path shape do the profile routes take? | **`/api/users/me`.** The literal `me`, never `/api/users/:uid`. | The trap named in `IMPLEMENTATION_PLAN.md` §4 for this slice is a route that authenticates the caller and then trusts a uid it was handed. `/me` makes another user's id **inexpressible in the request** — there is no parameter to confuse with the token's uid, so the mistake cannot be made by omission, only by deliberately writing new code to make it. Rejected: `/api/users/:uid` with an equality check against the token. That works and it is one forgotten line away from a cross-tenant read; the check is exactly the code that gets copied into the next route without its guard. |
| D3 | Which verbs? | **`GET /api/users/me`** (read) and **`PUT /api/users/me`** (idempotent ensure). | `PUT` is the honest verb for `ensureProfile()`'s existing contract — create if absent, touch if present, same result however many times you call it. Rejected: `POST /api/users/ensure`, which is a procedure wearing a URL; and a `GET` that creates on read, which puts a write behind the one verb every cache, prefetcher and retry in the stack assumes is free. |
| D4 | Does a missing profile answer 404 or 200 with null? | **200 `{ "profile": null }`.** | "Verified, signed in, profile not created yet" is a *normal* state — it is where a user sits between verifying and the first ensure — and it is the account card's empty state. A 404 forces the client to translate an ordinary state out of an error channel, and the first client that forgets shows an error screen to a healthy account. |
| D5 | Where does the profile get created, now that the client cannot create it? | **`PUT /api/users/me`, called once per verified session** — from the same three places `ensureProfile()` is called today (`AuthActionView` after verification, `VerifyEmailView`, `DashboardView` mount). Behaviour-preserving. | Rejected: creating the profile inside `/api/auth/register`. Slice 1 made an unverified account deliberately inert, and the never-verified sweep deletes those accounts wholesale; giving them profile documents means the sweep grows a cascade, for a document nobody can read until they verify anyway. |
| D6 | Who supplies the `email` stored on the profile? | **The server, from the decoded ID token / Admin Auth record. Never the request body.** | It is the same field Slice 1's rules made immutable (`email` is Firebase Auth's to own). Moving the write server-side without moving the *source* of the value would trade a rules-enforced invariant for an unenforced one. |
| D7 | Does `PUT` accept a body at all? | **Yes — an optional, `.strict()` Zod object `{ displayName?: string \| null }`.** Unknown keys are a **400**, not ignored. | Two reasons. First, the architecture decision has two halves — "scopes by uid from the token" *and* "parses the payload with Zod" — and a slice with no request body anywhere ships the second half unproven and hands Slice 3 a boundary helper nobody has ever run. Second, `.strict()` turns the trap into an assertion: a body carrying `uid` or `email` is rejected outright, which is a crisper guarantee than "we happened not to read that field". Rejected: no body at all. |
| D8 | Is there a UI for setting `displayName`? | **No.** The field is readable and rendered; nothing in this slice writes it. | Scope ceiling. A profile-settings surface is not in the brief and does not become in-scope because an endpoint could support it. D7's body exists to prove the parse boundary, and it is proven by L1 and L4, not by a form. |
| D9 | What happens to `users/{uid}` in `firestore.rules`? | **`allow read, write: if false`** — the same shape as `hlConnections`. The field allowlist, the `createdAt == request.time` pin and the immutability diff all go. | Those rules were the guardrails on a *client* write. With no client write they are dead code that reads like live enforcement, which is worse than nothing: the next person to touch the file has to work out whether the `allow create` is reachable. Shape is now enforced by Zod at the route and by the Admin SDK's own writes. |
| D10 | What is left in `firestore.rules` after that? | **Nothing but denials**, plus one comment block stating that enforcement lives in the API and that this file is the backstop. `signedIn()`, `isOwner()` and `verified()` are deleted with their last caller. | This is the property the architecture decision buys: a mistake in a route is a bug, not a breach. A rules file that is uniformly `if false` says that at a glance. |
| D11 | Does the frontend keep the Firestore client SDK for anything? | **No.** `db` and `connectFirestoreEmulator` are removed from `lib/firebase.ts`, and `VITE_FIREBASE_DATABASE_ID` / `VITE_FIRESTORE_EMULATOR_PORT` stop being frontend configuration. `firebase` stays in `dependencies` — Auth and App Check need it. | `CLAUDE.md` permits `firebase/firestore` "in the emulator wiring", but once nothing reads Firestore there is no emulator wiring to keep, and an unused `db` export is an invitation. Removing it entirely is also what makes D12's ban absolute — a rule with zero exceptions needs no allowlist to maintain. |
| D12 | How is the ban enforced rather than merely intended? | **Three layers.** (1) ESLint `no-restricted-imports` on `firebase/firestore` — the mechanism, and `npm run lint` already tolerates zero warnings. (2) An L1 test that scans `frontend/src` and fails on any import of it, so the guarantee survives someone editing the ESLint config. (3) `scripts/check-no-firestore.mjs`, run in CI after `npm run build`, asserting the built bundle contains no Firestore SDK. | A convention that lives only in `CLAUDE.md` is a convention until the first hurried commit. The ESLint config already carries a precedent for exactly this — Slice 1 banned `createUserWithEmailAndPassword` there for the same class of reason. |
| D13 | What string does the bundle check grep for? | **`firestore.googleapis.com`.** | Measured, not guessed: on `main` today an emulator-mode build puts that string in `dist/assets/firebase-*.js`, and it is present only when `@firebase/firestore` is bundled. A bare `grep firestore` over `dist/` is the demo line in `IMPLEMENTATION_PLAN.md` §4 but is the wrong assertion for CI — it would also match incidental identifiers and turn a security guarantee into a flaky one. |
| D14 | Which frontend module owns the authenticated fetch? | **A new `frontend/src/lib/apiClient.ts`,** extracted verbatim from the `request<T>()` already inside `hlApi.ts` (ID token per call, App Check header, `ApiError` mapping). `hlApi.ts` is refactored onto it with no behaviour change. | The reusable half of this slice matters more than the migration. Extracting it and leaving `hlApi` on its private copy would ship two clients that drift — which is exactly the failure `messageForResponse` was consolidated out of during Slice 2's review. |
| D15 | Which store owns the profile? | **A new `frontend/src/stores/profile.ts`.** `ensureProfile()` leaves the auth store entirely. | The auth store owns the Firebase session; the profile is a resource fetched over HTTP. Splitting them is what lets `stores/auth.ts` lose its `firebase/firestore` import rather than merely swap it, and it is the shape Slice 3's `projects` store will copy. |
| D16 | App Check on the new routes? | **On `PUT`, not on `GET`** — identical to Slice 2's split (`DELETE /hl/connection` attested, `GET /hl/connection` not). | One rule to remember across the whole API: mutations are attested, plain authenticated reads are not, since attestation buys nothing against a caller already holding a valid ID token. |
| D17 | What does the user see when the profile request fails? | **The account card renders an error with a Retry button. The session is never blocked** — sign-out, the connection panel and the rest of the dashboard keep working. | Slice 1 decided a profile is a convenience, not a precondition, and swallowed the failure *silently* because there was nowhere to say it. That half stands; the silence does not. There is now a card whose job is to say it. |
| D18 | How does a corrupt stored document read? | **Fail closed: `GET` answers `{ profile: null }` and logs `profile.unreadable`.** A subsequent `PUT` repairs it. | The precedent is `handleGetConnection` — parse, don't assert. Emitting a half-populated profile hides corruption behind a screen the user cannot act on; answering "not created yet" is both truthful and self-healing on the next ensure. |
| D19 | How do timestamps cross the wire? | **ISO-8601 strings.** `createdAt` and `updatedAt` are Admin `FieldValue.serverTimestamp()` in Firestore, `.toDate().toISOString()` on the wire. | Matches `connectedAt` in the Slice 2 connection projection. One convention for the whole API. |
| D20 | Does this slice add an L5 test? | **No new spec — one assertion added to the existing `tests/e2e/auth.spec.ts`.** | The demo path already runs through that file (sign up → verify → dashboard → refresh), and the only change is where `dashboard-email` gets its value. `IMPLEMENTATION_PLAN.md` §2 budgets one L5 per slice and this slice's L5 already exists; a second file walking the same path would be the same minutes spent twice. |
| D21 | Is `/api/users/**` reserved? | **Yes**, for user-scoped resources. Slice 3 takes `/api/projects/**`. | The same reservation discipline Slice 2 applied to `/api/hl/proxy/**` (D24 there). Cheap now, awkward later. |
| D22 | Is this one reviewable PR? | **Yes.** Two new function modules, one rules simplification, four frontend files touched, one new component, plus tests. No new dependency. | Checked deliberately, because a migration slice is where scope quietly doubles. The things that would have doubled it — a settings form (D8), a `PATCH` route, migrating anything that does not exist yet — are all recorded as out of scope below. |

## In scope

- `GET /api/users/me` — authenticated profile read, `{ profile }` or `{ profile: null }`
- `PUT /api/users/me` — authenticated, attested, idempotent ensure; strict Zod body
- `functions/src/users/` — router, handlers, and the stored-document schema
- `functions/src/lib/parse.ts` — `parseBody(schema, req)`, the Zod half of the boundary
  helper, throwing `HttpError(400, …, 'invalid_body')`
- `firestore.rules` — `users/{uid}` reduced to deny-all; dead helpers removed
- `frontend/src/lib/apiClient.ts` — the shared authenticated fetch, extracted from `hlApi.ts`
- `frontend/src/lib/profileApi.ts` — typed client for the two routes
- `frontend/src/stores/profile.ts` — replaces `authStore.ensureProfile()`
- `frontend/src/components/AccountCard.vue` — loading, empty, error and loaded states, and
  the new home of `data-testid="dashboard-email"`
- Removal of `db` / Firestore emulator wiring / `VITE_FIREBASE_DATABASE_ID` from the frontend
- ESLint ban, source scan test, and `scripts/check-no-firestore.mjs` + its CI step
- `.env.example` (root and `frontend/`) updated for the removed variables

## Out of scope

| Not here | Picked up by |
|---|---|
| A profile settings screen, or any UI that writes `displayName` (D8) | Not planned. Revisit if a slice needs it. |
| `DELETE /api/users/me` / account deletion | Not planned — Slice 1's rules already say deletion belongs to a function that also revokes tokens and cascades |
| `projects`, `files`, `snapshots`, `messages` routes | Slices 3, 4, 6, 11 — each inherits this slice's route shape, boundary helper and L3 denial pattern |
| Migrating `hlConnections` | Nothing to migrate: it was server-only from birth |
| A generic CRUD framework or route factory | Deliberately not built. Two routes is not enough evidence to abstract from; Slice 3 is where the third and fourth arrive and the shape can be judged |
| Pagination, cursors, list endpoints | Slice 3 — `projects` is the first collection with more than one document per user |
| Replacing SSE liveness or adding polling | Not needed — nothing in this slice is live |

## User flow

1. A verified user lands on `/dashboard`. The account card shows a **loading** state.
2. The dashboard calls `profile.ensure()` → `PUT /api/users/me` with `Authorization: Bearer <id token>` and an App Check header. The server reads the uid **from the token**, upserts `users/{uid}` with the Admin SDK, and returns the profile.
3. The card renders **name (or address) · address · Member since \<date\>**.
4. Refreshing the page repeats step 2. `createdAt` does not move; `updatedAt` does.
5. On a fresh sign-in that has not yet ensured, any read path calls `GET /api/users/me`; if it answers `{ profile: null }` the card shows its **empty** state until the ensure lands.
6. If either call fails, the card shows an **error** with **Retry**. The rest of the dashboard — connection panel, sign-out — is unaffected.

The same flow runs from `VerifyEmailView` and `AuthActionView` at the moment verification
completes, exactly as `ensureProfile()` does today.

## Data model

**`users/{uid}`** — unchanged fields, changed writer. Written only by the Admin SDK inside
`PUT /api/users/me`; no client may read or write it.

| Field | Type | Note |
|---|---|---|
| `email` | string | from the Auth record, never from the body (D6) |
| `displayName` | string \| null | optional, `.strict()`-parsed, ≤ 80 chars |
| `createdAt` | Timestamp | server clock, set once on create and never rewritten |
| `updatedAt` | Timestamp | server clock, advanced on every ensure |

**Wire shape** (`profile`): `{ email: string, displayName: string | null, createdAt: string, updatedAt: string }` — timestamps ISO-8601 (D19).

**Rules change.** `users/{uid}` becomes:

```
match /users/{uid} {
  allow read, write: if false;
}
```

and the `signedIn()` / `isOwner()` / `verified()` helpers are deleted with their last
caller (D10). `hlConnections` and `authThrottle` are unchanged and re-asserted by tests.
After this slice, **every match block in `firestore.rules` is a denial** — which is the
statement the architecture decision wants the file to make.

**Indexes:** none. Single-document reads by id.

## API contracts

Both routes are mounted on the existing `api` function, at `/` and `/api` (the emulator
strips the function name, a Hosting rewrite does not), and both go through
`withVerifiedUser` — ID token **and** `email_verified`, Slice 1's D26.

### `GET /api/users/me`

Auth: Firebase ID token. App Check: not required (D16).

- **200** → `{ "profile": { "email": "…", "displayName": null, "createdAt": "2026-08-17T…Z", "updatedAt": "2026-08-17T…Z" } }`
- **200** → `{ "profile": null }` — no document yet, or a document that fails to parse (D18)
- **401** `unauthenticated` — missing, malformed or expired token
- **403** `email_unverified` — valid token, unverified address

### `PUT /api/users/me`

Auth: Firebase ID token. App Check: required (D16).

Request body: optional. `{}` or `{ "displayName": "Alice" }` or `{ "displayName": null }`.
Parsed `.strict()` — any other key is a 400.

- **200** → `{ "profile": { … } }` — created if absent, touched if present
- **400** `invalid_body` — unknown key (including `uid`, `email`, `createdAt`), wrong type, or `displayName` longer than 80 characters
- **401** `unauthenticated`
- **403** `email_unverified`

Every response body follows the existing error envelope: `{ "error": "<user-facing message>", "code": "<machine code>" }`.

## Edge cases and failure modes

| Situation | Behaviour | User sees | Retry? |
|---|---|---|---|
| Profile does not exist yet | `GET` → `{ profile: null }` | Card's empty state, "Setting up your profile…" | The ensure creates it |
| Ensure called twice (refresh, two tabs) | Idempotent upsert; `createdAt` preserved | Nothing — same card | n/a |
| Body carries `uid` or `email` | 400 `invalid_body`; **no document written, the caller's included** | n/a (no UI sends a body) | n/a |
| Caller holds a valid token for another account | Only their own `users/{uid}` is reachable — no request can name another | Their own profile | n/a |
| No token / expired token | 401 `unauthenticated` | Card error state; the router guard handles a genuinely expired session | Retry button |
| Verified-in-Auth but stale token claim | 403 `email_unverified` | Card error state, "Verify your email address first." | Retry after `getIdToken(true)` |
| Network failure / function cold-start timeout | `ApiError` with status 0 | Card error state, "Check your connection and try again." | Retry button |
| Stored document corrupt or half-written | `GET` fails closed, logs `profile.unreadable` | Empty state | Next ensure repairs it |
| Profile request fails entirely | Session unaffected; connection panel and sign-out still work (D17) | One failed card among working ones | Retry button |
| Someone adds `import { doc } from 'firebase/firestore'` | ESLint error, L1 scan failure, and a CI bundle-check failure | Red build | n/a |

## Acceptance criteria

**Routes — the happy path**

- **AC-1** — Given a verified caller with no `users/{uid}` document, when they `PUT /api/users/me`, then the response is 200 with a profile whose `email` matches their Auth record and whose `displayName` is `null`, and `users/{uid}` now exists with server-clock timestamps.
- **AC-2** — Given a verified caller who already has a profile, when they `PUT /api/users/me` again, then the response is 200, `createdAt` is byte-identical to the first response, and `updatedAt` is strictly later.
- **AC-3** — Given a verified caller with a profile, when they `GET /api/users/me`, then the response is 200 with that profile and both timestamps are ISO-8601 strings.
- **AC-4** — Given a verified caller with no profile, when they `GET /api/users/me`, then the response is 200 with `{ "profile": null }` — not 404.
- **AC-5** — Given a `PUT` body `{ "displayName": "Alice" }`, when it is accepted, then the stored and returned `displayName` is `"Alice"`; a subsequent `PUT` with `{ "displayName": null }` clears it.

**Routes — the boundary**

- **AC-6** — Given a request with no `Authorization` header, when it hits `GET` or `PUT /api/users/me`, then the response is 401 `unauthenticated` and no document is created.
- **AC-7** — Given a valid ID token whose `email_verified` claim is false, when it hits `GET` or `PUT /api/users/me`, then the response is 403 `email_unverified` and no document is created.
- **AC-8** — Given a `PUT` body carrying any key outside the schema — specifically `{ "uid": "<bob's uid>" }` and `{ "email": "attacker@example.test" }` — then the response is 400 `invalid_body`, the caller's document is unmodified, and the named user's document is unmodified.
- **AC-9** — Given a `PUT` body with `displayName` of 81 characters, or of a non-string type, then the response is 400 `invalid_body`.
- **AC-10** — Given verified users alice and bob who each have a profile, when alice calls `GET` and `PUT /api/users/me` with her own token, then every response contains alice's email and never bob's, and bob's `updatedAt` is unchanged afterwards.
- **AC-11** — Given a stored `users/{uid}` document missing its `email` field, when the owner calls `GET /api/users/me`, then the response is 200 `{ "profile": null }` and a `profile.unreadable` event is logged; a following `PUT` returns a complete profile.

**Rules — the backstop**

- **AC-12** — Given a verified owner using the Firestore client SDK, when they read `users/{uid}`, then the read is denied.
- **AC-13** — Given a verified owner using the client SDK, when they create, update or delete `users/{uid}`, then every write is denied.
- **AC-14** — Given a different signed-in user, and given an unauthenticated client, when either reads or writes `users/{uid}`, then it is denied.
- **AC-15** — Given any client, when it reads or writes `hlConnections/{uid}` or `authThrottle/{key}`, then it is denied — re-asserted, since the rules file was rewritten.
- **AC-16** — Given any client, when it touches a collection with no `match` block, then it is denied.

**Frontend**

- **AC-17** — Given the profile request is in flight, when the dashboard renders, then the account card shows its loading state and no email.
- **AC-18** — Given the request resolves with a profile, when the card renders, then it shows `displayName ?? email` and a "Member since" date derived from `createdAt`, and `data-testid="dashboard-email"` carries the address.
- **AC-19** — Given the request resolves with `{ profile: null }`, when the card renders, then it shows its empty state and no error.
- **AC-20** — Given the request rejects, when the card renders, then it shows the server's message with a Retry button, and clicking Retry re-issues the request.
- **AC-21** — Given the profile request has failed, when the dashboard renders, then the connection panel and the sign-out control are still present and functional.
- **AC-22** — Given the profile store's `ensure()`, when it issues the request, then the outgoing request is `PUT /api/users/me` carrying an `Authorization: Bearer` header and an App Check header.
- **AC-23** — Given `hlApi` after the refactor onto `apiClient`, when its three functions are exercised, then their existing behaviour — headers, error mapping, return shapes — is unchanged.

**The architectural guarantee**

- **AC-24** — Given the frontend source tree, when it is scanned, then no file under `frontend/src` imports from `firebase/firestore`.
- **AC-25** — Given a file that does import from `firebase/firestore`, when `npm run lint` runs, then it fails.
- **AC-26** — Given a production build of the frontend, when `scripts/check-no-firestore.mjs` runs against `frontend/dist`, then it finds no occurrence of `firestore.googleapis.com` and exits 0; given a bundle that contains it, the script exits non-zero.
- **AC-27** — Given an environment with no `VITE_FIREBASE_DATABASE_ID` and no `VITE_FIRESTORE_EMULATOR_PORT`, when the frontend boots, then it starts normally and neither variable appears in `frontend/.env.example`.

**End to end**

- **AC-28** — Given a new account, when it signs up, verifies, and lands on `/dashboard`, then the account card shows the registered address — sourced from `GET`/`PUT /api/users/me`, with no Firestore client traffic — and it survives a page refresh.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1 | L4 | `tests/integration/users-profile.spec.ts` | First `PUT` creates the document and returns it |
| AC-2 | L4 | `tests/integration/users-profile.spec.ts` | Second `PUT` preserves `createdAt`, advances `updatedAt` |
| AC-3 | L4 | `tests/integration/users-profile.spec.ts` | `GET` returns the profile; timestamps parse as ISO-8601 |
| AC-4 | L4 | `tests/integration/users-profile.spec.ts` | `GET` with no document → 200 `{ profile: null }` |
| AC-5 | L4 | `tests/integration/users-profile.spec.ts` | `displayName` set, then cleared |
| AC-6 | L4 | `tests/integration/users-profile.spec.ts` | No header → 401 on both verbs; collection stays empty |
| AC-7 | L4 | `tests/integration/users-profile.spec.ts` | Unverified token → 403 on both verbs |
| AC-8 | L4 | `tests/integration/users-profile.spec.ts` | `{uid}` / `{email}` bodies → 400; both documents untouched |
| AC-8, AC-9 | L1 | `functions/src/users/schema.spec.ts` | The strict Zod body: unknown key, wrong type, over-length |
| AC-9 | L4 | `tests/integration/users-profile.spec.ts` | 81-char and non-string `displayName` → 400 |
| AC-10 | L4 | `tests/integration/users-profile.spec.ts` | Two seeded users; alice's calls never touch or return bob's |
| AC-11 | L4 | `tests/integration/users-profile.spec.ts` | Seeded corrupt document → `{ profile: null }`, then repaired by `PUT` |
| AC-11 | L1 | `functions/src/users/schema.spec.ts` | Stored-document schema rejects a missing `email` |
| AC-8, AC-9 | L1 | `functions/src/lib/parse.spec.ts` | `parseBody` throws `HttpError(400, 'invalid_body')`; returns typed data on success |
| AC-12, AC-13 | L3 | `tests/rules/firestore.spec.ts` | Verified owner denied read, create, update, delete on `users/{uid}` |
| AC-14 | L3 | `tests/rules/firestore.spec.ts` | Stranger and anonymous client denied |
| AC-15 | L3 | `tests/rules/firestore.spec.ts` | `hlConnections` and `authThrottle` still denied to everyone |
| AC-16 | L3 | `tests/rules/firestore.spec.ts` | Unknown collection denied |
| AC-17, AC-18, AC-19, AC-20 | L2 | `frontend/src/components/AccountCard.spec.ts` | Loading, loaded, empty, error + Retry re-issues |
| AC-21 | L2 | `frontend/src/views/DashboardView.spec.ts` | A failed profile fetch leaves the rest of the dashboard rendered |
| AC-22 | L1 | `frontend/src/stores/profile.spec.ts` | `ensure()` issues `PUT /api/users/me` with both headers |
| AC-22 | L1 | `frontend/src/lib/profileApi.spec.ts` | Response parsing; `{ profile: null }` handled as a value, not an error |
| AC-23 | L1 | `frontend/src/lib/hlApi.spec.ts` | Existing suite passes unchanged against the extracted client |
| AC-23 | L1 | `frontend/src/lib/apiClient.spec.ts` | Token header, App Check header, `ApiError` mapping, network failure → status 0 |
| AC-24 | L1 | `frontend/src/lib/no-firestore.spec.ts` | Scans `frontend/src` for `firebase/firestore` imports; expects none |
| AC-25 | — | `frontend/eslint.config.js` | `no-restricted-imports` entry; verified by `npm run lint` in CI |
| AC-26 | L1 | `scripts/check-no-firestore.spec.mjs` | The script passes on a clean fixture directory and fails on one containing the marker |
| AC-26 | CI | `.github/workflows/ci.yml` | Step runs the script against the real `frontend/dist` after Build |
| AC-27 | L1 | `frontend/src/lib/firebase.spec.ts` | Boots with neither variable set; no `db` export |
| AC-28 | L5 | `tests/e2e/auth.spec.ts` | Existing golden path, now asserting the card's address survives a refresh |

## Definition of done

- [ ] Every acceptance criterion above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`, `test:e2e`
- [ ] `users/{uid}` rules reduced to deny-all, with L3 tests proving every client operation is denied
- [ ] Error paths from `PRODUCT_SPEC.md` F8 handled for this surface — the card's error state and its Retry
- [ ] Loading, empty and error states exist for the account card
- [ ] No secrets in source; root and `frontend/.env.example` updated for the removed variables
- [ ] Runs clean on `npm run dev` (emulators) from a fresh clone
- [ ] `grep -rl "firestore.googleapis.com" frontend/dist` returns nothing after `npm run build`
- [ ] No `firebase/firestore` import remains anywhere under `frontend/src`
- [ ] `README` delta: none expected — no setup step changes. Confirm at review.
- [ ] PR opened with demo evidence (the before/after bundle grep); **human approves before merge**

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **A route that authenticates the caller and then trusts a uid from the request.** The named trap for this slice. | Structural, not procedural: `/me` gives the request nowhere to put one (D2), and `.strict()` rejects a body that tries (D7). AC-8 and AC-10 assert both. |
| R2 | The rules rewrite loosens something by accident while deleting helpers. | The L3 suite is rewritten in the same commit and every case is a denial; AC-15 and AC-16 re-assert the collections that were not the subject of the change. |
| R3 | `dist` still contains the Firestore SDK because something else pulls it in transitively. | Measured on `main` before writing this PRD: the marker is present today and is contributed by `lib/firebase.ts` alone. If the build stage finds it surviving, the cause is a transitive import and the fix belongs in this slice, not deferred. |
| R4 | Extracting `apiClient` from `hlApi` regresses Slice 2's connection panel. | The extraction is verbatim and `hlApi.spec.ts` is not modified (AC-23) — an unchanged test suite over refactored code is the assertion. |
| R5 | The account card is new UI in a slice whose demo line is "the app behaves exactly as before". | It is the minimum that makes the slice vertical: without a visible read path the only proof of `GET /api/users/me` is an L4 test, and a slice that cannot be shown to a human is not a slice. Its scope is capped by D8 — render only, no write UI. |
| R6 | Removing `VITE_FIREBASE_DATABASE_ID` / `VITE_FIRESTORE_EMULATOR_PORT` breaks a path that still reads them. | Every reference was located during discovery: `frontend/vite.config.ts` (both), `frontend/src/env.d.ts` (both), `frontend/src/lib/firebase.ts`, `frontend/.env.example`, and the root `.env.example`. `scripts/test-emulator-config.mjs` does **not** read either. `FIRESTORE_DATABASE_ID` on the functions side is untouched. AC-27 asserts a boot with neither variable set. |

## Blocked

Nothing. Every question this slice raises is answered above.
