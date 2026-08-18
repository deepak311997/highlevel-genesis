# Slice 12 — Error handling & state hardening · Technical plan

**PRD:** `02-prd.md` (approved) · **Branch:** `slice/12-error-handling` · **Mode:** fast ·
**Read against:** `main` at `94bcc1f`

## Approach

Five independent, small changes plus one mechanical sweep, and no server work at all (D14).
The sweep comes first and alone: `Skeleton` is vendored and the nineteen hand-rolled
`animate-pulse` placeholders across ten components become it, guarded afterwards by a source
scan in `no-cdn.spec.ts`'s exact shape. That is a barrier rather than a lane because it
touches `ConnectionPanel.vue`, `SnapshotSheet.vue` and `ChatPanel.vue`, which three of the
later lanes also open — sequencing it first is what keeps those lanes disjoint.

The other five are genuinely separable. **Session expiry** is a callback registered once in
`main.ts` (D10): `apiClient` gains `registerSessionExpiredHook`, a latch so three concurrent
401s fire it once, and two call sites — `request` and `streamGeneration`, which is what
closes the SSE hole (AC-16). **The dropped stream** is a `try` around `reader.read()` in
`generateApi.ts`, mapping to the `ApiError(…, 0)` the opening `fetch` already maps to.
**HighLevel's `detail`** becomes an exported pure function in `stores/hl.ts` that
`failureFor` composes with, so the L1 test does not have to go through three mocked proxy
calls to assert a string. **Sonner** is vendored, mounted once in `App.vue`, and reachable
from exactly one component — enforced by a second source scan rather than by per-component
"no toast was called" assertions, which is strictly stronger and is what keeps D4 a rule.
**The probe's heading, live region and button label** are three lines in `ConnectionPanel.vue`.

Alternatives considered:

- *Put the sign-out branch in `errorForResponse`* — rejected: `authApi.ts` calls it too, and
  that path is unauthenticated, so a shared mapper would grow a caller-dependent branch.
- *Import the auth store and the router directly into `apiClient`* — rejected by D10: a cycle,
  and every typed client's unit test would need a Pinia instance.
- *Reset the once-only latch when the hook is registered* — rejected: registration happens once
  at boot, so a second expiry in the same tab would never fire. The latch clears on any
  **successful** authenticated response instead, which is the exact proof that the session is
  alive again.
- *A `Skeleton` base class of `bg-accent`* (shadcn-vue's own default) — rejected: `style.css`
  reserves the ember accent for the one element per view that is *live*, and nineteen pulsing
  accent blocks would spend it on the calmest state in the app. Base is `bg-secondary`, which
  is what all nineteen already use.
- *Re-export `toast` from `@/components/ui/sonner`* — rejected: it would make the source scan
  check our own barrel rather than the package, and one indirection buys nothing when the rule
  is "exactly two files may name `vue-sonner`".

## What the PRD says that the code does not

Recorded here rather than fixed silently. None of it changes the slice's scope; two of them
change what a task has to do.

| # | PRD says | The code at `94bcc1f` | What this plan does |
|---|---|---|---|
| C1 | AC-10, AC-12, AC-20 and the test matrix name the workspace route `/workspace/:id` | `router/index.ts:78` registers `/projects/:projectId`; `workspace.spec.ts`'s e2e and `helpers.openNewProject` both use it | Every task and assertion uses `/projects/:projectId`. The ACs are otherwise met verbatim. |
| C2 | AC-12 assumes signing in returns the user to a workspace path | `safeRedirect` (`lib/redirect.ts:65`) tests `knownPaths.includes(pathnameOf(raw))` against `router.getRoutes().map(r => r.path)` — which yields the **pattern** `/projects/:projectId`, never the concrete `/projects/abc123`. Today a signed-out user deep-linked to a workspace is returned to `/dashboard`. No test catches it: `auth.spec.ts:46` only ever asserts `/dashboard`. | **T5 exists for this.** AC-12 and AC-20 cannot pass without it, and the PRD does not name it. |
| C3 | The audit table lists `file-editor-loading` for the `FileEditor` / `CodeEditor` row | `CodeEditor.vue:271` uses `code-editor-loading`; `FileEditor.vue:145` uses `file-editor-loading`. Both exist and both are asserted. | Both are treated as audit rows. AC-2 lists both components, so nothing is dropped. |
| C4 | AC-1 reads as though the audit's testid coverage is unknown | Measured: of the 61 testids in the audit table, **60** are already asserted in their component's spec. The one exception is `preview-reconnect`, which *is* asserted — as `RouterLinkStub` with `to === '/dashboard'` and the text `Reconnect HighLevel` (`PreviewPanel.spec.ts:411–414`) — but never by its testid, so the audit table is not checkable against it. | **T19** adds the testid assertion to that existing test. AC-1 is one line, not a work item, and R5 does not materialise. |
| C5 | E12 says a throwing `sessionStorage` costs the user their workspace | The return path travels in the **query string** (`?redirect=`), which `SignInView.submit` reads directly; `sessionStorage` is only needed across the emailed-verification round trip. The hook therefore does not write it at all. | The user keeps their workspace even in private browsing. E12's outcome is met and then some; it is not an AC. |
| C6 | The test matrix maps AC-6 to `SnapshotSheet`, `FileEditor` **and** `ChatPanel` specs | `ChatPanel.spec.ts` is also where AC-8's L2 lives, which puts two lanes on one file | **T18** asserts AC-6 in `SnapshotSheet.spec.ts` and `FileEditor.spec.ts`, and replaces the `ChatPanel` row with `lib/toast-sites.spec.ts` — a scan proving no component *except* `SnapshotSheet.vue` can reach `vue-sonner` at all. Strictly stronger than the assertion it replaces, and it keeps the lanes disjoint. |
| C7 | — | `lib/api.ts`'s `apiGet` has **no callers** anywhere in `src/` | Left alone. Removing it is not F8 and would be a structural diff beside a uniformity one (D13). Noted for Slice 13's README. |

**API-only data access (D16, `CLAUDE.md`):** nothing in this plan adds a Firestore client-SDK
call, a `:uid` path segment, or a route. `no-firestore.spec.ts` stays green and stays in the
suite. Every new read goes through an existing typed client over `apiClient.request`.

## File map

| File | New/Edit | What changes |
|---|---|---|
| `frontend/src/components/ui/skeleton/Skeleton.vue` | New | The primitive: a `div` with `data-slot="skeleton"` and `cn('animate-pulse rounded-md bg-secondary', props.class)` |
| `frontend/src/components/ui/skeleton/index.ts` | New | `export { default as Skeleton } from './Skeleton.vue'` |
| `frontend/src/components/ui/skeleton/Skeleton.spec.ts` | New | The slot attribute, the base classes, and that a caller's `class` wins a Tailwind conflict |
| `frontend/src/components/AccountCard.vue` | Edit | 2 placeholders → `Skeleton` |
| `frontend/src/components/ConnectionPanel.vue` | Edit | 3 placeholders → `Skeleton`; Data access heading, live region, button label |
| `frontend/src/components/ProjectsCard.vue` | Edit | 2 placeholders → `Skeleton` |
| `frontend/src/views/WorkspaceView.vue` | Edit | 1 placeholder → `Skeleton` |
| `frontend/src/components/workspace/ChatPanel.vue` | Edit | 2 placeholders → `Skeleton` |
| `frontend/src/components/workspace/FileTree.vue` | Edit | 2 placeholders → `Skeleton` |
| `frontend/src/components/workspace/FileEditor.vue` | Edit | 1 placeholder → `Skeleton` |
| `frontend/src/components/workspace/CodeEditor.vue` | Edit | 3 placeholders → `Skeleton` |
| `frontend/src/components/workspace/PreviewPanel.vue` | Edit | 1 placeholder → `Skeleton` |
| `frontend/src/components/workspace/SnapshotSheet.vue` | Edit | 2 placeholders → `Skeleton`; the two restore toasts |
| `frontend/src/components/AccountCard.spec.ts` | Edit | AC-2 assertion |
| `frontend/src/components/ConnectionPanel.spec.ts` | Edit | AC-2, AC-17 (L2), AC-18, AC-19 |
| `frontend/src/components/ProjectsCard.spec.ts` | Edit | AC-2 |
| `frontend/src/views/WorkspaceView.spec.ts` | Edit | AC-2 |
| `frontend/src/components/workspace/ChatPanel.spec.ts` | Edit | AC-2, AC-8 (L2) |
| `frontend/src/components/workspace/FileTree.spec.ts` | Edit | AC-2 |
| `frontend/src/components/workspace/FileEditor.spec.ts` | Edit | AC-2, AC-6 |
| `frontend/src/components/workspace/CodeEditor.spec.ts` | Edit | AC-2 |
| `frontend/src/components/workspace/PreviewPanel.spec.ts` | Edit | AC-2, AC-1 (`preview-reconnect` testid) |
| `frontend/src/components/workspace/SnapshotSheet.spec.ts` | Edit | AC-2, AC-4, AC-5 (L2), AC-6 |
| `frontend/src/lib/no-pulse.spec.ts` | New | AC-3 — the source scan |
| `frontend/src/lib/toast-sites.spec.ts` | New | D4 — `vue-sonner` is named by exactly two non-spec files |
| `frontend/src/lib/redirect.ts` | Edit | `safeRedirect` matches parameterised route patterns (C2) |
| `frontend/src/lib/redirect.spec.ts` | Edit | The parameterised, the catch-all and the still-refused cases |
| `frontend/src/lib/apiClient.ts` | Edit | `registerSessionExpiredHook`, `noteApiError`, `noteSessionAlive`; `request` calls both |
| `frontend/src/lib/apiClient.spec.ts` | Edit | AC-10, AC-13, AC-14, AC-15 |
| `frontend/src/lib/sessionExpiry.ts` | New | `expiredSignInPath`, `createSessionExpiredHook` |
| `frontend/src/lib/sessionExpiry.spec.ts` | New | AC-10's second half |
| `frontend/src/main.ts` | Edit | Registers the hook, after Pinia and the router are installed |
| `frontend/src/views/SignInView.vue` | Edit | The `?reason=` notice |
| `frontend/src/views/SignInView.spec.ts` | Edit | AC-11, AC-12 |
| `frontend/src/lib/generateApi.ts` | Edit | The pre-flush 401 through the hook; the read-loop rejection mapped |
| `frontend/src/lib/generateApi.spec.ts` | Edit | AC-8 (L1), AC-16 |
| `frontend/src/stores/workspace.ts` | Edit | `restoreSnapshot` returns a `RestoreOutcome` |
| `frontend/src/stores/workspace.spec.ts` | Edit | AC-5 (L1), AC-9 |
| `frontend/src/stores/hl.ts` | Edit | `withDetail`, exported; `failureFor` uses it |
| `frontend/src/stores/hl.spec.ts` | Edit | AC-17 (L1) |
| `frontend/src/components/ui/sonner/Sonner.vue` | New | The vendored `Toaster`, themed off `useDarkClass` |
| `frontend/src/components/ui/sonner/index.ts` | New | `export { default as Toaster } from './Sonner.vue'` |
| `frontend/src/components/ui/sonner/Sonner.spec.ts` | New | It mounts, and follows the `dark` class |
| `frontend/src/App.vue` | Edit | `<Toaster />`, once, at the shell root |
| `frontend/src/App.spec.ts` | Edit | AC-7 |
| `frontend/src/style.css` | Edit | `@import 'vue-sonner/style.css';` beside the font imports |
| `frontend/package.json` | Edit | `vue-sonner` |
| `frontend/package-lock.json` | Edit | Lockfile |
| `frontend/src/lib/deps.spec.ts` | Edit | `vue-sonner` added to `EXPECTED` |
| `tests/e2e/errors.spec.ts` | New | AC-20 — the session-expiry walk |

**Untouched, and measured (D14):** `functions/`, `firestore.rules`, `tests/rules/`,
`tests/integration/`, `firebase.json`, `.firebaserc`, `scripts/`.

## Pinned interfaces

Where two tasks meet. The build must not invent alternatives to these.

```ts
// frontend/src/components/ui/skeleton/index.ts
export { default as Skeleton } from './Skeleton.vue'
// Skeleton.vue: props { class?: HTMLAttributes['class'] }
// root: <div data-slot="skeleton" :class="cn('animate-pulse rounded-md bg-secondary', props.class)" />
```

```ts
// frontend/src/components/ui/sonner/index.ts
export { default as Toaster } from './Sonner.vue'
// Sonner.vue takes no props; theme follows useDarkClass(); position="bottom-right"
```

```ts
// frontend/src/lib/apiClient.ts  — new exports
export type SessionExpiredHook = () => void

/** Registered once, in main.ts. `null` restores the no-op default and clears the latch. */
export function registerSessionExpiredHook(hook: SessionExpiredHook | null): void

/** Fire the hook iff this is a 401 whose code is `unauthenticated`, and at most once. */
export function noteApiError(err: unknown): void

/** A call that succeeded proves the session is alive; the next death is a new one. */
export function noteSessionAlive(): void
```

```ts
// frontend/src/lib/sessionExpiry.ts
export const SESSION_EXPIRED_REASON = 'session_expired'

export interface SessionExpiryDeps {
  isSignedIn: () => boolean
  currentPath: () => string
  signOut: () => Promise<void>
  replace: (path: string) => Promise<void>
}

/** `/projects/abc` → `/signin?redirect=%2Fprojects%2Fabc&reason=session_expired` */
export function expiredSignInPath(from: string): string

export function createSessionExpiredHook(deps: SessionExpiryDeps): SessionExpiredHook
```

```ts
// frontend/src/stores/workspace.ts
export type RestoreOutcome = 'restored' | 'unchanged' | 'blocked' | 'failed'
// WorkspaceStore['restoreSnapshot']: (snapshotId: string) => Promise<RestoreOutcome>
// The argument list is unchanged — SnapshotSheet.spec.ts:324 asserts restoreSnapshot('snap-2').
```

```ts
// frontend/src/stores/hl.ts
/** The message, plus upstream's own words about the request when they add something. */
export function withDetail(message: string, detail: string | undefined): string
// '' | undefined | === message  →  message alone, no parentheses, no separator
// otherwise                     →  `${message} (${detail})`
```

```ts
// frontend/src/lib/redirect.ts — signature unchanged, membership test widened
export function safeRedirect(raw: string | null | undefined, knownPaths: readonly string[]): string
```

New `data-testid`s, and nothing else new is added:

| testid | Where | Why |
|---|---|---|
| `signin-notice` | `SignInView.vue` | AC-11 |
| `data-access-results` | `ConnectionPanel.vue` | AC-18's live region |

## Task list

Ordered. Each is one red-green-refactor cycle and one commit. Every AC maps to at least one
task; the map is in the Test coverage table below and **no AC is unmapped**.

---

### T1 — Vendor `Skeleton` → AC-2
- **Red:** `frontend/src/components/ui/skeleton/Skeleton.spec.ts` — `renders a pulsing
  placeholder carrying the slot attribute` asserting `data-slot="skeleton"` and the three base
  classes; and `lets a caller override the radius`, mounting with `class="rounded"` and
  asserting `rounded-md` is gone (tailwind-merge resolves the conflict, which is what lets the
  five sites that use `rounded` keep their shape — R2).
- **Green:** `Skeleton.vue` + `index.ts`, exactly as pinned above. `Alert.vue`/`CardTitle.vue`'s
  prop shape (`class?: HTMLAttributes['class']`, no `withDefaults`), which already passes
  `vue/require-default-prop` in this config.
- **Refactor:** none expected. Do **not** run `npx shadcn-vue@latest add skeleton` — upstream's
  base class is `bg-accent`, which `style.css` reserves for the live element; write the file.
- **Files:** the three under `components/ui/skeleton/`.

### T2 — Skeleton: the dashboard three → AC-2
- **Red:** in `AccountCard.spec.ts`, `ConnectionPanel.spec.ts`, `ProjectsCard.spec.ts` — one
  test each, `renders Skeleton placeholders while loading`, asserting the existing loading
  testid still resolves **and** that it contains `[data-slot="skeleton"]` elements (2, 2 and 2
  respectively; ConnectionPanel's third is the probe's, covered in T13's file but swapped here).
- **Green:** replace all seven placeholders across `AccountCard.vue` (2), `ConnectionPanel.vue`
  (3 — lines 110, 111, 179), `ProjectsCard.vue` (2). Each becomes `<Skeleton class="…" />`
  carrying the site's **existing** sizing utilities minus `animate-pulse` and `bg-secondary`;
  keep `rounded` where the site had `rounded` rather than `rounded-md`.
- **Refactor:** import `Skeleton` from `@/components/ui/skeleton` in each.
- **Files:** those three `.vue` and three `.spec.ts`.

### T3 — Skeleton: the workspace seven → AC-2
- **Red:** one test each in `WorkspaceView.spec.ts`, `ChatPanel.spec.ts`, `FileTree.spec.ts`,
  `FileEditor.spec.ts`, `CodeEditor.spec.ts`, `PreviewPanel.spec.ts`, `SnapshotSheet.spec.ts`,
  in T2's shape. `FileTree.spec.ts:56` and `CodeEditor.spec.ts:270` already have a skeleton
  test — extend those rather than adding a second.
- **Green:** twelve placeholders → `Skeleton`: `WorkspaceView.vue` (1, line 64),
  `ChatPanel.vue` (2, 149–150 — keep `self-end` on the second), `FileTree.vue` (2),
  `FileEditor.vue` (1), `CodeEditor.vue` (3), `PreviewPanel.vue` (1), `SnapshotSheet.vue` (2).
- **Refactor:** —
- **Risk (R2):** `CodeEditor.vue`'s and `FileEditor.vue`'s placeholders sit inside
  `absolute inset-0` wrappers whose height chain is flex the whole way down. The `Skeleton`
  carries the same `h-*`/`w-*` it replaces, so intrinsic sizing does not change. `editor.spec.ts`'s
  `editor renders with a real height at both layouts` is the backstop and must stay green.
- **Files:** those seven `.vue` and seven `.spec.ts`.

### T4 — `animate-pulse` lives in one place → AC-3
- **Red:** `frontend/src/lib/no-pulse.spec.ts`, in `no-cdn.spec.ts`'s exact shape — needle built
  by concatenation (`'animate-' + 'pulse'`), `SELF = 'no-pulse.spec.ts'`, a `FORMS`/`INNOCENT`
  pair proving the scanner before it is trusted, and the tree walk reporting offenders **by
  path**. The allowed directory is `components/ui/skeleton/` and nothing else.
- **Green:** already green if T2 and T3 landed. If it is not, the failure names the file it
  missed, which is the point. Write the scan **before** running it, so its red state is the
  nineteen-offender list.
- **Refactor:** —
- **Note:** the scan reads `.ts` and `.vue` under `src/`, so `style.css` is not in scope and no
  spec mentions the string today (checked).
- **Files:** `frontend/src/lib/no-pulse.spec.ts`.

---

### T5 — `safeRedirect` accepts a parameterised route → C2, prerequisite for AC-12 and AC-20
- **Red:** `frontend/src/lib/redirect.spec.ts` — with `KNOWN` extended to include
  `'/projects/:projectId'` and `'/:pathMatch(.*)*'`:
  - `returns a concrete path for a parameterised route` — `/projects/abc123` survives
  - `keeps a query and hash on a parameterised path`
  - `still refuses a path the catch-all would swallow` — `/not-a-route` falls back, i.e.
    `'/:pathMatch(.*)*'` must not act as an allowlist entry
  - `refuses an extra segment` — `/projects/abc/extra` falls back
  - the existing hostile-payload cases, unchanged
- **Green:** a private `matcherFor(pattern: string): RegExp | null` in `redirect.ts`. Returns
  `null` for any pattern containing `(`, `*`, `?` or `+` — which is exactly the catch-all, and
  which must be skipped because it matches everything and would make the allowlist meaningless.
  Otherwise splits on `/`, maps a `:param` segment to `[^/]+` and escapes the rest, and anchors.
  `safeRedirect` then uses `knownPaths.some(...)` instead of `includes`.
- **Refactor:** document why the allowlist is over *patterns* rather than paths, and why the
  catch-all is excluded — the next reader will otherwise "fix" it back.
- **Files:** `frontend/src/lib/redirect.ts`, `frontend/src/lib/redirect.spec.ts`.

### T6 — The sign-out hook, in `apiClient` → AC-10, AC-13, AC-14, AC-15
- **Red:** `frontend/src/lib/apiClient.spec.ts`:
  - `invokes the session hook for a 401 unauthenticated, and still throws` (AC-10)
  - `leaves app_check_failed alone` — hook not called, the `ApiError` still propagates with the
    server's *"Request could not be verified. Reload the page and try again."* (AC-13, D8)
  - `leaves a 403 email_unverified alone` (AC-14)
  - `fires once for three concurrent 401s` — three `request()` calls in `Promise.allSettled`,
    hook called exactly once (AC-15)
  - `fires again after a call that succeeded` — the latch clears on success
  - `does nothing when no hook is registered` — the unregistered default is a no-op (R4)
  - `ignores a 401 with no code` — `authHeaders`' own "nobody is signed in" 401 must not
    sign anyone out
- **Green:** module-level `let onSessionExpired: SessionExpiredHook | null = null` and
  `let signalled = false`; the three exported functions as pinned. In `request`:
  `if (!res.ok) { const err = await errorForResponse(res); noteApiError(err); throw err }` and
  `noteSessionAlive()` on the success path before parsing.
- **Refactor:** the `beforeEach`/`afterEach` in the spec calls `registerSessionExpiredHook(null)`
  so the module's state cannot leak between cases (R4).
- **Files:** `frontend/src/lib/apiClient.ts`, `frontend/src/lib/apiClient.spec.ts`.

### T7 — What the hook does → AC-10
- **Red:** `frontend/src/lib/sessionExpiry.spec.ts`:
  - `expiredSignInPath` — `/projects/abc` → `/signin?redirect=%2Fprojects%2Fabc&reason=session_expired`
  - `signs out and lands on sign-in carrying the path they were on` — with stub deps, asserts
    `signOut` ran and `replace` got that URL
  - `reads the path before signing out` — `currentPath()` is called before `signOut()`, or the
    guard's own navigation would have moved it first
  - `does nothing when nobody is signed in` (E7) — neither dep is called
- **Green:** `frontend/src/lib/sessionExpiry.ts` as pinned. `SIGN_IN_PATH` is imported from
  `@/router/guard`, which already exports it, rather than restated. The returned hook is
  synchronous and starts the async work with `void`; the async body is a private function so
  `no-floating-promises` has something to point at.
- **Refactor:** —
- **Files:** the two new files.

### T8 — Wire it up in `main.ts` → AC-10 (scaffolding)
- **Red:** **none, and this is deliberate.** `main.ts` is four statements of application
  assembly with no exports and no branches; a unit test of it would assert that the file calls
  the functions the file calls. Its correctness is proved by T20's L5 walk, which is the only
  level at which "the real router, the real store and the real client are connected" is a claim.
- **Green:**
  ```ts
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)

  registerSessionExpiredHook(
    createSessionExpiredHook({
      isSignedIn: () => useAuthStore().isSignedIn,
      currentPath: () => router.currentRoute.value.fullPath,
      signOut: () => useAuthStore().signOutNow(),
      replace: async (path) => { await router.replace(path) },
    }),
  )

  app.mount('#app')
  ```
  `useAuthStore()` is called lazily inside each closure — `app.use(createPinia())` has run by
  then, so there is an active Pinia, but resolving the store eagerly at boot would build it
  before `main.ts` finishes.
- **Refactor:** a comment naming D10 — this is the one place that knows about both the router
  and the auth store, which is why the callback exists.
- **Files:** `frontend/src/main.ts`.

### T9 — The sign-in notice → AC-11, AC-12
- **Red:** `frontend/src/views/SignInView.spec.ts`:
  - `shows the expiry notice for reason=session_expired` — `signin-notice` reads *"Your session
    expired. Sign in again."*
  - `shows no notice without a reason`, and `shows no notice for an unrecognised reason`
    (`?reason=banana`) — the fixed map, nothing interpolated
  - `returns to the workspace it was sent from` (AC-12) — mount with
    `route.query.redirect = '/projects/p1'` and the router stub's `getRoutes` extended with
    `{ path: '/projects/:projectId' }`, then assert `push('/projects/p1')`. This is red until T5.
- **Green:** a module-level `Map<string, string>` with one entry, a `computed` returning
  `NOTICES.get(raw) ?? null` for a string query value, and an `<Alert data-testid="signin-notice">`
  (default variant — `role="status"`, which is what a notice wants) above the failure alert
  inside `CardContent`.
- **Refactor:** —
- **Depends on:** T5 for the third case.
- **Files:** `frontend/src/views/SignInView.vue`, `frontend/src/views/SignInView.spec.ts`.

### T10 — The SSE path is not a hole in the hook → AC-16
- **Red:** `frontend/src/lib/generateApi.spec.ts` — `invokes the session hook when the stream is
  refused with a 401 unauthenticated`, and `does not invoke it for a 401 app_check_failed`.
  Registered via `registerSessionExpiredHook`, reset in `afterEach`.
- **Green:** in `streamGeneration`, replace `if (!res.ok) throw await errorForResponse(res)` with
  the same three lines `request` uses, and call `noteSessionAlive()` once the response is ok.
- **Refactor:** the existing comment at line 164 (`Before a single event is yielded (AC-31)`)
  stays true and gains the hook's reason.
- **Depends on:** T6.
- **Files:** `frontend/src/lib/generateApi.ts`, `frontend/src/lib/generateApi.spec.ts`.

### T11 — A dropped connection speaks our language → AC-8, AC-9
- **Red:**
  - `generateApi.spec.ts` — `maps a mid-stream read failure to a message the user can act on`:
    a `body.getReader()` whose `read()` resolves once with a `token` frame and then **rejects**
    with `new TypeError('Failed to fetch')`; the generator yields that one event and then
    rejects with an `ApiError` whose `status` is `0` and whose message is *"Something went
    wrong. Check your connection and try again."*, and whose message does **not** contain
    `Failed to fetch` (AC-8).
  - `generateApi.spec.ts` — `rethrows a cancellation unchanged`: same reader, but the signal is
    aborted first; the original rejection propagates. A user who left the project must not be
    told their connection dropped.
  - `ChatPanel.spec.ts` — `renders the app's own line when the stream dies mid-reply`:
    `generate-error` contains that copy and the panel's text does **not** contain
    `Failed to fetch` (AC-8, L2).
  - `stores/workspace.spec.ts` — `keeps the prompt and reopens the stream after a mid-stream
    drop`: the user's message is still in `messages`, `generateError` is the connection copy,
    and `retry()` calls `streamGeneration` a second time (AC-9).
- **Green:** wrap `reader.read()` only:
  ```ts
  let chunk: Awaited<ReturnType<typeof reader.read>>
  try {
    chunk = await reader.read()
  } catch (err) {
    if (signal.aborted) throw err
    throw new ApiError('Something went wrong. Check your connection and try again.', 0)
  }
  if (chunk.done) break
  ```
  The frame loop stays outside the `try`, so a bug in `sse.ts` is not laundered into a
  connection message.
- **Refactor:** the copy is now written three times in `frontend/src/lib`
  (`apiClient.ts:58`, `generateApi.ts:161`, and here). Leave it as three literals — hoisting it
  to a shared constant is a structural change across two modules for a string, which is D13's
  line, and each of the three has its own test asserting the exact words.
- **Depends on:** T10 (same file) and T16 (same spec file — see Lanes).
- **Files:** `frontend/src/lib/generateApi.ts`, `frontend/src/lib/generateApi.spec.ts`,
  `frontend/src/components/workspace/ChatPanel.spec.ts`, `frontend/src/stores/workspace.spec.ts`.

---

### T12 — `detail` gets a reader → AC-17 (L1)
- **Red:** `frontend/src/stores/hl.spec.ts`:
  - `withDetail` directly: message + detail composes `message (detail)`; `undefined` detail,
    `''` detail and a detail equal to the message each yield the message alone with **no
    parentheses and no trailing separator** (E10, E11)
  - through the store: `checkDataAccess` with `hlProxy` rejecting
    `new ApiError('Could not read contacts.', 403, 'hl_upstream', 'Invalid JWT')` puts
    `Could not read contacts. (Invalid JWT)` in `probeResult.contacts.error`
- **Green:** export `withDetail` from `stores/hl.ts`; `failureFor` becomes
  `error: err instanceof ApiError ? withDetail(err.message, err.detail) : err instanceof Error ? err.message : 'Could not reach HighLevel.'`
- **Refactor:** replace the `detail` paragraph in `lib/api.ts`'s `ApiError` doc comment — it
  currently says *"`detail` has no reader yet"* and names Slice 12 as the decision point. It now
  has one; name it.
- **Files:** `frontend/src/stores/hl.ts`, `frontend/src/stores/hl.spec.ts`,
  `frontend/src/lib/api.ts` (comment only).

### T13 — The Data access section, perceivable → AC-17 (L2), AC-18, AC-19
- **Red:** `frontend/src/components/ConnectionPanel.spec.ts`:
  - `renders the composed failure in the row` — a probe result whose `contacts.error` is
    `Could not read contacts. (Invalid JWT)` renders that string in
    `data-access-row-contacts` (AC-17)
  - `titles the section with a heading` — the element containing `Data access` is an `h4`
    (AC-18). `h4` because `CardTitle` is an `h3` and `DashboardView` owns the `h1`.
  - `announces its results politely` — `data-access-results` carries `aria-live="polite"`, and
    it is present in **every** probe state including `idle`, or there is nothing for the
    assistive tech to observe when the counts land (AC-18, E14)
  - `labels the check button off the probe state` — `idle` → **Check data access**, `loading` →
    **Checking…** and `disabled`, `ready` → **Check again**, `error` → **Check again** (AC-19,
    E13)
- **Green:** in `ConnectionPanel.vue`: the `<p class="text-sm font-medium">Data access</p>`
  becomes `<h4 class="text-sm font-medium">`; the loading block, the `<dl>` and the
  `data-access-error` alert are wrapped in
  `<div data-testid="data-access-results" aria-live="polite" class="flex flex-col gap-3">`;
  and a `checkLabel` computed replaces the `hl.probeResult === null` ternary in the button.
  The existing `data-access-loading`, `data-access-error`, `data-access-row-*`,
  `data-access-check` and `data-access-reconnect` testids all keep their elements.
- **Refactor:** —
- **Depends on:** T12 (the composed string) and T2 (the same file's skeleton swap).
- **Files:** `frontend/src/components/ConnectionPanel.vue`,
  `frontend/src/components/ConnectionPanel.spec.ts`.

---

### T14 — Vendor `sonner` → AC-7
- **Red:** `frontend/src/lib/deps.spec.ts` — add `'vue-sonner'` to `EXPECTED`. Red until the
  dependency exists, and it is the test that stops a *second* package arriving with it.
  `frontend/src/components/ui/sonner/Sonner.spec.ts` — `mounts a toaster region` and
  `follows the document's dark class`.
- **Green:** `npm --prefix frontend install vue-sonner` (2.0.9 at time of writing; a caret is
  correct here — `deps.spec.ts` only pins `monaco-editor` exactly, and for a documented reason
  that does not apply). Then write `Sonner.vue` by hand rather than taking
  `npx shadcn-vue@latest add sonner`'s output verbatim: upstream's template themes off
  `@vueuse/core`'s `useColorMode`, and this project already owns `useDarkClass()`, which reads
  the `dark` class that `useTheme` and the pre-paint script in `index.html` both write. A second
  derivation of the theme is exactly what `useDarkClass`'s own doc comment exists to prevent.
  ```vue
  <script setup lang="ts">
  import { Toaster as Sonner } from 'vue-sonner'
  import { useDarkClass } from '@/composables/useDarkClass'
  const dark = useDarkClass()
  </script>
  <template>
    <Sonner class="toaster group" position="bottom-right" :theme="dark ? 'dark' : 'light'" />
  </template>
  ```
  Add `@import 'vue-sonner/style.css';` to `frontend/src/style.css`, after the two
  `@fontsource` imports and after `@import 'tailwindcss'` — which must stay first.
- **Refactor:** —
- **Risk (R1):** no automated test can see the stylesheet. The manual walk in the definition of
  done is the only proof, and it is listed there for that reason.
- **Files:** `frontend/package.json`, `frontend/package-lock.json`, `frontend/src/style.css`,
  `frontend/src/components/ui/sonner/{Sonner.vue,index.ts,Sonner.spec.ts}`,
  `frontend/src/lib/deps.spec.ts`.

### T15 — Exactly one `Toaster` → AC-7
- **Red:** `frontend/src/App.spec.ts` — `mounts exactly one Toaster`, asserting
  `wrapper.findAllComponents(Toaster)` has length 1, at both layouts.
- **Green:** `<Toaster />` in `App.vue`, inside the root `div` and **outside** `<main>`, so it is
  not affected by the `contained`/`full` switch and does not unmount on a route change.
- **Refactor:** if `vue-sonner`'s own `Toaster` proves noisy under jsdom, stub it —
  `global: { stubs: { Toaster: true } }` — and keep the `findAllComponents` assertion, which
  still counts the component. Do **not** weaken the assertion to a text or class match.
- **Depends on:** T14.
- **Files:** `frontend/src/App.vue`, `frontend/src/App.spec.ts`.

### T16 — The store reports what a restore did → AC-5 (L1)
- **Red:** `frontend/src/stores/workspace.spec.ts`:
  - `reports a restore that changed the project` — `postRestore` resolves `{ files, changed: true }`,
    `restoreSnapshot` resolves `'restored'`
  - `reports a restore that changed nothing` — `{ files, changed: false }` resolves `'unchanged'`,
    `restoreError` stays `null`, and `filesRevision` does **not** move (AC-5's "no new version"
    half, as far as the client can observe it)
  - `reports a refused restore` — called while `generating` is true, resolves `'blocked'`, and
    `postRestore` was never called
  - `reports a failed restore` — `postRestore` rejects, resolves `'failed'` and `restoreError`
    is set (unchanged behaviour, now also reported)
- **Green:** `RestoreOutcome` as pinned; `restoreSnapshot` returns `'blocked'` at the guard,
  `'failed'` in the `catch`, and `result.changed ? 'restored' : 'unchanged'` on success. The
  stale-generation early returns (`if (!current(gen)) return`) return `'blocked'` too — the
  session or project they belonged to is gone, so there is nothing to tell anyone about.
- **Refactor:** —
- **Files:** `frontend/src/stores/workspace.ts`, `frontend/src/stores/workspace.spec.ts`.

### T17 — Two toasts, both on restore → AC-4, AC-5 (L2)
- **Red:** `frontend/src/components/workspace/SnapshotSheet.spec.ts`, with
  `vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))`:
  - `confirms a successful restore with a toast naming the version` — `restoreSnapshot`
    resolves `'restored'`; `toast.success` called with a string containing `Version 2`; the sheet
    is **still open** (`snapshot-sheet` present) (AC-4)
  - `says so when the restore changed nothing` — resolves `'unchanged'`; a toast whose text says
    nothing changed and names the version; `snapshot-restore-error` absent (AC-5)
  - `still calls the store with the snapshot id alone` — the existing assertion at line 324 must
    keep passing; the seq is read from the row the user confirmed, not sent to the store
- **Green:** `confirmRestore(snapshot: Snapshot)` becomes `async`, awaits the outcome, and
  branches: `'restored'` → `toast.success(\`Restored ${versionLabel(snapshot.seq)}.\`)`,
  `'unchanged'` → `toast(\`Already on ${versionLabel(snapshot.seq)}. Nothing changed.\`)`,
  anything else → nothing. The template handler stays
  `@click="confirmRestore(snapshot)"` — an expression, which is how `@click="workspace.loadSnapshots()"`
  already satisfies `no-misused-promises` in this file.
- **Refactor:** the copy goes through `versionLabel` rather than being interpolated, so the sheet
  and the toast cannot drift about what a version is called.
- **Depends on:** T14, T16, T3.
- **Files:** `frontend/src/components/workspace/SnapshotSheet.vue`,
  `frontend/src/components/workspace/SnapshotSheet.spec.ts`.

### T18 — A failure never toasts → AC-6, D4
- **Red:**
  - `frontend/src/lib/toast-sites.spec.ts` — a source scan in `no-cdn.spec.ts`'s shape: outside
    `*.spec.ts`, the string `vue-sonner` appears in exactly two files,
    `src/components/ui/sonner/Sonner.vue` and `src/components/workspace/SnapshotSheet.vue`.
    Offenders reported by path. The needle is built by concatenation and the file skips itself.
  - `SnapshotSheet.spec.ts` — `renders a failed restore inline and toasts nothing`: `'failed'`
    outcome, `snapshot-restore-error` present, no toast function called (E9)
  - `FileEditor.spec.ts` — `reports a failed save inline and toasts nothing`
- **Green:** nothing to implement if T17 is correct; the scan's red state is the proof that it
  can catch a third site. If it is not green, the offender it names is the bug.
- **Refactor:** the scan's doc comment carries D4 in one sentence — *only the transient outcome
  of an action the user just took, that leaves nothing on screen to read* — so the next person
  who wants to toast an error reads the rule at the point of refusal.
- **Depends on:** T14, T17.
- **Files:** `frontend/src/lib/toast-sites.spec.ts`,
  `frontend/src/components/workspace/SnapshotSheet.spec.ts`,
  `frontend/src/components/workspace/FileEditor.spec.ts`.

---

### T19 — The audit table's one unchecked row → AC-1
- **Red:** `frontend/src/components/workspace/PreviewPanel.spec.ts` — in the existing
  `offers Reconnect HighLevel for %s` case (line 402), add
  `expect(link.attributes('data-testid')).toBe('preview-reconnect')`.
- **Green:** already present in `PreviewPanel.vue:138`. If `RouterLinkStub` does not forward the
  attribute, assert `wrapper.find('[data-testid="preview-reconnect"]').exists()` instead — the
  claim is that the audit table's testid renders, not how the stub reports it.
- **Refactor:** —
- **Note:** the other 60 rows are already asserted; the audit script that measured this is
  reproduced in `04-build-log.md` so the claim stays checkable.
- **Files:** `frontend/src/components/workspace/PreviewPanel.spec.ts`.

---

### T20 — The session-expiry walk → AC-20
- **Red/Green:** `tests/e2e/errors.spec.ts` — one `test`, in `preview.spec.ts`'s shape
  (`resetEmulators`, `assertEmulatorBuild`, `signUpAndVerify`, `openNewProject` from
  `./helpers`):
  1. Sign up, verify, open a project; capture `new URL(page.url()).pathname` — a real
     `/projects/<id>`.
  2. `await page.route('**/api/**', (route) => route.fulfill({ status: 401, contentType:
     'application/json', body: JSON.stringify({ error: 'Sign in and try again.', code:
     'unauthenticated' }) }))`
  3. Trigger exactly one authenticated call: click `snapshot-trigger`, which issues
     `GET /api/projects/:id/snapshots` and nothing else.
  4. `await expect(page).toHaveURL(new RegExp('/signin\\?redirect=' +
     encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '&reason=session_expired'))`
  5. `await expect(page.getByTestId('signin-notice')).toContainText('Your session expired')`
  6. `await page.unroute('**/api/**')` — Firebase Auth talks to the emulator directly, but
     everything after sign-in goes through `/api/**` and would 401 forever.
  7. Sign in with the same address and `PASSWORD`; expect the URL back at the captured path and
     `chat-panel` visible.
- **The comment the test carries (R6):** the 401 is forced with `page.route` rather than by a
  real revocation, because the Auth emulator will not invalidate an unexpired ID token and
  `verifyIdToken` does not check revocation. The server half is already covered by
  `requireUser`'s L1 and L4 tests; this walk's subject is the **client's** reaction.
- **Refactor:** if `openNewProject` proves to leave a request in flight that trips the route
  early, move the `page.route` call after an explicit `await expect(page.getByTestId('chat-empty'))
  .toBeVisible()` — which `openNewProject` already ends on.
- **Depends on:** T5, T6, T7, T8, T9.
- **Files:** `tests/e2e/errors.spec.ts`.

## Test coverage — every AC, and where

| AC | Task | Level | File |
|---|---|---|---|
| AC-1 | T19 | L2 | `PreviewPanel.spec.ts` (the other 60 rows already pass — C4) |
| AC-2 | T1, T2, T3 | L2 | the ten component specs |
| AC-3 | T4 | L1 | `lib/no-pulse.spec.ts` |
| AC-4 | T17 | L2 | `SnapshotSheet.spec.ts` |
| AC-5 | T16, T17 | L1 + L2 | `stores/workspace.spec.ts`, `SnapshotSheet.spec.ts` |
| AC-6 | T18 | L1 + L2 | `lib/toast-sites.spec.ts`, `SnapshotSheet.spec.ts`, `FileEditor.spec.ts` (C6) |
| AC-7 | T15 | L2 | `App.spec.ts` |
| AC-8 | T11 | L1 + L2 | `lib/generateApi.spec.ts`, `ChatPanel.spec.ts` |
| AC-9 | T11 | L1 | `stores/workspace.spec.ts` |
| AC-10 | T6, T7 | L1 | `lib/apiClient.spec.ts`, `lib/sessionExpiry.spec.ts` |
| AC-11 | T9 | L2 | `views/SignInView.spec.ts` |
| AC-12 | T5, T9 | L1 + L2 | `lib/redirect.spec.ts`, `views/SignInView.spec.ts` |
| AC-13 | T6 | L1 | `lib/apiClient.spec.ts` |
| AC-14 | T6 | L1 | `lib/apiClient.spec.ts` |
| AC-15 | T6 | L1 | `lib/apiClient.spec.ts` |
| AC-16 | T10 | L1 | `lib/generateApi.spec.ts` |
| AC-17 | T12, T13 | L1 + L2 | `stores/hl.spec.ts`, `ConnectionPanel.spec.ts` |
| AC-18 | T13 | L2 | `ConnectionPanel.spec.ts` |
| AC-19 | T13 | L2 | `ConnectionPanel.spec.ts` |
| AC-20 | T20 | L5 | `tests/e2e/errors.spec.ts` |

**No AC is unmapped.** The edge cases map as: E1→T11, E2 (already correct on `main`)→T11's
existing sibling case, E3→T6/T7/T20, E4→T6, E5→T6, E6→T6, E7→T6/T7, E8→T16/T17, E9→T18,
E10/E11→T12, E12→C5 (no code — the query string carries the path), E13→T13, E14→T13.

## Firestore rules changes

**None**, and D14 requires that to be measured rather than asserted. No collection, no document
shape, no field, no index — therefore no L3 test, and `tests/rules/` gains nothing.

The proof is a definition-of-done line, not a claim:

```
git diff main...HEAD --stat -- functions/ firestore.rules tests/rules/ tests/integration/
```

must print nothing. Paste the (empty) output into `04-build-log.md`.

`firestore.rules` continues to deny every client outright and the existing L3 suite continues to
prove it; nothing in this slice touches the frontend's data access, which stays API-only
(D16, `CLAUDE.md`).

## Dependencies

| Package | Where | Why |
|---|---|---|
| `vue-sonner` (^2.0.9) | `frontend/dependencies` | The runtime behind shadcn-vue's `sonner`. Two call sites (D3), both on restore. It also ships `vue-sonner/style.css`, which **must** be imported or the toast mounts invisibly (R1). |

Nothing else. `skeleton` adds no package — it is a `div` with three classes. `deps.spec.ts`'s
whole-set assertion is what makes "one new dependency" a claim with a test behind it, and T14
is where that test goes red then green.

Its declared peers (`nuxt`, `@nuxt/kit`, `@nuxt/schema`) are all marked optional in the package's
own `peerDependenciesMeta`; nothing needs installing for them.

## Manual verification

On the emulators, from a fresh clone — `npm run install:all && npm run dev`, then sign up,
verify, and open a project.

1. **Skeletons.** Throttle the network in DevTools and reload the dashboard and a workspace.
   Every loading state pulses at the same rhythm and the same colour, and nothing jumps when the
   content lands. Open the editor at both window widths and confirm Monaco still has a real
   height (R2).
2. **The model dies mid-reply.** Send `__fail_midstream build a contact dashboard`. The partial
   reply is kept and marked, and **Retry** is offered. *(Unchanged — the regression to watch.)*
3. **The connection drops mid-reply.** Send an ordinary prompt; once tokens start arriving, set
   DevTools to Offline. The chat reads *"Something went wrong. Check your connection and try
   again."* — **not** `Failed to fetch`. Go back online and press **Retry**; the prompt is still
   in the transcript and a new reply streams.
4. **A toast, with human eyes (R1).** Open **History**, restore Version 1 — a toast naming the
   version appears at the bottom right, in the current theme, and fades. Restore the same version
   again — a toast says nothing changed. Neither one leaves an error banner behind.
5. **The session expires.** Paste this into the DevTools console, on the workspace tab, then
   click **History** (or anything else that talks to the API):

   ```js
   const real = window.fetch.bind(window)
   window.fetch = (input, init) =>
     String(typeof input === 'string' ? input : input.url).includes('/api/')
       ? Promise.resolve(
           new Response(JSON.stringify({ error: 'Sign in and try again.', code: 'unauthenticated' }), {
             status: 401,
             headers: { 'Content-Type': 'application/json' },
           }),
         )
       : real(input, init)
   ```

   This is the exact envelope `auth/requireUser.ts:44` emits, so the client sees what it would
   see from a genuinely dead session — the Auth emulator will not invalidate an unexpired ID
   token, which is R6's reason and the same reason the L5 walk uses `page.route`. The app lands
   on `/signin?redirect=%2Fprojects%2F<id>&reason=session_expired` and shows *"Your session
   expired. Sign in again."* Reload to drop the patch, sign in, and confirm you arrive back at
   that workspace.

   Then repeat with `code: 'app_check_failed'` instead: you must stay signed in, on the same
   screen, with *"Request could not be verified. Reload the page and try again."* in that
   panel's own error surface (AC-13, E4). And once more with `status: 403, code:
   'email_unverified'`: also still signed in (AC-14, E5).

6. **HighLevel returns 401.** Connect the fake location on the dashboard, then patch the same
   way — but only for the proxy, and with the envelope `hl/proxyError.ts:155` produces when
   upstream answers 401 (`__401` in the fake returns `{"message":"Invalid JWT"}`, which
   `detailFrom` lifts):

   ```js
   const real = window.fetch.bind(window)
   window.fetch = (input, init) =>
     String(typeof input === 'string' ? input : input.url).includes('/api/hl/proxy/')
       ? Promise.resolve(
           new Response(
             JSON.stringify({
               error: 'Your HighLevel connection expired.',
               code: 'hl_reconnect_required',
               detail: 'Invalid JWT',
             }),
             { status: 409, headers: { 'Content-Type': 'application/json' } },
           ),
         )
       : real(input, init)
   ```

   Press **Check data access**. The button reads **Checking…** and is disabled while the three
   requests run (AC-19, E13); the rows then read *"Your HighLevel connection expired. (Invalid
   JWT)"* (AC-17), and **Reconnect HighLevel** is on screen. With VoiceOver on, the counts are
   announced when they land (AC-18, E14).

   **The unpatched version of the same break**, which exercises the real server chain end to end:
   open the workspace, edit the generated `index.html` so one of its calls targets a path
   carrying the `__401` marker — e.g. `hl('GET', '/contacts/__401')` — and save. The preview's
   failure banner shows HighLevel's own words with a **Reconnect** link. Worth doing once; the
   patched version above is what makes the Data access rows reproducible.

The three breaks the definition of done names are steps 3, 5 and 6.

## Estimate

| Task | Estimate |
|---|---|
| T1 Vendor `Skeleton` | 20 min |
| T2 Skeleton: dashboard three | 40 min |
| T3 Skeleton: workspace seven | 60 min |
| T4 `no-pulse` scan | 30 min |
| T5 `safeRedirect` parameterised routes | 40 min |
| T6 The sign-out hook | 45 min |
| T7 What the hook does | 40 min |
| T8 `main.ts` wiring | 15 min |
| T9 The sign-in notice | 35 min |
| T10 SSE through the hook | 20 min |
| T11 Dropped connection | 35 min |
| T12 `detail` gets a reader | 25 min |
| T13 Data access, perceivable | 45 min |
| T14 Vendor `sonner` | 40 min |
| T15 Exactly one `Toaster` | 20 min |
| T16 Restore outcome | 30 min |
| T17 Two toasts | 35 min |
| T18 A failure never toasts | 35 min |
| T19 The audit's one row | 10 min |
| T20 The L5 walk | 60 min |
| **Total** | **≈ 10 h 20 min** |

Nothing is over half a day. **T20 carries the most risk** — it is the only task that runs the
real router, the real store and the real client together, so it is where a wrong assumption in
T5–T9 surfaces. **T3 carries the most breakage risk** (R2, Monaco), and `editor.spec.ts` is its
backstop. If the slice has to be cut, T4, T18 and T19 are the cheapest to defer and the least
visible; T2/T3 and T20 are the demo.

## Lanes

Task groups by the files they own, for the build stage's fan-out. A lane may run concurrently
with any lane it shares no file with.

**Barrier — L-SKELETON (T1 → T2 ∥ T3 → T4).** Nothing else may start until T4 lands. It is a
barrier rather than a lane because it opens `ConnectionPanel.vue` (also L-HL),
`SnapshotSheet.vue` (also L-TOAST) and `ChatPanel.spec.ts` (also L-STREAM). Inside it, **T2 and
T3 are disjoint** — three dashboard files versus seven workspace files, no overlap — and can run
at once. T4 must be last: it is the assertion that both finished.

Then, concurrently:

| Lane | Tasks | Files it owns exclusively |
|---|---|---|
| **L-SESSION** | T5 → T6 → T7 → T8 → T9 → T20 | `lib/redirect.{ts,spec.ts}`, `lib/apiClient.{ts,spec.ts}`, `lib/sessionExpiry.{ts,spec.ts}`, `main.ts`, `views/SignInView.{vue,spec.ts}`, `tests/e2e/errors.spec.ts` |
| **L-HL** | T12 → T13 | `stores/hl.{ts,spec.ts}`, `components/ConnectionPanel.{vue,spec.ts}`, `lib/api.ts` (comment only) |
| **L-TOAST** | T14 → T15; T16; T17 (after T14+T16) → T18 | `package.json`, `package-lock.json`, `style.css`, `components/ui/sonner/*`, `App.{vue,spec.ts}`, `lib/deps.spec.ts`, `stores/workspace.{ts,spec.ts}`, `components/workspace/SnapshotSheet.{vue,spec.ts}`, `components/workspace/FileEditor.spec.ts`, `lib/toast-sites.spec.ts` |
| **L-AC1** | T19 | `components/workspace/PreviewPanel.spec.ts` |

**L-SESSION, L-HL, L-TOAST and L-AC1 touch no file in common.** They can run fully in parallel.

**The one join — T11.** It touches `lib/generateApi.{ts,spec.ts}` (L-SESSION's T10 also does)
and `stores/workspace.spec.ts` (L-TOAST's T16 also does) and `ChatPanel.spec.ts` (nobody else,
after the barrier). So:

- **T10 runs inside L-SESSION**, immediately after T6, and owns `generateApi.ts` until it lands.
- **T11 runs last**, after T10 and after T16. It is the only task in the slice that cannot be
  placed in a disjoint lane, and it is deliberately small — one `try` block and four tests.

Chains, and why each is a chain rather than a fan-out:

- T1 → T2/T3: T2 and T3 import a component T1 creates.
- T2/T3 → T4: the scan is green only once both swaps are done; run before, its red state is the
  offender list, which is the point of writing it in that order.
- T5 → T9 → T20: AC-12's spec assertion is red until `safeRedirect` matches a parameterised
  route, and the L5 walk exercises the whole path.
- T6 → T10: T10 calls exports T6 creates.
- T12 → T13: the panel renders the string the store composes.
- T14 → T15/T17: both mount or call a package T14 installs.
- T16 → T17: the sheet branches on the outcome type T16 introduces.
- T17 → T18: the scan's two-file allowlist is only true once the second file exists.
