# Slice 02b — API-only data access · Review

**PRD:** `02-prd.md` · **Plan:** `03-plan.md` · **Build log:** `04-build-log.md`
· **Branch:** `slice/02b-api-data-access` · **Reviewed:** 2026-08-17

Reviewed as another author's PR: the full `main...HEAD` diff — 48 files, +4217 / −452, of
which 1929 lines are the four slice documents. The code diff is roughly 2300 lines across
two new function modules, four new frontend modules, one new component, the rules
simplification and the tests, which is at the top of the "acceptable for a single logical
change" band and is justified by D22 — a migration slice touches every layer once.

## Suite

Counts are from `.autopilot/logs/02b/gate-post-build.2.log`, the gate the orchestrator ran
on `3728445` before this stage started. The suites my own fixes touch were re-run here; the
rest were not re-run, because a second twenty-minute pass answers a question already
answered.

| Check | Result |
|---|---|
| `typecheck` | Pass — functions, frontend, root (re-run after fixes) |
| `lint` | Pass — `--max-warnings 0` on both packages (re-run after fixes) |
| `test:unit` — functions | 183 passed, 17 files |
| `test:unit` — frontend | 280 passed, 30 files → **282 passed, 30 files** after this review's two new cases (re-run) |
| `test:unit` — scripts | 11 passed, 2 files |
| `test:rules` | 12 passed, 1 file |
| `test:integration` | 86 passed, 8 files |
| `test:e2e` | 4 passed |

`prettier --check` reports the same four pre-existing offenders before and after this
review (`functions/src/hl/*`, `frontend/src/lib/hlApi.spec.ts`, `frontend/src/stores/hl.ts`).
Nothing I touched added one, and I reverted a stray reformat Prettier wanted to make to an
untouched line in `hl.ts` rather than widen the diff.

## AC coverage

| AC | Test | Verified |
|---|---|---|
| AC-1 | `tests/integration/users-profile.spec.ts` — creates and returns, email from the Auth record | ✅ |
| AC-2 | same — second `PUT` preserves `createdAt`, advances `updatedAt` (50 ms sleep, so "strictly later" is not a flake) | ✅ |
| AC-3 | same — `GET` returns the profile, both timestamps round-trip through `new Date(…).toISOString()` | ✅ |
| AC-4 | same — 200 `{ profile: null }`, asserted as the whole body so a 404 could not pass | ✅ |
| AC-5 | same — set, left alone by `{}`, then cleared by an explicit `null` | ✅ |
| AC-6 | same — 401 on both verbs, collection still empty | ✅ |
| AC-7 | same — 403 on both verbs | ✅ |
| AC-8 | same — `{uid}` and `{email}` → 400; caller's document absent, bob's `email` intact | ✅ |
| AC-8, AC-9 | `functions/src/users/schema.spec.ts`, `functions/src/lib/parse.spec.ts` | ✅ |
| AC-9 | `users-profile.spec.ts` — 81-char and non-string, table-driven | ✅ |
| AC-10 | same — bob's `updatedAt` compared by `toMillis()` before and after alice's calls | ✅ |
| AC-11 | same — corrupt document → `{ profile: null }`, then repaired by `PUT`; `schema.spec.ts` for the missing-`email` half | ✅ |
| AC-12, AC-13 | `tests/rules/firestore.spec.ts` — owner denied read, create, update, delete | ✅ |
| AC-14 | same — stranger and anonymous | ✅ |
| AC-15 | same — `hlConnections` and `authThrottle` re-asserted | ✅ |
| AC-16 | same — `projects/*` and an invented collection | ✅ |
| AC-17…AC-20 | `frontend/src/components/AccountCard.spec.ts` — 10 cases after this review | ✅ |
| AC-21 | `frontend/src/views/DashboardView.spec.ts` — panel and projects card survive a rejected ensure | ✅ |
| AC-22 | `frontend/src/stores/profile.spec.ts` (through a stubbed `fetch`, not a stubbed client) and `profileApi.spec.ts` | ✅ |
| AC-23 | `git diff main...HEAD -- frontend/src/lib/hlApi.spec.ts` is empty, and the suite passes over the refactored code; `apiClient.spec.ts` covers the extracted client | ✅ |
| AC-24 | `frontend/src/lib/no-firestore.spec.ts` | ✅ |
| AC-25 | `frontend/eslint.config.js` — the `patterns` entry exists and `npm run lint` is green. The **red** state was verified by hand during T12 (a throwaway importing `doc`), not re-verified here | ✅ (red state on the build log's word) |
| AC-26 | `scripts/check-no-firestore.spec.mjs`, 4 cases; CI step added after Build. The step has not run on real CI yet — it runs on the PR | ✅ (locally) |
| AC-27 | `frontend/src/lib/firebase.spec.ts` — no `db` export, boots with neither variable | ✅ |
| AC-28 | `tests/e2e/auth.spec.ts` — card, address and member-since, asserted before and after a reload | ✅ |

**The strongest tests in the diff.** AC-8's assertion is the second half — *nothing was
written, the caller's own document included* — which is what proves `parseBody` runs before
Firestore is touched rather than merely returning the right status. AC-24's scanner is
tested against eight forms of the import (side-effect, dynamic, `require`, `/lite`,
`@firebase/firestore`) and three innocents before it is trusted, which is the right instinct
for a guard whose green state is `toEqual([])` either way. T11's note that the three
`users/{uid}` write denials had to be rewritten to send the payload the *old* rules accepted
is the difference between a test that was red for the right reason and one that was red for
the wrong one.

## Findings

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | **Critical** | **Sign-out leaves the resource stores populated, so the next user signed in on the same browser is shown the previous user's data.** Sign-out is `signOut(auth)` followed by `router.push('/signin')` — a route change, not a page load, so Pinia survives it. `profile.loaded` stays `true`, which means `run()` does not set `loading`, which means `AccountCard` takes its `profile.profile` branch and renders **the previous user's email address in `dashboard-email`** until the new `PUT` resolves. On a cold Cloud Function that is seconds. The connection panel does the same with the previous user's CRM location name, via `status.value === null` — that half is pre-existing from Slice 2, and fixing only the new half would have left the drift. | **Fixed.** `reset()` on `stores/profile.ts` and `stores/hl.ts`, called from `auth.signOutNow()` — the one place a session ends, and the one both sign-out call sites (`App.vue`, `VerifyEmailView.vue`) already go through. Red test first in `stores/auth.spec.ts`. |
| 2 | Required | **`AccountCard` never read `profile.loaded`,** so "we have not asked yet" and "we asked, and there is nothing" rendered identically as the empty state. Both the store's docstring and `profile.spec.ts`'s AC-19 comment claim `loaded` is what tells the card them apart; it was not. The consequence: AC-19's card test passes just as well with `loaded: false`, so it did not prove what it claimed, and any consumer rendering the card before fetching gets "Setting up your profile…" for an account that has never been asked about. This is also the mechanism that made finding 1 visible rather than merely stale. | **Fixed.** Error branch moved first (a failed first request leaves `loaded` false, so a `!loaded` test placed above it would swallow the error); the loading branch is now `profile.loading \|\| !profile.loaded`. Red test first: `mountWith({ profile: null, loaded: false })` must show the skeleton, not the empty state. All nine existing cases still pass unchanged. |
| 3 | Required | **`.env.example` currency, a CLAUDE.md non-negotiable.** T10 updated the root `.env.example` for the deleted `VITE_FIREBASE_DATABASE_ID` but missed two other places that still told the reader to match it: `functions/.env.example:19` and the `getDb()` docstring in `functions/src/lib/firebase.ts`. Anyone setting up from a fresh clone is sent looking for a variable that no longer exists. | **Fixed.** Both now say the id is server-side only, and why. |
| 4 | Required | **The review skill's own reference contradicted the architecture decision.** `.claude/skills/feature-review/references/typescript-vue.md` still read "Pinia stores hold client state only — server state belongs to Firestore listeners." There are no Firestore listeners any more, and every future slice's review would have been handed that instruction. | **Fixed.** Replaced with what is actually true here — a store is a snapshot, refetch after mutation, and clear it when the session ends — with a pointer to finding 1's fix so the next reviewer knows where that lives. |
| 5 | Consider | **`apiClient.request()` lacks the content-type guard `apiGet()` has.** `lib/api.ts:40` deliberately turns a 200-carrying-HTML response — the SPA fallback answering because the Hosting rewrite or dev proxy is misconfigured — into a message that names the cause. `request()`, which this slice promotes to "the one authenticated fetch for every call the browser makes", goes straight to `res.json()`, and the resulting `SyntaxError` is not an `ApiError`, so the card renders "Unexpected token '<'…". Lifted verbatim from `hlApi.ts` (Slice 2), so not introduced here, but it is now the shared path. | **Deferred, recorded below.** Not fixed: it changes behaviour on a path no AC covers, and the honest fix is to move both clients onto one response reader — which is Slice 3's work, when there is a third caller to judge the shape against. |
| 6 | FYI | **App Check on `PUT /api/users/me` has no automated test.** `requireAppCheck` returns early under `FUNCTIONS_EMULATOR` (Slice 2's D21, deliberately), so L4 cannot assert it, and there is no L1 router-wiring test anywhere in the codebase. Dropping `attested` from the route would fail nothing. Identical to `/auth/register` and `DELETE /hl/connection`, so this slice follows precedent rather than setting one. | No action — a fix belongs at the router level for all three routes at once. |
| 7 | FYI | **Two emulators still port-hunt.** The gate log shows eventarc sliding 9299→9300 and tasks 9499→9500 — the same undeclared-port race the websocket fix closed for Firestore. Harmless here because no suite talks to either, and unlike Firestore's websocket a slide does not kill the process. `shiftPorts`' new distinct-port invariant covers only what the generated config names. | No action. |
| 8 | FYI | `apiGet()` in `frontend/src/lib/api.ts` has had no production caller since before this slice — verified against `main`. Pre-existing, and it is the source of finding 5's guard, so deleting it would lose the better implementation. | No action. |

**What I checked and found clean.** The route shape is right where it matters: `parseBody`
runs before anything touches Firestore, the uid is the one `withVerifiedUser` read off the
token with no path parameter to confuse it with, `email` is read from the Admin Auth record
on every write, and `readProfile` is the single projection both verbs answer through. The
`PUT` transaction branches on whether the stored document *parses* rather than on whether it
exists — the T4 amendment — and preserves a usable `createdAt` across the repair rewrite,
which is what makes D18's "a subsequent `PUT` repairs it" actually true. `snapshot.get()` on
a non-existent document is `undefined` in the Admin SDK, so the repair branch is safe on the
create path. The `'displayName' in body` test is present-versus-absent rather than
truthy-versus-falsy, so an ensure sending `{}` does not wipe a stored name. `firestore.rules`
is uniformly `if false` with every helper deleted, and every L3 case is an `assertFails` with
no `assertSucceeds` import left to make the file ambiguous. No secret, token or document
field reaches a log line. No `any`, no non-null assertion, no `as` outside the two
documented test bridges, and both handlers use `satisfies ProfileResponse`.

## Dead code (Step 9 — decided here, since there is no one to ask)

| Now unreachable | Decision |
|---|---|
| `useProfileStore().load()` — no in-app caller, by plan decision P1 | **Keep.** It is the only client of `GET /api/users/me`, which the PRD requires (AC-3, AC-4); deleting it would leave a shipped route with no caller at all, which is worse than a covered function with one. It carries L1 coverage and says at its definition why it has no caller. Revisit if Slice 3's `projects` store does not in fact copy it. |
| `apiGet()` in `lib/api.ts` | **Keep, out of scope.** Unused before this slice as well as after, so it is not this diff's debt, and finding 5 is the argument for merging it *into* the shared client rather than deleting it. |
| `USERS_COLLECTION`, `db`, `connectFirestoreEmulator`, `signedIn()`, `isOwner()`, `verified()`, both env vars | Already deleted by the slice, with tests asserting the absence. Nothing left behind. |

## Manual verification

- Re-ran `typecheck`, `lint`, the full frontend unit suite (282 passing) and
  `prettier --check` after every fix. Each fix was red first.
- Confirmed `git diff main...HEAD -- frontend/src/lib/hlApi.spec.ts` is empty — AC-23's
  assertion is the unchanged suite, and it is genuinely unchanged.
- Confirmed no import cycle from the new `auth.ts` → `profile.ts` / `hl.ts` edges: neither
  resource store imports the auth store, and the full suite plus `vue-tsc` agree.
- Bundle check and the ESLint rule's red state are on the build log's word (T12, T13), not
  re-verified here. The CI step runs them both on the PR.
- **Not run:** `test:rules`, `test:integration`, `test:e2e`. None of this review's fixes
  touch a function, a rule or a route; the e2e's account-card assertions exercise the loaded
  path, whose rendering is unchanged. The orchestrator re-runs all six.

## Deliberately deferred

- **Finding 5** — one response reader shared by `apiGet` and `request`. Slice 3 adds the
  third caller, which is the point at which the shape can be judged rather than guessed.
- **Finding 6** — a test that a route is mounted attested. Belongs to all three attested
  routes at once, not to this slice's two.
- A profile-settings surface (D8) and `DELETE /api/users/me` — out of scope by the PRD, and
  still out of scope.

## Verdict

**Approve.** The slice does what its PRD says, every acceptance criterion maps to a named
passing test, and it leaves the codebase with one data-access pattern instead of two — which
was the whole point. Finding 1 was a genuine cross-account data exposure and is fixed with a
regression test; findings 2–4 are fixed; 5–8 are recorded with the reasoning for leaving
them.

Run `/feature-ship 02b`.
