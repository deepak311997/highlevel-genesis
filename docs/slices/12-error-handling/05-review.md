# Slice 12 — Error handling & state hardening · Review

**Branch:** `slice/12-error-handling` · **Reviewed at:** `80245c4` (build tip) ·
**Reviewed:** 2026-08-18 · **Diff:** 55 files, +4498/−81 on arrival; 60 files,
+5110/−105 after the fixes below.

Read as another author's PR against `main`, in full, then six axes were run
concurrently — correctness, security, architecture, performance, readability, and
one auditing the PRD's acceptance criteria against the tests that claim them. Every
reported finding was reproduced against the actual code before it reached this file;
the ones that could not be are listed under *Claims that did not survive*.

## Suite

Counts for the five suites this slice does not touch are read from the
orchestrator's gate run on `80245c4` (`.autopilot/logs/12/gate-post-build.1.log`).
`typecheck`, `lint`, the frontend unit suite and `test:e2e` were re-run here after
the fixes, because the fixes are in `frontend/` and in the sign-in and generation
paths the walks exercise.

| Check | Result |
|---|---|
| `typecheck` (functions + frontend + root) | green, re-run after fixes |
| `lint` (functions + frontend, `--max-warnings 0`) | green, re-run after fixes |
| `test:unit` — functions | 46 files / 1136 tests, green (gate run; untouched) |
| `test:unit` — frontend | **73 files / 1061 tests, green** (was 1047; +14 from the fixes) |
| `test:unit` — scripts | 3 files / 21 tests, green (gate run; untouched) |
| `test:rules` | 1 file / 52 tests, green (gate run; untouched) |
| `test:integration` | 17 files / 378 tests, green (gate run; untouched) |
| `test:e2e` | **19 walks, green, re-run after fixes** (1.4 m) |

**D14 measured, not asserted.** `git diff main...HEAD --stat -- functions
firestore.rules tests/rules tests/integration` lists nothing. No collection, no
rules edit, and therefore correctly no L3 row.

## Findings

Ordered by leverage. "Fixed" means the fix is in this branch, test-first where the
change is behavioural.

| # | Severity | Finding | Action taken |
|---|---|---|---|
| F1 | **Critical** | **`?redirect=` accepted `/auth/action`, the one guard-exempt route.** `safeRedirect` was handed `router.getRoutes().map((r) => r.path)` — every route registered, not the ones a user can be *returned* to. `/auth/action` applies a Firebase action code straight off its query string, so `/signin?redirect=%2Fauth%2Faction%3Fmode%3DresetPassword%26oobCode%3D<attacker's own reset code>` handed a user who had **just typed their password** a "choose a new password" form bound to the attacker's account. A password typed twice in thirty seconds is the ordinary case, and `confirmPasswordReset` then sets the attacker's account to the victim's password. The `verifyEmail` variant is the quiet one: an attacker's address verified by the victim's click. **Pre-existing since Slice 1, not introduced here** — see *Scope calls*. | **Fixed** (`a84c17c`, `36d3054`). `destinationPaths` joins `resolveNavigation` in `router/guard.ts`, which already stated the policy in the other direction: only a `protected` route is worth returning to, the auth-flow pages and the gate are means. Both callers of `safeRedirect` filter through it. Keyed off `access`, not a hand-written list, so `/hl/callback` — `protected` on purpose since Slice 2 — keeps working without anyone remembering it. Reproduced first as a red test at the sign-in surface. |
| F2 | **Critical** | **The second dead session in a page session was swallowed, and a failed sign-out latched forever.** `apiClient`'s `signalled` latch cleared only on a call that *succeeded* — and a session that dies and stays dead cannot produce one. A user who signed in again into an account the server no longer accepts, or whose `signOut(auth)` storage write threw (private browsing, quota), sat on a workspace whose every panel read *"Sign in and try again."* with nothing to click. That is exactly the state AC-20 and this whole slice exist to get them out of, resurrected for every occurrence after the first. | **Fixed** (`f99c02b`, `285c10f`). `noteSessionAlive` → `rearmSessionExpiry`, with a second caller: the expiry itself, in a `finally`, so the latch clears whether the sign-out and navigation landed or threw. Red first, wired at the seam with the real hook — the invariant AC-15 and E6 are about is one *navigation*, which neither module can state alone. |
| F3 | **Critical** | **An abandoned generation was never cancelled — the model kept producing, and billing.** `streamGeneration` took `res.body.getReader()` and never released it. Breaking out of a `for await`, or throwing inside one, finalises the generator, and finalising a generator does not close a `fetch` body: the socket stays open, `generate`'s `res.on('close')` never fires, and the model runs to `max_tokens: 64000` for a reply nobody will read. `runGeneration` has a live path into it — a throw from its loop body (`openTab`, the `messages` spread, `applyGenerationFiles`) is swallowed by the `catch` below it, and its `finally` nulls the controller **without aborting it**. | **Fixed** (`46a4dc0`, `b59dc28`). The read loop is wrapped so `reader.cancel()` runs however the generator ends; `cancel()` rejects on a stream that already errored — the dropped-connection case — so that rejection is swallowed rather than replacing the mapped `ApiError` with the browser's own string. Two store tests had been pushing further frames into a stream the store had abandoned, which is the leak itself written down; the double now records the release and both tests assert it alongside the checks they already made. |
| F4 | Required | **Both new source scans contained fourteen tests that could not fail.** `no-pulse.spec.ts` and `toast-sites.spec.ts` claim, in their headers and again above the block, to be in `no-cdn.spec.ts`'s shape with *"the scanner tested before it is trusted"*. They asserted `source.includes(NEEDLE)` on fixtures built by interpolating `NEEDLE` — `String.prototype.includes` testing itself. Verified by mutation: replacing `offends` with `return false` left all eight `no-pulse` cases **green**, so AC-3's guarantee rested on nothing. `no-cdn.spec.ts` calls its real `hits()` and does not have this. Both tree walks also passed vacuously on an empty file list. | **Fixed** (`9767638`). Each file gains the named predicate the claim describes, routed through by both the self-tests and the tree walk, plus a case for the exemption half — the part that could silently widen to a whole directory. Both walks now assert they read something. The `return false` mutation now fails 4 of 9. |
| F5 | Required | **AC-7's "exactly one Toaster" could not see a second one.** `App.spec.ts` counts `Toaster`s in a tree whose routed views are `Blank` stubs, and `toast-sites.spec.ts`'s needle is the string `vue-sonner`, which a view importing `@/components/ui/sonner` does not contain — that import is explicitly listed as *innocent*. Between them, `<Toaster />` added to `DashboardView.vue` was invisible to both, and two regions render every toast twice. | **Fixed** (`9767638`). `toast-sites.spec.ts` gains a second needle for the region's own import specifier, allowlisted to `src/App.vue` alone. |
| F6 | Required | **A second expiry could start during the first one's `signOut` await.** `apiClient`'s latch is cleared by any call that succeeds, and a request the server had already committed can land inside `await deps.signOut()` — at which point `isSignedIn()` is still true and a second 401 starts a second `expire()`. That one re-reads `currentPath()`, by then already `/signin?redirect=…`, and points sign-in back at sign-in; the user reaches the dashboard afterwards, not their project. | **Fixed** (`285c10f`). `expire` grows its own re-entrancy guard, cleared in the same `finally` as the latch. |
| F7 | Required | **The connection sentence had five production authors.** `'Something went wrong. Check your connection and try again.'` was written out in `apiClient.ts`, `authApi.ts`, `generateApi.ts` ×2 and `SignInView.vue`; this slice added the fifth. A copy-edit was four edits and one surface left behind. Separately, `SESSION_EXPIRED_REASON` was exported to name the `?reason=` wire value and had **no caller** — `SignInView` retyped the literal, so producer and reader of that contract agreed by coincidence. | **Fixed** (`5d97d95`). `CONNECTION_MESSAGE` / `connectionError()` in `lib/api.ts` beside `ApiError`; the specs keep asserting the literal, which is the assertion rather than the duplication. `SignInView` now keys its notice map off the exported constant. |
| F8 | Required | **`noteApiError`'s doc justified a branch with an unreachable case.** It said a bare 401 is not a death *"`authHeaders` throws one when nobody was ever signed in"* — but `authHeaders` is awaited outside `request`'s `try` and its error never reaches `noteApiError`. The only example given for that half of the guard could not occur. | **Fixed** (`285c10f`). Restated as the case that does occur: a 401 with no envelope says only that something refused the call. |
| F9 | Required (small) | **`RestoreOutcome`'s `'blocked'` described one of its five return sites.** The doc says *"a button the sheet had already disabled"*; the other four are stale-generation bail-outs — the project or session went away under an in-flight restore, which is neither a disabled button nor something the sheet could have prevented. | **Fixed** (`42c38c5`). Renamed `'skipped'`, named for what the two silent cases share. The sheet's branches are unchanged. |
| F10 | Required (small) | **`failureFor` grew a two-level ternary**; and cross-slice `AC-`/`D-` references in the diff were unqualified in files where the collision is live — every other reference in `generateApi.ts` is Slice 5's and in `SnapshotSheet.vue` is Slice 11's, so a bare `AC-8` or `D3` read as theirs. The repo convention is to qualify (`workspace.ts`'s "(Slice 10, D12)"). | **Fixed** (`5d97d95`, `42c38c5`). Flattened into a `messageFor` helper, the shape `SignInView` already uses for the same job; references qualified. The `animate-pulse` scan also covers `.css` now — `@apply animate-pulse` is the same twentieth copy by another route. |
| F11 | Consider | **A second streaming client would silently be a hole in the sign-out hook.** `apiClient` exports `noteApiError` and `rearmSessionExpiry`, and `request` and `streamGeneration` each call them by hand, in the right order, on the right branches, with nothing requiring it. This is the failure mode `apiClient`'s own docstring says the module exists to prevent — and F2 was an instance of the protocol being spread rather than owned. Proposed: collapse both call sites into one exported `checkResponse(res)` and make the two halves module-private. | **Recorded, not taken.** There is exactly one such client and no second planned, and this is the last slice before deploy (R7): five behavioural changes have already landed in these two files this stage, and a structural refactor on top trades a real regression risk for a hypothetical one. Carried to Slice 13's README follow-ups. |
| F12 | Consider | **`vue-sonner` sits on the render-blocking critical path of every route, for one call site in the workspace.** Measured by building both branches against the same `node_modules`: entry JS 4.57 → 11.94 kB gz, entry CSS 7.89 → 10.55 kB gz — **+10.0 kB gzip on first paint** of `/signin`, `/signup`, `/forgot-password`, `/verify-email`, `/auth/action` and `/dashboard`, none of which can raise a toast. ~55 ms of added blocking transfer at 1.5 Mbps. | **Recorded, not taken.** The fix (`defineAsyncComponent` plus moving the stylesheet into `Sonner.vue`) races the chunk load against a toast fired *during* the navigation that caused it — which is the common case here and is exactly R1's invisible-toast failure, the one the tests cannot catch. Not a trade to make on the last slice before deploy. Carried to Slice 13. |
| F13 | Consider | **`ConnectionPanel.vue` is now the largest SFC in the app** (259 lines, ahead of `AuthActionView.vue` at 221). Seven of its nine script members and ~95 template lines belong to the Data access probe alone, which shares nothing with the panel but the `hl` store. Proposed: extract `DataAccessSection.vue`, no props, reading the store itself; the panel drops to ~150 lines and the testids are unchanged, so this slice's +104 spec lines port as-is. | **Recorded, not taken.** D12 asked for three lines and got three lines; the size is incidental to this slice rather than caused by it, and D13 is explicit that a structural refactor beside a uniformity diff makes one diff out of two changes. Carried to Slice 13. |
| F14 | Consider | **Four copies of the recursive `sourceFiles` walker** across `no-cdn`, `no-firestore`, `no-pulse` and `toast-sites` specs; this slice added the third and fourth. Proposed: `lib/testing/sourceScan.ts` exporting `sourceFiles(root, skip)` and `shortPath`, with the skip predicate as the parameter — it is the one thing that genuinely varies. The helper names no needle, so it stays invisible to all four scans. | **Recorded, not taken.** It would touch two files outside this slice, and the two new scans were just rewritten; two structural passes over the same files in one stage is how a mistake gets in. Carried to Slice 13. |
| F15 | Consider | **`withDetail` is a pure string formatter living in a Pinia store.** It takes two strings, returns a string, touches no state, and exists in `stores/hl.ts` only because that is where `failureFor` is — while `lib/api.ts`, which owns `ApiError.message` and `.detail`, now has to point *up* into the store to explain where its own field's reader is. Proposed: move it to `lib/api.ts` as `withDetail(err: ApiError)`, which also removes the argument-order hazard. | **Recorded, not taken.** Same reason as F14 — `lib/api.ts` was already edited twice this stage. Carried to Slice 13. |
| F16 | Consider | **A restore that fails after the sheet closes leaves a stale banner for the next visit.** `onOpenChange` clears `restoreError` on the close edge only: confirm a restore, press Escape immediately, let the request fail, reopen — `snapshot-restore-error` renders a failure for an attempt the user walked away from, over a freshly loaded list. Clearing on the open edge too would close it. | **Recorded, not taken.** Pre-existing from Slice 11 and not in this slice's AC set; the window is a few hundred milliseconds wide and the consequence is a stale banner, not lost work. Carried to Slice 13. |
| F17 | Consider | **The expiry return path copies the whole `fullPath`.** On `/auth/action?mode=verifyEmail&oobCode=…` the user *is* signed in, so a 401 writes a Firebase action code into the sign-in page's URL and browser history. F1's fix means it is refused on the way back and never reaches `sessionStorage`, so the residual is a single-use, short-lived code appearing in history. | **Recorded, not taken.** Narrowing to `route.path` plus a vetted query subset would drop the workspace query `sessionExpiry.spec.ts` pins (`/projects/abc?tab=files`). Carried to Slice 13. |
| F18 | Nit | `signalled` names no subject, where neighbouring state does (`filesLoaded`, `restoringId`, `generating`); `stubs(false)` in `sessionExpiry.spec.ts` reads opaquely at the call site. | Left. Its partner was renamed as part of F2, which was the half that was actually saying something untrue. |
| F19 | FYI | `/hl/callback?code=` carries an **error** code, not an OAuth authorization code — the exchange is server-side. Checked because it looked like the higher-value target for F17 and it is not one. | No action. |
| F20 | FYI | `npm --prefix frontend audit --omit=dev` → **0 vulnerabilities**. `vue-sonner@2.0.9` is the only lockfile addition, MIT, **zero transitive dependencies**, and `deps.spec.ts` pins the inventory. `vue-sonner/style.css` resolves through the package's `exports` map. | No action. |

## Claims that did not survive

Reported by an axis, checked against the code, and dropped:

- **A guard/navigation race in `expire()`.** Nothing in the app watches `isSignedIn`
  to navigate — `router/guard.ts` is a `beforeEach` and runs only on an actual
  navigation. `signOut(auth)` notifies `onAuthStateChanged` synchronously, so by the
  time `replace()` runs the store already reads signed-out and
  `resolveNavigation('auth-flow', …)` correctly returns `null`. The source comment
  describing "the route guard fires its own navigation off that" was wrong about a
  navigation that does not exist; reading the path first is still right, and the
  comment was corrected rather than the code.
- **`safeRedirect`'s rewrite as an open redirect.** ~35 payloads were run against the
  real route table and every accepted value resolved same-origin. `//evil.com`,
  `/\evil.com`, `/%5cevil.com`, `/%2f%2fevil.com`, `/@evil.com`, `/%09//evil.com`,
  `/%0d%0a…` are all refused; the catch-all is correctly skipped by `/[(*?+]/`;
  `:param` compiles to `[^/]+`, one segment. The reachable problem was *which list*
  it was handed (F1), not how it matches.
- **`restoreSnapshot` returning `'failed'` after a partial commit.** It cannot:
  `loadSnapshots` and `applyRestoredFiles` swallow their own errors into store
  fields, so the only throw inside the `try` is `postRestore`, before any state is
  written.
- **`ApiError.detail` leaking a credential.** `detailFrom` reads only `message` /
  `error_description` / `error`, requires a string, truncates to 200 chars, and is
  reached from one call site — the proxied data call. The OAuth token path uses
  `mapTokenError`, which never passes a detail. All three render sinks are mustache
  interpolation; `v-html` appears nowhere in `src`.
- **The `Skeleton` swap shifting a layout (R2).** Every one of the nineteen sites kept
  its exact sizing utilities and its original radius. `cn` is `twMerge(clsx(…))`, so a
  caller's `rounded` and the base `rounded-md` land in the same tailwind-merge group
  and the caller wins — `Skeleton.spec.ts` asserts `rounded-md` is *absent* after the
  override. Monaco's height chain is untouched: `CodeEditor` is still three
  fixed-height children inside the same `absolute inset-0` wrapper.
- **Latch leakage between tests (R4).** Vitest gives each spec file a fresh module
  registry; `apiClient.spec.ts` resets in both `beforeEach` and `afterEach`, and
  `generateApi.spec.ts` in `afterEach`.
- **`matcherFor` compiling a `RegExp` per route per call as a cost.** Ten routes, two
  call sites, once per sign-in: 10–20 µs. The scan specs' filesystem walks are ~7 ms
  over 198 files. `cn()` across the Skeleton sites is 0.12 µs on a tailwind-merge
  cache hit, and every call site passes a literal, so every key is a permanent hit.

## AC coverage

Every AC was checked by opening the test body, not by reading the matrix. `AC-1` was
spot-checked across 14 of the 61 testids in the PRD's audit table; all 61 are
asserted somewhere, and all 14 read are real assertions rather than comments.

| AC | Test | Verified |
|---|---|---|
| AC-1 | 61 audit testids across the component specs | yes |
| AC-2 | 11 assertions across the 10 swapped components + `Skeleton.spec.ts:18` | yes — each pins the old testid *and* counts `[data-slot="skeleton"]` inside it |
| AC-3 | `lib/no-pulse.spec.ts` | yes, **after F4** — was weak (vacuous) |
| AC-4 | `SnapshotSheet.spec.ts:405` | yes — `toast.success` with the version, and the sheet stays open |
| AC-5 | `SnapshotSheet.spec.ts:427`, `stores/workspace.spec.ts:3517` | partial — see below |
| AC-6 | `lib/toast-sites.spec.ts`, `SnapshotSheet.spec.ts:469`, `FileEditor.spec.ts:319` | yes — the scan is mutation-resistant (`toEqual(ALLOWED)` against a non-empty list) |
| AC-7 | `App.spec.ts:120` + the region scan | yes, **after F5** — was escapable |
| AC-8 | `generateApi.spec.ts:486/509`, `workspace.spec.ts:3574`, `ChatPanel.spec.ts:440` | yes at L1 and in the store, which drives a real `ReadableStream` through the real `sse.ts`. The L2 case is a lock, not evidence — it sets `generateError` to the app copy and then asserts the browser's string is absent, which no implementation change could break. The build log is honest about this. |
| AC-9 | `workspace.spec.ts:3574` | yes — the prompt survives and `retryGeneration()` issues a second `POST /generate` |
| AC-10 | `apiClient.spec.ts:148`, `sessionExpiry.spec.ts:50/64` | yes — the exact URL literal, and the path-before-sign-out ordering via an order array |
| AC-11 | `SignInView.spec.ts:144/154/160` | yes, with both negatives (absent, and `reason=banana`) |
| AC-12 | `SignInView.spec.ts:170`, `redirect.spec.ts:69` | yes — the view test runs the **real** `safeRedirect` with a parameterised route in `getRoutes` |
| AC-13 | `apiClient.spec.ts:160`, `generateApi.spec.ts:344` | partial — see below |
| AC-14 | `apiClient.spec.ts:180` | yes |
| AC-15 | `apiClient.spec.ts:193`, and now the seam test added for F2 | yes — the concurrency is real (three fetches in flight before any `await`), and the *navigation* half is now asserted too, which it was not |
| AC-16 | `generateApi.spec.ts:331/363` | yes, and stronger than it looks: `vi.importActual` means the stream shares the real module latch with `request` |
| AC-17 | `stores/hl.spec.ts:228/238/343`, `ConnectionPanel.spec.ts:390` | yes — the three no-detail cases each assert `not.toContain('(')`, which is E10/E11 exactly |
| AC-18 | `ConnectionPanel.spec.ts:409/428` | yes — the `it.each` over all four probe states pins the region as *unconditional*, which was the actual bug |
| AC-19 | `ConnectionPanel.spec.ts:450` | yes — three labels across four states, and `disabled` asserted positively for the enabled ones |
| AC-20 | `tests/e2e/errors.spec.ts:55` | yes — real sign-up, real verification, real project, the workspace path read *off the browser* so a parameterised route is genuinely exercised. Only `page.route` is faked, which is R6's documented limit. |

**Two ACs outrun what their tests can prove, and neither is a code defect:**

- **AC-5's "no new version is created"** is not asserted anywhere. The store test
  checks `filesRevision` does not move, but the `changed: false` it branches on is the
  test's own canned response — the claim is about the stub. Under D14 (no server
  tests this slice) there could be no test for it. The AC should have been worded to
  the client half. **Recorded, not backfilled**, since backfilling it means opening
  `functions/`, which D14 forbids and the definition of done measures.
- **AC-13's "the caller's own error surface shows the server's message"** is proven
  only as `ApiError.message` propagating out of `request`. No component test renders
  an `app_check_failed` failure, so E4's user-visible half is untested. The rendering
  itself is the generic path every panel already uses. Carried to Slice 13.

One matrix inaccuracy: AC-6's row names the `ChatPanel` spec, which has no toast
double and no "toasts nothing" case. Harmless — the scan subsumes it — but the row
is untrue as written.

## Scope calls

- **F1 is pre-existing, and was fixed anyway.** It dates from Slice 1's
  `safeRedirect`, not from this branch. Three things decided it: `?redirect=` is
  *this slice's own mechanism* (D7, AC-12) and `redirect.ts` was already open; the
  fix contradicts no recorded decision but rather implements one `guard.ts` had
  already written down; and the impact class — a signed-in user handed an attacker's
  password-reset form — is not something to carry into a deploy because a slice
  boundary says so. This is a different case from the PRD's refusal of
  `form-action 'none'`, which *would* have overridden a recorded decision (Slice 10,
  D10).
- **`redirect.ts` was undeclared scope in the PRD.** D7 says the mechanism "is
  already built … so this is a hook and a notice, not a new flow", and neither the
  In-scope list nor the test matrix has a `redirect.ts` row — but AC-12 and AC-20
  cannot pass without it, because `router.getRoutes()` reports `/projects/:projectId`
  and never `/projects/abc`, so the old membership test returned every deep-linked
  user to the dashboard. The build recorded it as T5. **Read D7 as amended**: the
  slice discovered a defect in the mechanism it depended on and fixed it, twice —
  once for what `safeRedirect` matches (T5) and once for what it is handed (F1).
- **The PRD writes the workspace route as `/workspace/:id`** (AC-10, AC-12, AC-20).
  The route is `/projects/:projectId`. The tests and the walk use the real one; the
  PRD's prose is the thing that is wrong.
- **Nothing in the diff is unasked-for beyond the above.** The `functions/` half is
  untouched and measured; the fifteen deferrals the PRD re-homed stayed re-homed.

## Dead code

Step 9's question, decided here rather than asked:

- **`noteSessionAlive`** — became the wrong name for what it does once the expiry
  also had to call it. **Renamed**, not deleted: the behaviour has two callers now.
- **`SESSION_EXPIRED_REASON`** — was exported with zero references anywhere,
  including its own spec. **Kept and wired** rather than deleted: it is the name of a
  query-string contract whose only reader was retyping the literal, so the export was
  right and the caller was missing.
- **`expiredSignInPath`, `withDetail`, `REDIRECT_STORAGE_KEY`, `RestoreOutcome`** —
  exported but referenced only by their specs (or, for `RestoreOutcome`, only within
  its own module, with `SnapshotSheet.vue` comparing bare literals). **All kept.**
  Each is the unit a named AC tests directly, or the return type of a public store
  method; unexporting them would push the assertion through a wrapper and prove less.
- **Confirmed still live, not orphaned by the refactor:** `storeRedirect`
  (`SignInView`, `guard.ts`), `consumeRedirect` (`VerifyEmailView`),
  `DEFAULT_REDIRECT` (three callers).

Nothing was deleted.

## Manual verification

- Full `test:e2e` re-run on the fixed branch: **19/19 green**, including
  `errors.spec.ts`'s session-expiry walk, `workspace.spec.ts`'s `__fail_midstream`
  walk and Slice 7's editor-height walk (R2's backstop). This is also what confirms
  no import cycle was introduced by `SignInView`/`VerifyEmailView` reaching into
  `router/guard` — the views are only ever loaded lazily by the router.
- F4 verified by mutation, both ways: `offends` → `return false` was green before the
  fix (8/8) and fails 4 of 9 after it.
- F1 reproduced as a red test at the sign-in surface before the fix, and
  `destinationPaths` red in `guard.spec.ts` before the implementation existed.
- F2 and F3 each red at the seam before their fix, green after.
- The three demo breaks are the build's to have walked by hand; the two the suite
  covers end to end (the interrupted reply, the expired session) were re-run here.
  **The toast has still not been seen by a human eye** — R1 says a missed stylesheet
  import ships an invisible toast that every test passes, and the import is present
  and resolves, but that is a static check, not the pixels. Flagged for the ship
  stage's demo evidence.

## Deliberately deferred

To Slice 13's README follow-ups: F11 (the two-call protocol in `apiClient`), F12
(`vue-sonner` on the critical path, with its measured +10 kB gz), F13
(`DataAccessSection` extraction), F14 (the fourfold `sourceFiles` walker), F15
(`withDetail`'s home), F16 (the stale restore banner), F17 (`fullPath` in the return
path), AC-13's L2 half. Plus everything the PRD's own out-of-scope table already
re-homed, which this review did not disturb.

## Verdict

**Approve.** Three findings would have shipped and cost real money or real
credentials while the whole suite stayed green — a redirect target that hands a
freshly-authenticated user someone else's password-reset form, a sign-out latch that
strands the second dead session, and a generation nobody cancels. All three are
fixed, test-first, with the failing test preceding each change. The remainder are
structural improvements that belong beside other structural work, not beside a
uniformity pass on the last slice before deploy.

Next: `/feature-ship 12`.
