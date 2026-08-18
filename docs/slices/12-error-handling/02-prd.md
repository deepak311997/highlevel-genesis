# Slice 12 — Error handling & state hardening · PRD
**Spec:** F8.1, F8.2, F8.3 (+ the `PRODUCT_SPEC.md` §7.2 component inventory) · **Branch:** `slice/12-error-handling` · **Depends on:** 10, 11 · **Date:** 2026-08-18

> **Design companion:** `02-prd.html`, beside this file. It is **not published** — this
> session has no `Artifact` tool available, so there is no URL to link. Open the file
> locally; the ship stage should not go looking for one.

## Problem

Eleven slices have each shipped their own loading, empty and error states, because the
definition of done made every one of them do it. The audit below is the first time anyone
has read all of them at once, and it finds the states are **there** — the gap is not
coverage, it is that they are nineteen hand-rolled placeholder `div`s rather than one
primitive, and that two failures still reach the user in a language that is not ours: a
connection that drops mid-generation shows the browser's `Failed to fetch`, and an expired
session shows *"Sign in and try again."* on a screen with no way to sign in. Both are
states the user cannot get out of without knowing to reload.

## The demo

Break three dependencies in one sitting — kill the model mid-reply, expire the session, and
answer HighLevel's calls with a 401 — and every one of them degrades into a sentence the
user can act on, ending with a sign-in that puts them back on the workspace they were on.

## Decisions

Fast mode: no interview. Every row below was decided from `docs/PRODUCT_SPEC.md` §4 (F8),
§7.2, `docs/IMPLEMENTATION_PLAN.md` §4 (Slice 12) and §9, and from the code on `main` as it
stands at `94bcc1f`.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | What is this slice, given every screen already has three states? | **An audit with a small, uniform set of fixes — not a re-implementation.** The audit table below is a deliverable in its own right; the ACs are only what it found. | `IMPLEMENTATION_PLAN.md` §4 calls Slice 12 "a cross-cutting audit rather than new features". The audit's honest finding is that the DoD line is already met on `main`; saying so with evidence is worth more than inventing work to justify the slice. What it *did* find is listed in D2–D8 and nowhere else. |
| D2 | Add shadcn-vue `skeleton`? | **Yes.** Vendor it and replace all nineteen hand-rolled `animate-pulse` placeholders across ten components. A source scan then keeps `animate-pulse` out of every file outside `components/ui/skeleton/`. | The plan's caveat is "only if the audit shows the screens actually need them". Nineteen copies of the same three-utility idiom, drifting in height and colour, is the audit showing it. It adds **no dependency** — `skeleton` is a `div` with classes — so the whole cost is the swap, and the scan is what stops the twentieth copy. |
| D3 | Add shadcn-vue `sonner`? | **Yes**, and it gets exactly two call sites: a restore that succeeded, and a restore that was a no-op. | Four documents name it as owed here (`PRODUCT_SPEC.md` §7.2, `IMPLEMENTATION_PLAN.md` §4 and §9's inventory row, and Slice 11's review F20, which records that the honest fix for the silent no-op restore "is a toast, and `sonner` is Slice 12's"). Against that: it is a real runtime dependency (`vue-sonner`) for two call sites. It goes in because Slice 13 documents the component inventory the brief grades, and hand-rolling a transient notice beside a named primitive is the worse trade. D4 is what keeps it from spreading. |
| D4 | What may a toast carry? | **Only the transient outcome of an action the user just took, that leaves nothing on screen to read.** Every failure stays in its existing inline surface. | An error that vanishes after four seconds is an error the user cannot act on, and this app's failures all have somewhere to live already. This one rule is why adopting `sonner` is a two-call-site change and not a rewrite of eighteen error surfaces. |
| D5 | Is a "file saved" toast in? | **No.** | Saving already clears the tab's dirty dot and the footer's byte count settles — the outcome is visible where the action happened. A toast for it would be noise, and it would make D4's rule read as decoration rather than as a rule. |
| D6 | What does a connection dropping mid-generation say? | **The app's own line** — *"Something went wrong. Check your connection and try again."* — with the existing Retry. The read loop's rejection is mapped the same way the opening `fetch`'s already is. | `streamGeneration` maps a failure of the *opening* `fetch` to `ApiError(…, 0)` but leaves `reader.read()` unwrapped, so the store's `err.message` renders whatever the browser called it. `Failed to fetch` in Chrome, `NetworkError when attempting to fetch resource.` in Firefox — two browsers, two strings, neither ours. F8.2 says "user can retry"; a retry the user does not understand the need for is not one. |
| D7 | What happens when an API call says the session is gone? | **On `401` with `code === 'unauthenticated'` only:** sign out, then land on `/signin?redirect=<the path they were on>&reason=session_expired`, which renders *"Your session expired. Sign in again."* Signing in returns them to that path. | Today every panel shows the server's *"Sign in and try again."* beside a Try again button that will fail identically, forever. The mechanism is already built — Slice 1's `safeRedirect`/`storeRedirect` and `SignInView`'s `?redirect=` handling — so this is a hook and a notice, not a new flow. |
| D8 | Why key on the code and not on the status? | **`401` is two unrelated conditions.** `unauthenticated` (`auth/requireUser.ts`) means the session is dead; `app_check_failed` (`auth/appCheck.ts`) means the *page* could not be attested and reloading fixes it. Only the first signs anyone out. | Signing a user out because App Check hiccuped destroys a perfectly good session and loses their unsaved editor buffers. The envelope already carries the discriminator; branching on the status alone would be branching on the wrong thing. |
| D9 | Does a `403 email_unverified` sign the user out too? | **No.** It is left to the router gate, which already owns that state. | A 403 there means a verified session became unverified, which the gate resolves on the next navigation with the verification screen the user needs. Signing them out would send them to the wrong screen for the problem. |
| D10 | Where does the sign-out hook live? | **In `apiClient`, as an injectable callback registered once in `main.ts`** — not as a direct import of the auth store or the router. | `apiClient` is imported by seven typed clients; importing the store back into it makes a cycle and makes every client's unit test need a Pinia instance. A callback keeps the module pure, keeps the L1 test a two-line stub, and puts the one place that knows about both `router` and the auth store in `main.ts`, where the app is already assembled. |
| D11 | Does `ApiError.detail` get a reader, or get deleted? | **A reader.** `stores/hl.ts`'s `failureFor` already holds the `ApiError`; when `detail` is present and is not the message, the surface row shows both. | Slice 10's review left this explicitly for Slice 12 to settle either way. `detail` is HighLevel's own text about the request (`functions/src/lib/errors.ts` D19) and the Data access probe is the one screen whose whole purpose is diagnosing a HighLevel call — *"Contacts: could not read (invalid JWT)"* is the difference between a shrug and a fix. The preview's frame-side wire shape (`{ message, status, code? }`, Slice 10 AC-21) is **not** changed. |
| D12 | Slice 8's finding F18 — the Data access section's heading and announcement? | **In**, all three parts: a real heading element, `aria-live="polite"` on the results region, and the button label keyed off `hl.probe` rather than `hl.probeResult`. | It is three lines, it is the same family as the rest of this slice (a result the user cannot perceive is a result they did not get), and Slice 8's review named this slice for it. |
| D13 | Do the refactors handed to "Slice 12's audit" come in? | **No** — `useProjectFiles` (Slice 7 D22), the generation guard triplicated across three stores (Slice 10), `SurfaceProbe` as a discriminated union (Slice 8 F15), the duplicate `ENTRY_POINT` (Slice 10). All re-homed, see Out of scope. | None of them is F8, and each would put a structural diff beside a uniformity diff — the shape a review misses things in, which is the reason Slice 7 gave for deferring the first of them in the first place. `IMPLEMENTATION_PLAN.md` §5 is explicit that Slices 2–13 ship the brief's line. |
| D14 | Does the slice touch the server? | **No.** `functions/`, `firestore.rules`, `tests/rules/` and `tests/integration/` are untouched, and the definition of done requires that to be **measured** rather than asserted. | Every finding the audit produced is a frontend rendering or a frontend error-mapping decision. A slice with no new collection whose rules count does not move is the correct outcome (Slice 10 set the precedent); proving it with `git diff --stat` is what stops it being an omission. |
| D15 | How many L5 walks? | **One**, and it is the session-expiry walk. | The other two demo failures already have e2e coverage that this slice does not change — `tests/e2e/workspace.spec.ts`'s `__fail_midstream` walk for the interrupted reply and `tests/e2e/preview.spec.ts` for the HighLevel failure banner. One walk per slice is `IMPLEMENTATION_PLAN.md` §2's rule, and the new behaviour is the one worth spending it on. |
| D16 | Does the API-only data-access rule bear on this slice? | **Yes, and nothing here contradicts it.** No Firestore client SDK call is added; the `no-firestore` source scan stays green and is part of the suite. | Recorded because the standing rule requires it to be checked rather than assumed. |

## The audit

**Every screen on `main` already renders loading, empty and error.** Read at `94bcc1f`;
each cell names the `data-testid` that proves it, so this table is checkable rather than a
claim. "—" means the surface has no such state by construction (a form has nothing to be
empty of).

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
| `FileEditor` / `CodeEditor` | `file-editor-loading` | `file-editor-empty` | `file-editor-read-error`, `file-editor-error` | `file-editor-retry`, resave |
| `PreviewPanel` | `preview-loading` | `preview-empty` | `preview-error`, `preview-failure`, `preview-runtime-error` | `preview-retry`, `preview-reconnect` |
| `SnapshotSheet` | `snapshot-loading` | `snapshot-empty` | `snapshot-error`, `snapshot-restore-error` | `snapshot-retry` |

**F8, surface by surface, as it stands before this slice:**

| Spec | Where it is handled today | Verdict |
|---|---|---|
| F8.1 malformed LLM output | Slice 6: a bad path, a duplicate, an oversized file, an over-cap set and an unterminated block each refuse the **whole** turn's files, name the reason in `generate-file-error`, and leave the stored tree byte-identical (`tests/e2e/files.spec.ts`). A prose-only reply is legitimate, not an error (Slice 6 D17). | **Complete.** Nothing owed. |
| F8.2 interrupted streams | Slice 5: the server persists the partial with `truncated: true`, marks it in the transcript and offers a Retry; the prompt is committed before the stream opens, so a generation that dies before a byte still leaves a transcript. | **One gap — D6.** A *client-side* drop renders the browser's own string. |
| F8.3 failed HL calls | Slice 8 maps every upstream condition to its own status and `code`, never answering 401; Slice 2's panel offers **Reconnect HighLevel**; Slice 10 surfaces failures inside the preview with a reconnect link. | **Two gaps — D11** (`detail` never reaches a human) **and D12** (the probe's results are unannounced). |
| DoD "loading, empty and error on every screen" | The table above. | **Met.** The gap is uniformity — D2 — not coverage. |
| Session lifetime (not named in F8, found by the audit) | Nothing. Every panel shows the server's *"Sign in and try again."* with no way to sign in. | **Gap — D7.** |

## In scope

1. `skeleton` vendored; all nineteen hand-rolled placeholders replaced; a source scan keeping it that way.
2. `sonner` vendored and mounted once; two notices, both on restore; D4's rule enforced by test.
3. A dropped connection mid-generation speaks the app's language.
4. An expired session signs out, explains itself, and comes back to where the user was.
5. `ApiError.detail` rendered in the Data access rows.
6. The Data access section announced, headed, and its button label fixed.
7. One L5 walk for #4; the audit table above, carried into `04-build-log.md` as the record of what was read.

## Out of scope

Fifteen of the nineteen items earlier reviews handed to "Slice 12's audit" do not fit; each
is re-homed below with its reason rather than dropped silently. The last two rows were named
for nobody in particular, and are here because someone would otherwise ask.

| Deferred | Picked up by | Why not here |
|---|---|---|
| The frame can hand its brokered capability to a remote origin; the fix is a transferred `MessagePort` (Slice 10, deferral 2) | A hardening slice after 13, and Slice 13's README "what you'd improve" | A protocol change across the shim, the bridge, the store, the panel and eight ACs. Not error handling, and far past the brief's line. |
| `form-action 'none'` in the assembled CSP (Slice 10, deferral 3) | Slice 13's README follow-ups | One directive, but it overrides a recorded decision (Slice 10 D10) on a security-relevant surface. That belongs in the slice that revisits the CSP, not in an error-copy pass. |
| `defer` / `async` / `type="module"` dropped by the script rewriter; rooted `/styles.css` left broken (Slice 10, deferrals 4–5) | Slice 13's README follow-ups | Both widen a security-relevant grammar against recorded decisions and recorded ACs, on model output no fixture exhibits. |
| A remount re-runs the generated app in the narrow layout (Slice 10, finding 8) | Slice 13's README follow-ups | The clean fix mounts `EditorPanel` inside a hidden container, which is exactly the zero-measure Monaco trap Slice 7's D19 documents. Trading a bounded quota cost for a plausible editor regression is not this slice's call. |
| `useProjectFiles` extraction (Slice 7 D22); the generation guard triplicated across `hl.ts`, `workspace.ts` and `preview.ts` (Slice 10); `SurfaceProbe` as a discriminated union (Slice 8 F15); the duplicate `ENTRY_POINT` (Slice 10) | Nobody, unless Slice 13 has room — recorded as known duplication in the README's improvements | D13. Structural refactors beside a uniformity pass make one diff out of two changes. |
| The tab strip's half-built APG pattern — `role="tabpanel"`, `aria-controls`, roving `tabindex`, arrow keys (Slice 7 F6) | Slice 13's README "what you'd improve" | Focus management is a different shape of change from error copy, and it is the one accessibility item here that is not about perceiving an outcome. |
| An `hl.proxy` log line for calls that never reach upstream (Slice 8 F13) | Slice 13 | Observability, and it changes what `status` means in a line Slice 9's cheat-sheet reads. |
| Zod on the frontend's own API responses (Slice 8 D32) | Nobody — recorded in the README | A new frontend dependency plus a rewrite of seven typed clients that currently narrow by hand. |
| `AbortSignal` on the remaining `exchange.ts` calls (Slice 8) | Nobody | Touches Slice 2's OAuth callback path, bounded at 20 s already, low value against the risk. |
| A console panel forwarding the preview frame's `console.log` (Slice 10) | Never — the audit did not show it needed | `preview-runtime-error` already surfaces the throw, which is what F8 asks for. |
| A prompt line steering the model off `localStorage` (Slice 10 R7) | Slice 9's cheat-sheet, if it ever proves common | A prompt change, and no fixture exhibits it. |
| Consolidating `readProjectFiles` with `readStoredFiles` (`IMPLEMENTATION_PLAN.md` §0) | The next slice that opens `functions/src/files/handlers.ts` | D14 — this slice does not open it. |
| Offline detection, retry-with-backoff, request de-duplication | Never | Not in F8, not in the brief. |

## User flow

The demo, as the L5 walk performs it:

1. Sign in, open a project, and send `__fail_midstream build a contact dashboard`. The reply
   streams two tokens and dies; the transcript keeps the partial with its interrupted mark,
   and a **Retry** sits under it. *(Unchanged by this slice — the regression it must not break.)*
2. Retry with an ordinary prompt. Files stream into the tree over `Skeleton` placeholders
   rather than nineteen bespoke ones. *(D2.)*
3. Open **History**, restore version 1. A toast confirms it. Click **Restore** on the same
   version again; a toast says the project already is that version and nothing changed —
   where before, the spinner simply stopped. *(D3.)*
4. Cut the network mid-generation. The chat says *"Something went wrong. Check your
   connection and try again."* — not `Failed to fetch` — and the Retry works. *(D6.)*
5. Expire the session. The next call the app makes lands the user on **/signin**, which says
   *"Your session expired. Sign in again."* Sign in: the workspace they were on comes back.
   *(D7.)*
6. Break HighLevel. The Data access rows read *"Contacts: could not read (Invalid JWT)"* and
   announce themselves to a screen reader, and **Reconnect HighLevel** is on screen. *(D11, D12.)*

## Data model

**No change.** No collection, no document shape, no field, no index, no `firestore.rules`
edit — and therefore no L3 test. `git diff main...HEAD --stat` listing nothing under
`functions/`, `firestore.rules`, `tests/rules/` or `tests/integration/` is a line in the
definition of done, per D14.

## API contracts

**No endpoint is added, removed or changed.** What this slice does contract-wise is *read*
two fields of the existing error envelope (`functions/src/lib/errors.ts`) that the frontend
currently parses and ignores:

| Field | Emitted by | Read by, after this slice |
|---|---|---|
| `code: 'unauthenticated'` on a `401` | `auth/requireUser.ts` | `apiClient` → sign-out hook (D7, D8) |
| `code: 'app_check_failed'` on a `401` | `auth/appCheck.ts` | Nothing new — explicitly **not** the sign-out hook (D8) |
| `code: 'email_unverified'` on a `403` | `auth/requireUser.ts` | Nothing new — the router gate owns it (D9) |
| `detail` | `hl/proxyError.ts`, carrying HighLevel's own message | `stores/hl.ts` `failureFor` → the Data access row (D11) |

The one new URL shape is a query parameter on an existing route:
`GET /signin?redirect=<safe path>&reason=session_expired`. `reason` is rendered from a
fixed map; an unknown value renders nothing.

## Edge cases and failure modes

| # | Condition | What the user sees | Retry? |
|---|---|---|---|
| E1 | Connection drops after the stream opened | The app's connection line in `generate-error`, with **Retry** | Yes, manual |
| E2 | Connection drops before the stream opened | Unchanged — same line, same Retry (already correct on `main`) | Yes, manual |
| E3 | `401 unauthenticated` on any authenticated call | Signed out, on `/signin` with *"Your session expired. Sign in again."*, returned to their path after signing in | Yes, by signing in |
| E4 | `401 app_check_failed` | The screen's own error surface, *"Request could not be verified. Reload the page and try again."* — **still signed in** | Yes, by reloading |
| E5 | `403 email_unverified` | Unchanged: the screen's error surface, and the gate on the next navigation | Yes |
| E6 | Two calls 401 at once (the dashboard fans out three) | One sign-out and one navigation, not three | n/a |
| E7 | A 401 arrives after the user already signed out | Nothing — no second navigation, no toast | n/a |
| E8 | Restore of the version the project already is | A toast: nothing changed, and which version it is on. No error surface | n/a |
| E9 | Restore fails | Unchanged: `snapshot-restore-error` inline, **no toast** (D4) | Yes |
| E10 | An HL failure with no `detail` | The message alone — no empty parentheses, no trailing separator | Yes |
| E11 | An HL failure whose `detail` repeats the message | The message once | Yes |
| E12 | `sessionStorage` throws (private browsing) while storing the return path | Signed out and on `/signin` anyway; they land on the dashboard instead of their workspace | Yes |
| E13 | The probe is re-run while a result is on screen | The button reads **Checking…** and is disabled; the previous rows stay until the new ones land | n/a |
| E14 | A screen-reader user runs the probe | The results region announces politely when the counts land | n/a |

## Acceptance criteria

**The audit**

- **AC-1** — Given the audit table above, when the suite runs, then every named
  `data-testid` in it is asserted by at least one passing L2 test in its component's spec;
  any row without one gains a test in this slice.

**Skeleton (D2)**

- **AC-2** — Given any of the ten components listed in D2 in its loading state, when it
  renders, then its placeholder is the vendored `Skeleton` (`data-slot="skeleton"`), and the
  loading `data-testid` that gated it before still resolves to the same element.
- **AC-3** — Given the frontend source, when the scan runs, then `animate-pulse` appears in
  no file outside `frontend/src/components/ui/skeleton/`.

**Sonner (D3, D4, D5)**

- **AC-4** — Given a snapshot whose file set differs from the project's, when its **Restore**
  is confirmed and succeeds, then a toast names the version restored, and the sheet stays open.
- **AC-5** — Given a snapshot the project already equals, when its **Restore** is confirmed,
  then a toast says nothing changed, no error surface appears, and no new version is created.
- **AC-6** — Given any failing operation in the app, when it fails, then no toast is
  rendered and the failure appears in its existing inline surface.
- **AC-7** — Given the app mounts, when it renders, then exactly one `Toaster` exists.

**Interrupted streams (D6, F8.2)**

- **AC-8** — Given a generation whose stream has opened, when the underlying read rejects
  mid-stream, then `generate-error` reads *"Something went wrong. Check your connection and
  try again."* and the thrown value's own message appears nowhere on screen.
- **AC-9** — Given AC-8's state, when **Retry** is pressed, then a new generation starts and
  the user's prompt is still in the transcript.

**Session expiry (D7, D8, D9, D10)**

- **AC-10** — Given a signed-in user on `/workspace/:id`, when an authenticated API call
  answers `401` with `code: 'unauthenticated'`, then the app signs out and navigates to
  `/signin?redirect=%2Fworkspace%2F<id>&reason=session_expired`.
- **AC-11** — Given `/signin?reason=session_expired`, when it renders, then it shows
  *"Your session expired. Sign in again."*; given no `reason`, or an unrecognised one, it
  shows no such notice.
- **AC-12** — Given AC-10's landing, when the user signs in successfully, then they arrive
  back at `/workspace/:id`.
- **AC-13** — Given an authenticated API call that answers `401` with
  `code: 'app_check_failed'`, then the user is **not** signed out, no navigation happens, and
  the caller's own error surface shows the server's message.
- **AC-14** — Given an authenticated API call that answers `403` with
  `code: 'email_unverified'`, then the user is **not** signed out and no navigation happens.
- **AC-15** — Given three concurrent calls that all answer `401 unauthenticated`, when they
  settle, then the sign-out hook runs once and one navigation happens.
- **AC-16** — Given the streaming generation call answers `401 unauthenticated` before its
  headers flush, then the same hook runs — the SSE path is not a hole in it.

**HighLevel detail and the probe (D11, D12)**

- **AC-17** — Given a Data access surface that failed with an `ApiError` carrying `detail`,
  when the rows render, then that row shows the message and the detail; given no `detail`,
  or a `detail` equal to the message, it shows the message alone with no stray punctuation.
- **AC-18** — Given the Data access section, when it renders, then its title is a heading
  element and its results region carries `aria-live="polite"`.
- **AC-19** — Given a probe already in flight, when the section renders, then the check
  button reads **Checking…** and is disabled; given a completed result it reads **Check
  again**; given none it reads **Check data access**.

**The demo**

- **AC-20** — Given a signed-in user in a workspace, when every API call begins answering
  `401 unauthenticated`, then they reach `/signin` with the expiry notice, and signing in
  returns them to that workspace.

## Test matrix

Every AC appears at least once. No L3 or L4 row exists, and that is D14's claim rather than
an omission.

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1 | L2 | each component's existing `*.spec.ts` | Each audit-table `data-testid` renders in its state; gaps filled |
| AC-2 | L2 | `AccountCard`, `ConnectionPanel`, `ProjectsCard`, `WorkspaceView`, `ChatPanel`, `FileTree`, `FileEditor`, `CodeEditor`, `PreviewPanel`, `SnapshotSheet` specs | The loading branch renders `Skeleton`, under the same testid |
| AC-3 | L1 | `frontend/src/lib/no-pulse.spec.ts` | `animate-pulse` occurs in no file outside `components/ui/skeleton/` |
| AC-4 | L2 | `components/workspace/SnapshotSheet.spec.ts` | A successful restore calls `toast.success` with the version; the sheet stays open |
| AC-5 | L2 | `components/workspace/SnapshotSheet.spec.ts` | A no-op restore toasts "nothing changed"; `snapshot-restore-error` absent |
| AC-5 | L1 | `stores/workspace.spec.ts` | The store reports the no-op outcome distinguishably from a change |
| AC-6 | L2 | `SnapshotSheet`, `FileEditor`, `ChatPanel` specs | A failing operation renders its inline surface and calls no toast function |
| AC-7 | L2 | `App.spec.ts` | Exactly one `Toaster` in the tree |
| AC-8 | L1 | `lib/generateApi.spec.ts` | A rejecting reader becomes `ApiError(status 0)` with the connection copy |
| AC-8 | L2 | `components/workspace/ChatPanel.spec.ts` | `generate-error` renders that copy; the raw message is absent |
| AC-9 | L1 | `stores/workspace.spec.ts` | After the drop, the prompt survives and `retry()` opens a new stream |
| AC-10 | L1 | `lib/apiClient.spec.ts` | A `401 unauthenticated` invokes the registered hook exactly once and still throws |
| AC-10 | L1 | `lib/sessionExpiry.spec.ts` | The hook signs out and replaces to `/signin` carrying `redirect` and `reason`; `main.ts` only registers it |
| AC-11 | L2 | `views/SignInView.spec.ts` | The notice renders for `session_expired`, and for nothing else |
| AC-12 | L2 | `views/SignInView.spec.ts` | A successful sign-in navigates to the `redirect` target |
| AC-13 | L1 | `lib/apiClient.spec.ts` | `app_check_failed` does not invoke the hook; the `ApiError` propagates |
| AC-14 | L1 | `lib/apiClient.spec.ts` | `403 email_unverified` does not invoke the hook |
| AC-15 | L1 | `lib/apiClient.spec.ts` | Three concurrent 401s invoke the hook once |
| AC-16 | L1 | `lib/generateApi.spec.ts` | The pre-flush `401 unauthenticated` invokes the hook |
| AC-17 | L1 | `stores/hl.spec.ts` | `failureFor` composes message + detail; identical or absent detail yields the message alone |
| AC-17 | L2 | `components/ConnectionPanel.spec.ts` | The row renders the composed string |
| AC-18 | L2 | `components/ConnectionPanel.spec.ts` | A heading element, and `aria-live="polite"` on the results region |
| AC-19 | L2 | `components/ConnectionPanel.spec.ts` | The three label states, and `disabled` while loading |
| AC-20 | L5 | `tests/e2e/errors.spec.ts` | The session-expiry walk, ending back in the workspace |

## Definition of done

The checklist from `IMPLEMENTATION_PLAN.md` §3, plus:

- [ ] Every acceptance criterion maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`, `test:e2e`
- [ ] **No new Firestore collection, and it is measured:** `git diff main...HEAD --stat` lists
      nothing under `functions/`, `firestore.rules`, `tests/rules/` or `tests/integration/` (D14)
- [ ] Error paths from `PRODUCT_SPEC.md` F8 handled for this slice's surface — the audit
      table above is the record of which, and it is copied into `04-build-log.md`
- [ ] Loading, empty and error states exist for every screen — AC-1, and the table is the proof
- [ ] `animate-pulse` appears nowhere outside `components/ui/skeleton/` (AC-3)
- [ ] The one new dependency is `vue-sonner`, added by `npx shadcn-vue@latest add sonner`, and
      `frontend/package.json` gains nothing else
- [ ] No secrets in source; no `.env` change (this slice adds no config)
- [ ] Runs clean on `npm run dev` from a fresh clone
- [ ] The three manual demo breaks walked once by hand: the model, the session, HighLevel
- [ ] PR opened with demo evidence; **human approves before merge**

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **`vue-sonner` needs its stylesheet imported**, and a missed import ships an invisible toast that every test still passes — the tests assert the call, not the pixels. | The L2 assertion is on the mounted `Toaster`, and the manual demo walk in the definition of done includes seeing a toast with human eyes. |
| R2 | **Swapping nineteen placeholders is nineteen chances to change a layout.** Monaco is the sharp one: `EditorPanel`'s height chain is flex the whole way down since Slice 7, and a `Skeleton` with different intrinsic sizing could reintroduce the 5 px editor. | The swap keeps each element's existing sizing utilities and changes only the pulse/colour classes. Slice 7's `editor renders with a real height at both layouts` e2e is the backstop and must stay green. |
| R3 | **The sign-out hook is a global side effect on a shared module.** A wrong branch signs users out on a transient failure. | D8 keys on `code`, never on status; AC-13, AC-14 and AC-15 exist precisely to pin the three ways it could over-fire. |
| R4 | **The hook makes `apiClient` stateful**, so a test that registers it leaks into the next. | D10's callback is registered in `main.ts` and reset per test; the specs assert the unregistered default is a no-op. |
| R5 | **AC-1 could balloon** if the audit's L2 coverage turns out thinner than it reads. | The table's testids were read out of the source at `94bcc1f`, not guessed. If a row genuinely needs more than a test, it becomes an out-of-scope line rather than unplanned work. |
| R6 | **The e2e forces a 401 with `page.route`, not a real revocation** — the Auth emulator will not invalidate an unexpired ID token, and `verifyIdToken` does not check revocation. | Stated in the test's own comment. The server half is already covered by `requireUser`'s L1/L4 tests; the walk's subject is the *client's* reaction. |
| R7 | **This slice is the last one before deploy**, and a regression in it is a regression in every screen at once. | It touches `frontend/` and `tests/e2e/` only (D14), the swaps are mechanical, and the full suite — 2,567 cases at Slice 10's ship time — is the gate. |
