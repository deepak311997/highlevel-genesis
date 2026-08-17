# Slice 04 — Workspace shell & chat persistence · Review

**Date:** 2026-08-17 · **Branch:** `slice/04-workspace-shell` · **Diff:** 60 files, +7,561/−45
(of which 2,878 lines are slice docs and 604 are vendored shadcn-vue blocks)

Reviewed as another author's PR, against `02-prd.md`'s 37 acceptance criteria. Three findings
required a code change; all three are fixed below, test-first where the fix is behavioural.

## Suite

The counts in the first block are the orchestrator's gate run on `f71b7de`
(`.autopilot/logs/04/gate-post-build.1.log`) — the commit this review started from. The last
column is what changed under this review's own fixes.

| Check | Result at `f71b7de` | After the fixes |
|---|---|---|
| `typecheck` | pass, 0 errors | pass, re-run |
| `lint` | pass, 0 warnings (`--max-warnings 0`) | pass, re-run on the changed files |
| `test:unit` | **742** — 286 functions · 445 frontend · 11 scripts | **748** — frontend 451 (+6 new) |
| `test:rules` | **26** passed (1 file) | untouched by these fixes |
| `test:integration` | **198** passed (10 files) | untouched by these fixes |
| `test:e2e` | **9** passed (chromium) | `workspace.spec.ts`'s 3 re-run green |

The full six-suite run was not repeated: the orchestrator ran it on this exact commit minutes
before this stage started and gated on the result. What was re-run here is what the fixes touch —
the whole frontend unit suite (42 files, 451 tests) and the workspace e2e spec, which drives the
store the fix is in.

## Findings

Ordered by leverage. Severity per the skill's table; *(none)* = required before merge.

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | — | **A response for a project the user has left overwrites the one on screen.** Every request in `stores/workspace.ts` lands after an `await`, and the store is a singleton the route outlives — so "open A, back to the dashboard, open B" leaves A's requests in flight against B's screen, with no staleness guard anywhere. Four distinct wrong outcomes: (a) A's project resolves late and `project.value = <A>` puts A's name and connection badge over B's transcript; (b) A's 404 sets `projectMissing` over a perfectly good B; (c) A's `finally` clears `projectLoading` while B is still loading, and since `project` is still null and neither error flag is set, the view's `v-if` chain renders **nothing at all** — a blank screen; (d) worst, a `send()` issued in A resolves after navigating to B and appends the user's own words to B's conversation. | **Fixed**, test-first — 4 failing tests then the guard. An open *generation* (`let generation`, bumped by `open` and by `reset`, captured per request, checked after every `await`). A counter rather than comparing `projectId`, because leaving a project and returning makes the id equal again while the first response is still owed — appending that turn to a since-refetched transcript would duplicate it. `reset()` bumps it too, so a request in flight when the session ends cannot repopulate a store that sign-out just emptied. `sending` is deliberately the one flag cleared unconditionally: only one send is ever in flight (`canSend` is false while it is true), so nothing newer owns it, and leaving it set would disable the composer of whatever project the user landed on until a reload. `29ee386` |
| 2 | — | **The draft and the send error crossed projects.** `open()` reset eight pieces of state and not these two, so navigating from A to B carried A's half-written prompt and rendered A's send error under B's composer. | **Fixed**, test-first — 2 tests. Cleared only when the id actually changes, because `open()` is also what the workspace's Retry button calls (AC-22) and discarding what the user typed is no part of retrying a failed project fetch. `29ee386` |
| 3 | — | **`isMissing` reached for `status` through a cast:** `err instanceof Error && (err as { status?: number }).status === 404`. `ApiError` is exported from `lib/api.ts`, carries `readonly status: number`, and is the only thing `apiClient.request` rejects with. The cast defeats the type that exists to carry exactly this, and it also matches any unrelated `Error` that happens to have a 404 on it — which would render "that project no longer exists" for something else entirely. `references/typescript-vue.md`: "a bare `as` outside a test is suspect." | **Fixed** — narrowed on the class: `err instanceof ApiError && err.status === 404`. `29ee386` |
| 4 | Consider | **`formatTime` was called twice per bubble** in `ChatPanel.vue` — once in the `v-if` to decide whether a time line exists and once in the body to fill it. At the 200-message cap that is 400 `Intl.format` calls per render of the transcript, and a condition and its content that could in principle disagree. | **Applied** — one computed `bubbles` carrying `time`, and the template reads `message.time`. Also satisfies the style guide's "push logic into computed". `a66969e` |
| 5 | FYI | **The un-transactional cap makes the list truncate silently, which is the one thing D10 rules out.** `messageCount` is read immediately before the batch, so two concurrent sends at 198 can both land and take a project to 202 — and `transcriptQuery`'s `limit(MESSAGE_LIMIT)` then returns 200 of them, hiding two messages the user can remember writing. The build log records the overshoot; it does not record this consequence. | **No change**, deliberately. The truncation is asserted by an integration test (`returns at most the cap, even if more documents exist`), so the read limit is a decision, not an oversight; and reaching 202 needs two tabs sending simultaneously at exactly 198, since `canSend` is false while a send is in flight. A transaction on every turn to close a two-message window at a 200-message boundary is the wrong trade, and `liveProjectCount` already made it the same way. Recorded here so the next slice to touch the cap inherits the whole picture rather than half of it. |
| 6 | Nit | **A comment asserts a dependency that does not exist.** `functions/src/api/index.ts`: "After `projectsRouter`, which owns the shorter paths under the same prefix." Express matches a router's own routes exactly, so `/projects/:projectId` never matches `/projects/x/messages` and the order is free. | **No change** — the comment is harmless and the ordering it describes is the one a reader would choose anyway. Noted so nobody later treats it as a constraint. |
| 7 | FYI | **`showComposer` hides the composer while an already-loaded transcript is being refetched** (`messagesLoaded && messagesLoading` renders the loading skeleton and drops the composer). Unreachable today: the only refetch trigger is the chat panel's Retry, which only renders in the error branch. It becomes reachable the moment anything else calls `loadMessages()`. | **No change** — not a defect in this slice's behaviour. Flagged for Slice 5, which adds a second reason to reload a transcript. |

## Dead code (Step 9, decided here)

`CreateMessageBody` in `functions/src/messages/schema.ts` is exported and imported nowhere —
`parseBody(createMessageBodySchema, req)` infers the type at the call site.

**Decision: keep it.** `functions/src/projects/schema.ts` exports `CreateProjectBody` and
`PatchProjectBody` on exactly the same terms, both unimported since Slice 3, and
`users/schema.ts` exports `ProfileBody`. Every schema module in the codebase names its body type
beside its schema as the module's stated contract. Deleting only this one would make `messages/`
the single module that does not, which is a worse inconsistency than an unused type alias that is
erased at build and costs nothing shipped. The consistent alternative — deleting all four — is a
cleanup across Slice 3's merged code and does not belong in this slice's review.

Nothing else became unreachable: `formatTime` is still used (now inside the computed), and every
export in `messages/{schema,handlers}.ts` has either a runtime caller or a test that is asserting
behaviour rather than reaching through a private door.

## AC coverage

All 37 verified against named tests. The build log's table maps each AC to its test names; this
column records that the mapping was checked against the code rather than taken on trust.

| AC | Level · test | Verified |
|---|---|---|
| AC-1 – AC-5 | L4 `integration/messages.spec.ts`; L1 `messages/handlers.spec.ts` (`echoFor`, `messagePair`) | ✅ the pair, `seq` 0/1, no `seq` on the wire, ordering across turns, empty ≠ 404, trimming |
| AC-6 – AC-10 | L4 `integration/messages.spec.ts` | ✅ 401, 403, cross-tenant 404 with bob's transcript intact, soft-deleted and never-existed, four malformed ids |
| AC-11, AC-12 | L1 `messages/schema.spec.ts`; L4 `integration/messages.spec.ts` | ✅ `.strict()` refuses `role`/`id`/`seq`/`createdAt` individually **and** `{ role: 'assistant', content }` specifically, writing nothing |
| AC-13 | L4 | ✅ all three boundaries — 200 → 409, 199 → 409 (only half a turn fits), 198 → 201 landing on exactly 200 |
| AC-14 | L4 | ✅ project `updatedAt` byte-identical after a message write |
| AC-15 | L1 ×2 + L4 | ✅ all three corrupt shapes omitted; the log line carries no field of the document (asserted with a planted secret) |
| AC-16 – AC-18 | L3 `tests/rules/firestore.spec.ts` | ✅ **owner denied all five operations**, stranger denied all five, anonymous denied; both `role` values refused on create; prior collections re-asserted |
| AC-19 | L2 `ProjectsCard.spec.ts` | ✅ the name is a `RouterLink` to `/projects/<id>`; Rename and Delete remain buttons |
| AC-20 – AC-22 | L2 `WorkspaceView.spec.ts` | ✅ loading with no panels, 404 with a Back link and **no** transcript request, error with a Retry that re-opens |
| AC-23, AC-24 | L2 `WorkspaceView.spec.ts` | ✅ three panels at ≥1024px with the tabbed tree **not mounted**; tabs below it, Chat default, Preview selectable |
| AC-25 | L1 `stores/workspace.spec.ts`; L2 `MessageComposer.spec.ts` | ✅ the draft is store state, read and written through the store |
| AC-26 | L2 `WorkspaceView.spec.ts` | ✅ both badge states from `project.locationId` |
| AC-27 – AC-30 | L2 `ChatPanel.spec.ts`, `WorkspaceView.spec.ts` | ✅ four states; error ordered ahead of loading; a failed transcript leaves the header, badge and other panels intact |
| AC-31 – AC-34 | L2 `MessageComposer.spec.ts`; L1 `stores/workspace.spec.ts` | ✅ blank and whitespace disabled, Enter sends once, Shift/Ctrl/Meta/Alt+Enter do not, at-limit states the cap, failure keeps the draft and appends nothing |
| AC-35 | L2 `ChatPanel.spec.ts` | ✅ and honestly — jsdom reports `scrollHeight` 0, so the suite installs a settable stand-in and varies it (120 → 480) to prove the height was re-measured on the append rather than reused from mount |
| AC-36 | L1 `stores/workspace.spec.ts`, `messagesApi.spec.ts`, `no-firestore.spec.ts` | ✅ both headers asserted on both requests against stubbed `fetch`, not at the client boundary; the source scan still finds no `firebase/firestore` |
| AC-37 | L5 `e2e/workspace.spec.ts` | ✅ open → send → echo → reload → back-and-in; re-run green after this review's fix |

## What was checked and found clean

Named, because a review of a diff this size that only lists findings does not say where it looked.

- **Data access is API-only.** No `firebase/firestore` import under `frontend/src` — enforced three
  ways (ESLint pattern, the source scan, the built-bundle script). `messagesApi.ts` goes through
  the one `apiClient.request`; no second path to the collection exists.
- **No user identifier in a route.** `/api/projects/:projectId/messages` names the resource. The
  uid comes from `withVerifiedUser` and the document path is composed from it, so another user's
  transcript is not addressable rather than merely refused — verified by reading `messagesPath`
  and every call site, and by AC-8's cross-tenant test.
- **`role` is server-assigned and the body is `.strict()`** (D5/R3), so `{ role, content }` is a
  400 rather than a key quietly dropped. This is the slice's load-bearing security decision, and
  it is asserted at L1 on the schema, L4 over the wire, and L3 at the rules layer.
- **The rules block is required, not decorative** — rules do not cascade into subcollections, and
  the L3 tests cover the *owner* being denied, not just a stranger. The build log records that
  they were checked against a scratch recursive grant, which is the check that makes a deny-all
  test meaningful.
- **The composite index matches the query** (R2, which no test can catch): `firestore.indexes.json`
  declares `messages` / COLLECTION / `createdAt` ASC + `seq` ASC; `transcriptQuery` calls exactly
  `orderBy('createdAt','asc').orderBy('seq','asc')`. Read side by side. `messageCount`'s query has
  no `orderBy` and needs no index.
- **App Check on `POST`, not `GET`** — verified by reading `messages/index.ts`, per the standing
  rule, since `requireAppCheck` short-circuits under the emulator and no test can observe it.
  Middleware is per-route, not `router.use`, which matters because the router is mounted twice.
- **Nothing partial is persisted.** The turn is one `WriteBatch`. The `messages.length !== 2`
  branch after the re-read fails closed with a 500 rather than answering half a turn.
- **The batch-timestamp tie (R1)** is genuinely handled, and `transcriptQuery` is extracted
  specifically so the fix has a test that fails deterministically — deleting the `seq` clause
  would otherwise leave every emulator-backed test passing about half the time.
- **Loading, empty and error states** exist for both new surfaces. The placeholder panels have no
  request and so nothing to attach them to (D18) — correct, not a gap.
- **No new dependency, no `.env` change, no README delta.** `git diff main...HEAD` is empty for
  `package.json`, `package-lock.json`, `.env.example` and `README.md`; all six vendored components
  sit on the already-installed `reka-ui`. No secret appears in source, and `logAuthEvent` carries
  no field of a message.
- **Vendored blocks** were diffed for shape rather than read line by line, as R4 intends. Each
  carries a comment naming its deviation from upstream and the compiler option that forced it,
  and each matches the precedent already set by `ui/input/Input.vue` and `ui/dialog/DialogContent.vue`.
- **Change sizing.** 1,247 lines of non-doc, non-vendored source and test — over the skill's
  ~300-line guide, and the PRD called that in D30 with build order as the mitigation rather than
  optimism: the boundary shipped first, so the security-relevant half was reviewable before a
  component existed. No single file is near the 1,000-line inspection signal (largest new file:
  `integration/messages.spec.ts` at 622, all test). Accepted as one PR.
- **Scope.** Nothing in the diff that the PRD did not ask for. D21's sixth vendored component
  (`textarea`) is recorded as a departure from the plan's Libraries line, which is the convention.

## Manual verification

**Not done, and it remains the one open item.** The definition of done's "runs clean on `npm run dev`
from a fresh clone" needs a human at a browser; this stage runs unattended. What stands in for it:
the three emulator-backed suites all run against the same emulator config and are green, including
a re-run of the workspace e2e spec after this review's fix, which drives the real demo line —
dashboard → project → send → echo → reload → back and in again. Carried to `/feature-ship` as
demo evidence to capture, not as a question.

## Deliberately deferred

- **The cap's two-message overshoot window** and the list truncation it can cause — finding 5,
  argued there rather than fixed.
- **`main` is not Prettier-clean.** Four files this slice does not touch (`stores/hl.ts`,
  `components/ConnectionPanel.vue`, `lib/authApi.ts`, `lib/hlApi.spec.ts`) reformat under
  `npm --prefix frontend run format`. Prettier is not in the gate (`lint` is ESLint), so nothing
  fails, but the next slice to run `format` inherits them. One commit of its own on `main` —
  confirmed still true, and still not this slice's diff to widen.
- **A stale heading in `IMPLEMENTATION_PLAN.md` §4:** Slice 1 still reads "🔵 in review" though §0
  records it merged. Not this slice's text.
- **`CreateProjectBody` / `PatchProjectBody` / `ProfileBody` are unimported** in Slice 3's and
  Slice 1's merged code — the convention finding 7's dead-code decision defers to. If the
  convention is ever dropped, it should be dropped in all four places at once.

## Verdict

**Approved for ship.** The three required findings are fixed with tests that fail against the old
code — verified by reverting the guard and watching the transcript case go red. The slice does
what its PRD says, the security-relevant half is stronger than the checklist asks for (owner-denied
rules tests, `role` refused at three layers), and the one hazard the PRD called its own (R1's
timestamp tie) is handled with a test that fails deterministically rather than half the time.

Next: `/feature-ship 04`.
