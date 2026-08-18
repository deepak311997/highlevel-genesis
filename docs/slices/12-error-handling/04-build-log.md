# Slice 12 — Error handling & state hardening · Build log

**Branch:** `slice/12-error-handling` · **Plan:** `03-plan.md` (approved) · **PRD:** `02-prd.md`
· **Base:** `main` at `94bcc1f` · **Started:** 2026-08-18

## Baseline before any change

| Gate | Result |
|---|---|
| `npm run typecheck` | green |
| `npm run lint` | green (0 warnings) |
| `npm run test:unit` | green — 68 frontend files / 962 cases, plus 3 script files / 21 cases |
| `npm run test:rules` | green — 1 file / 52 cases |
| `npm run test:integration` | green (run concurrently with T1; see T-log) |

No pre-existing failure. Nothing was fixed silently.

## The audit, carried from the PRD (definition-of-done line)

**Every screen on `main` at `94bcc1f` already renders loading, empty and error.** Each cell
names the `data-testid` that proves it. "—" means the surface has no such state by
construction (a form has nothing to be empty of).

| Screen / panel | Loading | Empty | Error | Retry |
|---|---|---|---|---|
| `SignInView` | button label | — | `signin-error` | resubmit |
| `SignUpView` | button label | — | `signup-error`, `signup-email-error`, `signup-password-error` | resubmit |
| `ForgotPasswordView` | button label | — | `forgot-error`, `forgot-email-error` | resubmit |
| `VerifyEmailView` | button label | — | `verify-error` | resend |
| `AuthActionView` | state machine | — | `action-password-error` + failed state | resubmit |
| `HlCallbackView` | `hl-callback-status` | — | status copy per error code | back to dashboard |
| `AccountCard` | `account-loading` | `account-empty` | `account-error` | `account-retry` |
| `ConnectionPanel` | `connection-loading` | `connection-empty` | `connection-error`, `connection-callback-error`, `connection-needs-reconnect` | `connection-retry` |
| `ConnectionPanel` › Data access | `data-access-loading` | — | `data-access-error` | `data-access-check`, `data-access-reconnect` |
| `ProjectsCard` | `projects-loading` | `projects-empty` | `projects-error` | `projects-retry` |
| `ProjectFormDialog` | button label | — | `project-form-error` | resubmit |
| `ProjectDeleteDialog` | button label | — | `project-delete-error` | resubmit |
| `WorkspaceView` | `workspace-loading` | `workspace-missing` | `workspace-error` | `workspace-retry` |
| `ChatPanel` | `chat-loading` | `chat-empty` | `chat-error`, `generate-error`, `generate-file-error` | `chat-retry`, `generate-retry` |
| `MessageComposer` | button label | — | `composer-error` | resend |
| `FileTree` | `file-tree-loading` | `file-tree-empty` | `file-tree-error` | `file-tree-retry` |
| `FileEditor` / `CodeEditor` | `file-editor-loading`, `code-editor-loading` | `file-editor-empty` | `file-editor-read-error`, `file-editor-error` | `file-editor-retry`, resave |
| `PreviewPanel` | `preview-loading` | `preview-empty` | `preview-error`, `preview-failure`, `preview-runtime-error` | `preview-retry`, `preview-reconnect` |
| `SnapshotSheet` | `snapshot-loading` | `snapshot-empty` | `snapshot-error`, `snapshot-restore-error` | `snapshot-retry` |

**The measurement behind AC-1 (plan C4).** Of the 61 testids above, 60 were already asserted
in their component's spec at `94bcc1f`. The script that measured it, reproduced so the claim
stays checkable:

```sh
# from frontend/, for each testid in the table:
grep -rn "<the testid>" src --include='*.spec.ts' | head -1
```

The single exception was `preview-reconnect`, which *was* asserted — as a `RouterLinkStub`
with `to === '/dashboard'` and the text `Reconnect HighLevel` (`PreviewPanel.spec.ts:411–414`)
— but never by its testid, so the table was not checkable against it. T19 closes that.

## Lane analysis

The plan pins the lanes (§ Lanes) and the build follows them exactly:

- **Barrier L-SKELETON (T1 → T2 ∥ T3 → T4)** runs first and alone, because it opens
  `ConnectionPanel.vue` (also L-HL), `SnapshotSheet.vue` (also L-TOAST) and `ChatPanel.spec.ts`
  (also L-STREAM). T2 and T3 are disjoint inside it and run concurrently.
- Then **L-SESSION** (T5→T6→T7→T8→T9→T10, T20 last), **L-HL** (T12→T13), **L-TOAST**
  (T14→T15; T16; T17→T18) and **L-AC1** (T19) run fully in parallel — they share no file.
- **T11 is the one join** (`generateApi.*` from L-SESSION, `stores/workspace.spec.ts` from
  L-TOAST, `ChatPanel.spec.ts` from the barrier) and is kept by the lead, run last.

## Tasks

### T1 — Vendor `Skeleton` (AC-2)

- **Red:** `frontend/src/components/ui/skeleton/Skeleton.spec.ts` — three cases: the
  `data-slot="skeleton"` attribute plus the three base classes; a caller's `rounded` winning
  the tailwind-merge conflict against `rounded-md` (the five sites that use `rounded` keep
  their shape — R2); and the sizing utilities the call sites carry surviving. Failed to
  resolve `./index`, which is the expected red.
- **Green:** `Skeleton.vue` + `index.ts` exactly as the plan pins them. Base is `bg-secondary`,
  **not** upstream's `bg-accent` — `style.css` reserves the ember accent for the live element,
  and the plan records this departure. `npx shadcn-vue@latest add skeleton` was deliberately
  not run.
- **Deviation:** none.

### T2 — Skeleton: the dashboard three (AC-2) · lane L-SKELETON, run concurrently with T3

- **Red:** four tests, one per loading surface, each asserting the existing loading testid
  still resolves **and** the count of `[data-slot="skeleton"]` inside it.
  - `AccountCard.spec.ts` — `renders Skeleton placeholders while loading` (`account-loading`, 2)
  - `ConnectionPanel.spec.ts` — `renders Skeleton placeholders while loading` (`connection-loading`, 2)
  - `ConnectionPanel.spec.ts` — `renders Skeleton placeholders while the probe runs`
    (`data-access-loading`, 3)
  - `ProjectsCard.spec.ts` — `renders Skeleton placeholders while loading` (`projects-loading`, 2)

  All four failed on the count (`expected [] to have a length of 2 but got +0`), not on an
  import — the right red.
- **Green:** seven `<div class="… animate-pulse rounded bg-secondary" />` became
  `<Skeleton class="… rounded" />`, keeping `rounded` rather than the base `rounded-md` so
  tailwind-merge preserves each shape (R2), and keeping `v-for="n in 3"` / `:key="n"` on the
  probe's placeholder.
- **Deviation:** the second ConnectionPanel test is named `renders Skeleton placeholders while
  the probe runs` rather than repeating the plan's literal name. Two identically-named tests in
  one file makes a failure report ambiguous about which state broke, and it sits in a different
  `describe` block (`ConnectionPanel — data access`). Behaviour asserted is exactly as planned.

### T3 — Skeleton: the workspace seven (AC-2) · lane L-SKELETON, run concurrently with T2

- **Red:** seven tests named `renders Skeleton placeholders while loading`, in T2's shape.
  `WorkspaceView` (`workspace-loading`, 1), `ChatPanel` (`chat-loading`, 2), `FileTree`
  (`file-tree-loading`, 2), `FileEditor` (`file-editor-loading`, 1), `CodeEditor`
  (`code-editor-loading`, 3), `PreviewPanel` (`preview-loading`, 1), `SnapshotSheet`
  (`snapshot-loading`, 2 — through the file's document-scoped `must()` helper, since the sheet
  portals). 7 failed / 124 passed, every failure on the count, none on an import.
- **Green:** twelve placeholders replaced, each `Skeleton` carrying verbatim the `h-*`/`w-*` it
  replaced. No wrapper restructured — the `absolute inset-0` covers in `CodeEditor.vue` and
  `FileEditor.vue` are untouched, so Monaco's height chain is unchanged (R2).
- **Deviations, both recorded rather than silent:**
  - `FileTree.spec.ts`'s existing skeleton test was extended **and renamed** to the plan's name,
    keeping its `file-row` assertion, rather than leaving two near-identical names.
  - `CodeEditor.spec.ts`'s existing `renders the skeleton until the editor mounts` was **kept
    intact** and the count case added beside it. That test asserts a two-phase mount timing
    sequence which a count assertion would muddy; the plan's "extend rather than add a second"
    was aimed at avoiding a duplicate skeleton-*presence* test, and no test was weakened.

### T4 — `animate-pulse` lives in one place (AC-3) · closes the barrier

- **Red:** `frontend/src/lib/no-pulse.spec.ts`, in `no-cdn.spec.ts`'s exact shape — needle by
  concatenation (`'animate-' + 'pulse'`), `SELF = 'no-pulse.spec.ts'`, a `FORMS`/`INNOCENT` pair
  (4 + 3 cases) proving the scanner before it is trusted, offenders reported **by path**, and
  `components/ui/skeleton/` the only allowed directory. Written before being run, so its red
  state is the offender list.
- **The red state, and the plan amendment it forced.** The scan named three files:
  `AccountCard.spec.ts`, `ConnectionPanel.spec.ts`, `ProjectsCard.spec.ts`. The plan's T4 note
  says *"no spec mentions the string today (checked)"* — true at `94bcc1f`, and made false by
  **T2 itself**, whose new spec comments read ``hand-rolled `animate-pulse` div``. T3 hit the
  same thing and had already reworded its own.

  Two ways out, and the choice matters: exempt `*.spec.ts` from the scan, or reword the prose.
  **Rewording is the fix taken.** A spec is source, and a hand-rolled placeholder inside a test
  fixture is precisely the thing this scan has to catch — exempting the specs would carve a hole
  in the scan to accommodate a comment, which is weakening the test to get it green. The three
  comments now read "hand-rolled pulsing div", matching T3's wording.
- **Green:** 8/8 in the scan. Full frontend suite **70 files / 983 tests**, typecheck and lint
  clean (zero warnings).
- **Barrier closed.** L-SESSION, L-HL, L-TOAST and L-AC1 may now run concurrently.

## Post-barrier fan-out

Lanes dispatched concurrently, exactly as the plan's § Lanes pins them, with two
build-stage coordination changes recorded below under *Deviations from the plan's lane split*.

### T19 — the audit table's one unchecked row (AC-1) · lane L-AC1

- **Red/Green:** one assertion added to the existing `offers Reconnect HighLevel for %s` case in
  `PreviewPanel.spec.ts`: `expect(link.attributes('data-testid')).toBe('preview-reconnect')`.
  `RouterLinkStub` does forward non-prop attributes, so the plan's fallback form
  (`wrapper.find('[data-testid=…]')`) was not needed — and the form used is the better claim,
  because it pins the testid to the *same* element already proved to carry `to === '/dashboard'`
  and the text `Reconnect HighLevel`, rather than asserting the testid exists somewhere.
- No change to `PreviewPanel.vue` was needed; the testid renders at line 138 as the plan says.
  22 tests in that file green. **AC-1 now holds for all 61 audit rows.**

### T14 — vendor `sonner` (AC-7, dependency) · kept by the lead

Kept out of the lane split deliberately: it is the only task that runs `npm install`, and
mutating `node_modules` underneath four lanes running Vitest is a race with nothing to gain.

- **Red:** `deps.spec.ts` gained `'vue-sonner'` to `EXPECTED` — failed on the whole-set
  assertion (`expected [ …(14) ] to deeply equal [ …(15) ]`), which is what makes "one new
  dependency" a claim with a test behind it. `Sonner.spec.ts` failed to resolve `./index`.
- **Green:** `npm install vue-sonner` (^2.0.9). `Sonner.vue` written by hand rather than taken
  from `npx shadcn-vue@latest add sonner`: upstream themes off `@vueuse/core`'s `useColorMode`,
  and this project already owns `useDarkClass()`, which *observes* the `dark` class that
  `useTheme` and the pre-paint script in `index.html` both write. A second derivation of the
  theme is what `useDarkClass`'s own doc comment exists to prevent.
- `style.css` gained `@import 'vue-sonner/style.css';` after the two `@fontsource` imports and
  after `@import 'tailwindcss'`, which stays first. **R1 stands: no automated test can see this
  import.** Without it the Toaster mounts, all four tests still pass, and nothing is visible.
  The manual walk in the definition of done is the only proof, and it is listed there for
  exactly this reason.
- 4 tests green; `eslint src/components/ui/sonner --max-warnings 0` clean.

### T15 — exactly one `Toaster` (AC-7) · lane L-TOAST-APP

- **Red:** `App.spec.ts` — `mounts exactly one Toaster`, looping over both layouts through the
  file's existing `mountAt(path)` helper. `expected [] to have a length of 1 but got +0`, with
  the other four tests still passing in the same run — the right red.
- **Green:** `<Toaster />` as the last child of the root `div`, a sibling **after** `</main>`.
  Outside `<main>` it is untouched by the `contained`/`full` class binding, and outside
  `RouterView` it does not unmount on navigation — so a toast fired during a route change
  survives instead of dying mid-fade.
- The plan's jsdom stub fallback was **not** needed; the real `vue-sonner` `Toaster` mounts
  cleanly, so the assertion counts the real component.
- **Deviation:** none.

### T12 — `detail` gets a reader (AC-17, L1) · lane L-HL

- **Red:** in `hl.spec.ts` — `withDetail` directly (`composes the message and upstream's own
  words`, plus an `it.each` over *no detail* / *an empty detail* / *a detail that only repeats
  the message*, each also asserting `not.toContain('(')` so a stray separator fails), and
  through the store (`carries upstream's own words about the request into the row`).
  5 failures: 4 × `withDetail is not a function`, and
  `expected 'Could not read contacts.' to be 'Could not read contacts. (Invalid JWT)'` —
  proof `failureFor` was dropping `detail` on the floor.
- **Green:** `withDetail` exported with the pinned signature; `failureFor`'s `error` becomes the
  pinned three-branch ternary. `reconnect`/`status` untouched. The pre-existing
  `keeps the other two counts when one surface fails` still asserts the bare message for a
  detail-less `ApiError` and still passes — the regression proof for E10.
- **Refactor:** `lib/api.ts`'s doc comment, which said *"`detail` has no reader yet"* and named
  this slice as the decision point, now names `withDetail` as the reader and keeps the note that
  the preview's frame-side wire shape is unchanged. **Comment only; no code changed in that file.**
- **Deviation:** none.

### T13 — the Data access section, perceivable (AC-17 L2, AC-18, AC-19) · lane L-HL

- **Red:** `renders the composed failure in the row`; `titles the section with a heading`
  (`expected undefined to be defined` — it was a styled `<p>`); `announces its results
  politely — %s` over **all four** probe states (`expected false to be true` on all four — the
  region did not exist at all, idle included); `labels the check button off the probe state — %s`
  over four states plus `disabled`.
- **An honest note, worth recording rather than glossing.** `renders the composed failure in the
  row` **passed on the red run**. `describe()` already returns `probe.error` verbatim, so at L2
  this is a characterisation test pinning AC-17 at the render layer; the behaviour change for
  AC-17 lives entirely in T12, which was genuinely red. The test is kept as a lock rather than
  contrived into failing. Likewise only the `loading` case of the label matrix was red — the old
  `hl.probeResult === null` ternary produces the right words for idle/ready/error and lies
  precisely mid-probe, which is the bug; the three green cases are the regression lock.
- **Green:** the title becomes an `h4`; the loading block, the `<dl>` and the `data-access-error`
  alert are wrapped in an **unconditional** `<div data-testid="data-access-results"
  aria-live="polite">` — no `v-if`, so it is mounted and observable before any counts land; and
  `const CHECK_LABELS: Record<ProbeState, string>` with `computed(() => CHECK_LABELS[hl.probe])`
  replaces the ternary. A `Record` rather than an if-chain so a fifth probe state is a compile
  error here rather than a blank button. Every existing testid keeps its element; the check and
  reconnect buttons stay **outside** the live region, being controls rather than results.
- **Deviations, both cosmetic:** `it.each` for the two state matrices rather than eight
  hand-written tests (same coverage, the state is in the test name); and the disabled assertion
  is written so the non-loading states positively assert *enabled* rather than only checking
  loading.

### T5–T10 — session expiry, end to end · lane L-SESSION

**T5 — `safeRedirect` accepts a parameterised route (plan C2; prerequisite for AC-12, AC-20).**
Red: 2 failed / 24 passed, `expected '/dashboard' to be '/projects/abc123'` — `includes` can
never match a pattern. The catch-all and extra-segment cases passed vacuously in the red state,
which is what makes them guards against the fix *over*-reaching rather than duplicates.
Green: private `matcherFor(pattern)` returning `null` for `/[(*?+]/` (in this router, exactly the
catch-all — it matches everything, so honouring it makes the allowlist a no-op), otherwise
`:param` → `[^/]+` per segment, the rest escaped, anchored both ends; `some()` replaces
`includes`. All fourteen hostile-payload cases unchanged and passing. **C2 is confirmed exactly
as the plan states it: this was a real bug on `main` that no test caught.**

**T6 — the sign-out hook in `apiClient` (AC-10, AC-13, AC-14, AC-15).** Red:
`registerSessionExpiredHook is not a function` took all 20 tests in the file down, because the
reset lives in the shared `beforeEach`/`afterEach` — the right red for a missing export.
Green: the three exported functions exactly as pinned; `request` does `errorForResponse` →
`noteApiError` → `throw`, and `noteSessionAlive()` before parsing on success. Tests:
`invokes the session hook for a 401 unauthenticated, and still throws`, `leaves app_check_failed
alone`, `leaves a 403 email_unverified alone`, `fires once for three concurrent 401s`,
`fires again after a call that succeeded`, `does nothing when no hook is registered`,
`ignores a 401 with no code`.

**T7 — what the hook does (AC-10).** Red: `Failed to resolve import "./sessionExpiry"`.
Green: as pinned, `SIGN_IN_PATH` imported from `@/router/guard` rather than restated; the hook is
synchronous and does `void expire(deps)`, with the async body private so `no-floating-promises`
has something to point at. `reads the path before signing out` proves the order with an `order`
array — the guard's own navigation would otherwise have moved the path first.

**T8 — `main.ts` (AC-10 wiring). No test, deliberately** — four statements of assembly with no
exports and no branches; a unit test would assert that the file calls the functions the file
calls. T20's L5 walk is the level at which "they are actually connected" is a claim at all.

**T9 — the sign-in notice (AC-11, AC-12).** Red: 1 failed / 15 passed,
`Cannot call text on an empty DOMWrapper`. AC-12's case was **already green because T5 had
landed first**, which is exactly the ordering the plan prescribes. Green: a module-level one-entry
`NOTICES` map, a `notice` computed, and a default-variant `<Alert data-testid="signin-notice">`
(→ `role="status"`, what a notice wants) as the first child of `CardContent`.

**T10 — the SSE path is not a hole in the hook (AC-16).** Red: 2 failed / 28 passed,
`expected "vi.fn()" to be called 1 times, but got 0 times`. Green: the three lines from `request`,
plus `noteSessionAlive()` once the response is ok. **The `reader.read()` loop is untouched**, left
for T11.

**Deviations, all additive and all recorded:**
1. `generateApi.spec.ts`'s `apiClient` mock had to change shape. It was
   `vi.mock('@/lib/apiClient', () => ({ authHeaders }))`, which would leave
   `registerSessionExpiredHook` and `noteApiError` `undefined` in the module under test. It now
   spreads `await vi.importActual(...)`, with `@/lib/firebase` and `@/lib/appCheck` stubbed so the
   real import cannot reach the Firebase SDK. **Stronger than the hand-rolled mock**: the test
   exercises the real latch, and so proves the stream shares module state with `request`.
2. Three extra tests beyond the plan's named ones: `encodes a path carrying a query of its own`
   and `returns nothing, so no caller has a promise to drop` (T7), and `re-arms the hook once a
   stream has opened` (T10) — without which `noteSessionAlive()` in `streamGeneration` would be an
   untested line.
3. `SignInView.spec.ts`'s shared `vue-router` mock gained `{ path: '/projects/:projectId' }` in
   `getRoutes`, unavoidable for AC-12. `/nowhere` still falls back, so the existing
   `ignores a %s redirect target` cases are untouched and green.

### T16 — the store reports what a restore did (AC-5, L1) · lane L-TOAST-RESTORE

- **Red:** 4 failed / 138 passed, each `expected undefined to be 'restored' | 'unchanged' |
  'blocked' | 'failed'` — the function resolved with nothing at all. The *non*-outcome assertions
  in the same cases (`restoreError`, `filesRevision`, `requests()`) already held, which is the
  point of the task: the behaviour was correct and only unreported.
- **Green:** `RestoreOutcome` exported as pinned; `'blocked'` at the guard **and at all three
  `if (!current(gen))` early exits**, `'failed'` in the `catch`, `result.changed ? 'restored' :
  'unchanged'` on success. Argument list untouched.

### T17 — two toasts, both on restore (AC-4, AC-5 L2) · lane L-TOAST-RESTORE

- **Red:** 2 failed / 19 passed, both `Number of calls: 0` against a `StringContaining "Version 2"`
  — the double was reached and simply never called, so the mock and module resolution were sound.
- **Green:** `confirmRestore` awaits the outcome and branches to `toast.success(…)` / `toast(…)` /
  nothing. Copy goes through the file's existing `versionLabel`, so the sheet and the toast cannot
  drift about what a version is called. The handler stays an expression, so `no-misused-promises`
  stays quiet.
- **Incidental:** the spec's `beforeEach` default moved from `mockResolvedValue(undefined)` to
  `mockResolvedValue('restored')`, `undefined` no longer being a value the store can return. No
  existing assertion depended on it.

### T18 — a failure never toasts (AC-6, D4) · lane L-TOAST-RESTORE

- `lib/toast-sites.spec.ts`, in `no-cdn.spec.ts`'s shape: needle by concatenation, `FORMS`(4) and
  `INNOCENT`(3) proving the scanner, offenders by path, and
  `raises a toast from exactly two files, and they are the two`.
- **Deviation, deliberate and needed:** the scan skips **all** `*.spec.ts`, not only itself.
  `Sonner.spec.ts`, `deps.spec.ts` and both component specs name the package legitimately
  (dependency inventory, test doubles). Self-skip is subsumed and the comment says so.
  `style.css`'s `@import 'vue-sonner/style.css'` is outside the `.ts`/`.vue` filter, so it needed
  no exemption.
- **The scan was green on arrival** (T17 being correct), so the lane proved it bites by
  temporarily adding a third import to a file it owned and reverting: the output named
  `src/stores/workspace.ts` by path. The two "toasts nothing" cases were proved the same way — a
  temporary `toast.error` branch made each red, then was reverted and re-verified.
- **Plan drift, cosmetic:** the plan cites `SnapshotSheet.spec.ts:324` for the restore-by-id
  assertion; it is at line 337. It passes untouched, and the new case pins the single-argument
  call beside it.

### T11 — a dropped connection speaks our language (AC-8, AC-9) · the join, kept by the lead

The one task the plan says cannot be placed in a disjoint lane: it touches `generateApi.*`
(L-SESSION's T10), `stores/workspace.spec.ts` (L-TOAST-RESTORE's T16) and `ChatPanel.spec.ts`.
Run last, after both.

- **Red (L1):** 2 failed / 31 passed —
  `expected TypeError: Failed to fetch to match object { status: +0, … }` and
  `expected [Function] to throw error not matching /Failed to fetch/`. The raw browser string was
  reaching the caller, which is precisely the gap D6 names.
- **Green:** only `reader.read()` is wrapped. The frame loop stays **outside** the `try`, so a bug
  in `sse.ts` is reported as itself rather than laundered into a connection message; an abort
  rethrows untouched, because a user who left the project did not lose their connection.
- **Two honest notes.**
  - The **L2 test in `ChatPanel.spec.ts` passed on first run.** The panel renders whatever
    `generateError` holds, so at that level this is a lock, not a driver; AC-8's genuine red was at
    L1 and at the store. It is kept rather than contrived into failing.
  - The **store test was written after the L1 fix had landed**, so it too was green on arrival. It
    was proved to bite by temporarily reverting the `try` in `generateApi.ts`: it failed with
    `expected 'Failed to fetch' to be 'Something went wrong. Check your conn…'`, then the fix was
    restored and re-verified.
- **Copy left as three literals** (`apiClient.ts`, `generateApi.ts`'s open, `generateApi.ts`'s
  read), exactly as the plan directs: hoisting a string to a shared constant across two modules is
  a structural change beside a uniformity one, and each of the three has its own test asserting the
  exact words.

### T20 — the session-expiry walk (AC-20) · kept by the lead

Kept out of L-SESSION for one infrastructure reason: it is the only task whose verification needs
exclusive use of the emulator ports, and four lanes running suites concurrently would have
contended for them.

- **The plan amendment this task forced, and it is the one substantive one in the slice.**
  The walk first asserted the URL literal the PRD's AC-10 names:
  `/signin?redirect=%2Fprojects%2F<id>&reason=session_expired`. It failed — but on the
  *serialisation*, not the behaviour. The app had navigated correctly; the address bar read
  `?redirect=/projects/N8BFPxmQOjHl342bEVsh&reason=session_expired`.

  `expiredSignInPath` does percent-encode the path, and `sessionExpiry.spec.ts` pins that. But
  `router.replace()` re-serialises the query on the way into the address bar, and `/` is legal
  unescaped in a query string, so vue-router emits it bare. The two URLs are the same URL and both
  parse to the same `redirect` value.

  **The walk now asserts the parsed parameters** — `pathname === '/signin'`,
  `searchParams.get('redirect') === workspacePath`, `searchParams.get('reason') ===
  'session_expired'`. That is *stronger* than the literal match, because it asserts the thing
  AC-10 is about rather than pinning an encoding choice vue-router owns; and AC-10's literal text
  remains pinned where it is actually a contract, in `sessionExpiry.spec.ts`.
- The concrete path is read off the browser rather than constructed, so the walk genuinely
  exercises a *parameterised* route — a hardcoded path would pass even if T5's fix had not landed.
- **Green:** `1 passed (5.1s)`.

## Deviations from the plan's lane split

Both are build-stage coordination calls, not design changes:

1. **T14 was kept by the lead** rather than run as L-TOAST's head. It is the only task that runs
   `npm install`, and mutating `node_modules` underneath four lanes running Vitest is a race with
   nothing to gain. L-TOAST was then split into two lanes that share no file — **L-TOAST-APP**
   (T15) and **L-TOAST-RESTORE** (T16→T17→T18) — which also balanced the remaining weight.
2. **T20 was kept by the lead** rather than run at the tail of L-SESSION, because it needs
   exclusive emulator ports.

Lanes were also told to run **only their own spec files**, never the full suite: with four lanes
editing concurrently, a full-suite run inside a lane reports other lanes' in-progress edits as
failures. The lead ran the full suite after each lane landed. This proved its worth twice — L-AC1
and L-HL each reported a lint error in another lane's mid-flight file, and both were gone once
that lane finished.

## Final suite

Run on the complete branch, in order:

| Gate | Result |
|---|---|
| `npm run typecheck` | **green** (functions, frontend, root) |
| `npm run lint` | **green**, `--max-warnings 0` |
| `npm run test:unit` | **green** — functions 46 files / 1136 · frontend 73 files / **1047** · scripts 3 / 21 |
| `npm run test:rules` | **green** — 1 file / 52 (unchanged from baseline, as D14 requires) |
| `npm run test:integration` | **green** — 17 files / 378 (unchanged from baseline) |
| `npm run test:e2e` | **green** — **19 passed**, including the new walk |

Frontend unit tests went 962 → 1047 (**+85**). Rules and integration counts did not move, which
is the correct outcome for a slice that adds no collection.

**D14, measured rather than asserted** — the definition-of-done line:

```
$ git diff main...HEAD --stat -- functions/ firestore.rules tests/rules/ tests/integration/
$
```

Empty. Zero files. No new Firestore collection, therefore no new rules and no new L3 test; the
existing rules continue to deny every client outright and the existing L3 suite continues to prove
it. `no-firestore.spec.ts` stays green and in the suite (D16) — nothing here adds a client-SDK
call, a `:uid` path segment, or a route.

**R2 (Monaco), checked:** `editor.spec.ts`'s `editor renders with a real height at both layouts`
is green in the e2e run above. The nineteen swaps did not reintroduce the 5 px editor.

**R1 (the invisible stylesheet), partially closed:** no unit test can see it, as the plan says.
Build-time evidence was gathered instead — `npm --prefix frontend run build` produces
`dist/assets/index-*.css` containing sonner's styles, so the `@import` genuinely reaches the
bundle. That proves the import is wired, **not** that the toast looks right; the human visual
check remains, below.

## Acceptance criteria — every one, and the test that proves it

| AC | Test | File |
|---|---|---|
| AC-1 | `offers Reconnect HighLevel for %s` (+ the testid assertion) | `PreviewPanel.spec.ts` |
| AC-2 | `renders a pulsing placeholder carrying the slot attribute`; `renders Skeleton placeholders while loading` × 10 | `Skeleton.spec.ts` + the ten component specs |
| AC-3 | `pulses in no file outside components/ui/skeleton` | `lib/no-pulse.spec.ts` |
| AC-4 | `confirms a successful restore with a toast naming the version` | `SnapshotSheet.spec.ts` |
| AC-5 | `says so when the restore changed nothing`; `reports a restore that changed nothing` | `SnapshotSheet.spec.ts`, `stores/workspace.spec.ts` |
| AC-6 | `raises a toast from exactly two files, and they are the two`; `renders a failed restore inline and toasts nothing`; `reports a failed save inline and toasts nothing` | `lib/toast-sites.spec.ts`, `SnapshotSheet.spec.ts`, `FileEditor.spec.ts` |
| AC-7 | `mounts exactly one Toaster` | `App.spec.ts` |
| AC-8 | `maps a mid-stream read failure to a message the user can act on`; `says nothing about what the browser called it`; `renders the app's own line when the stream dies mid-reply` | `generateApi.spec.ts`, `ChatPanel.spec.ts` |
| AC-9 | `keeps the prompt and reopens the stream after a mid-stream drop` | `stores/workspace.spec.ts` |
| AC-10 | `invokes the session hook for a 401 unauthenticated, and still throws`; `signs out and lands on sign-in carrying the path they were on` | `apiClient.spec.ts`, `sessionExpiry.spec.ts` |
| AC-11 | `shows the expiry notice for reason=session_expired`; `shows no notice without a reason`; `shows no notice for an unrecognised reason` | `SignInView.spec.ts` |
| AC-12 | `returns a concrete path for a parameterised route`; `returns to the workspace it was sent from` | `redirect.spec.ts`, `SignInView.spec.ts` |
| AC-13 | `leaves app_check_failed alone` | `apiClient.spec.ts` |
| AC-14 | `leaves a 403 email_unverified alone` | `apiClient.spec.ts` |
| AC-15 | `fires once for three concurrent 401s` | `apiClient.spec.ts` |
| AC-16 | `invokes the session hook when the stream is refused with a 401 unauthenticated` | `generateApi.spec.ts` |
| AC-17 | `composes the message and upstream's own words` (+ the three no-parentheses cases); `renders the composed failure in the row` | `stores/hl.spec.ts`, `ConnectionPanel.spec.ts` |
| AC-18 | `titles the section with a heading`; `announces its results politely — %s` (all four states) | `ConnectionPanel.spec.ts` |
| AC-19 | `labels the check button off the probe state — %s` (four states + disabled) | `ConnectionPanel.spec.ts` |
| AC-20 | `an expired session lands on sign-in and comes back to the workspace` | `tests/e2e/errors.spec.ts` |

**No acceptance criterion is without a named, passing test.**

## Left for a human — the one definition-of-done line this stage cannot close

The DoD says *"The three manual demo breaks walked once by hand: the model, the session,
HighLevel."* **This was not done**, and cannot be: it needs a person at a browser. It is the only
DoD line this build leaves open, and it matters most for **R1** — the toast stylesheet is the one
change in the slice with no automated proof of its visible result. The console recipes for all
three breaks are in `03-plan.md` § Manual verification and are ready to paste.

Everything else in the definition of done is closed and measured above.

## Deferred — found during the build, not fixed here

| Finding | Why not here |
|---|---|
| `lib/api.ts`'s `apiGet` has no callers anywhere in `src/` (plan C7) | Removing it is not F8 and would put a structural diff beside a uniformity one (D13). Noted for Slice 13's README. |
| The fifteen refactors earlier reviews handed to "Slice 12's audit" | D13 and the PRD's Out-of-scope table; each is re-homed there with its reason. |
