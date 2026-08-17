# Genesis — Implementation Plan

**How we build this: one vertical slice at a time, test-first, with a human gate before every merge.**

This document is the spine of the project. It defines (1) the workflow we run for every
feature, (2) the slices the work is cut into, and (3) the rules that decide when a slice
is done. Source of truth for *what* we build is `PRODUCT_SPEC.md`; source of truth for
*how HighLevel works* is `HIGHLEVEL_PLATFORM.md`; source of truth for *which exact
packages the brief mandates* is `PRODUCT_SPEC.md` §7.

---

## 0. Where we are — 2026-08-18

| Slice | State |
|---|---|
| 0 — Rails | ✅ merged to `main` |
| 1 — Account & session | ✅ merged to `main` |
| 2 — HighLevel connection | ✅ merged to `main` |
| 2b — API-only data access | ✅ merged to `main` |
| 3 — Projects | ✅ merged to `main` |
| 4 — Workspace shell & chat persistence | ✅ merged to `main` |
| 5 — Streaming generation | ✅ merged to `main` |
| 6 — File operations | ✅ merged to `main` |
| 7 — Monaco editor | ✅ merged to `main` |
| 8 — HighLevel API proxy | ✅ merged to `main` |
| 9 — HighLevel knowledge injection | ✅ merged to `main` |
| 10 | not started |
| 11 — Snapshots & restore | 🔵 building on `slice/11-snapshots-restore` |
| 12–13 | not started |

**Slice 8 ran ahead of 7**, which §4's dependency line permits: it depends on 2 alone,
and 2 merged on day 1. Nothing in 7 is owed to it. **Slice 11 runs ahead of 9 and 10**
for the same reason: §4 makes it depend on 6 alone. It adds no frame to the SSE protocol,
nothing to the system prompt and nothing to the preview, so neither of the slices it passes
is owed anything by it either.

**Slices from here run unattended.** `scripts/autopilot.sh` drives the five-stage loop
one slice at a time — a fresh session per stage, the suite run by the orchestrator rather
than reported by the model, and a squash-merge on green. The stage skills are unchanged;
what changes is that a decision the PRD interview would have asked about gets made from
these documents and recorded in the decisions table instead.

**Two defects found on `main` on 2026-08-17, both fixed before the run started.** CI had
been red since Slice 1: `vite.config.ts` threw at config load on any checkout without a
`frontend/.env`, which is every CI checkout. Behind it, the rules suite connected to port
8080 — the *development* emulator — so off CI it "passed" by finding a dev session, loading
its rules over that session's and calling `clearFirestore()` on it.

**Suite, re-run in full on `slice/09-highlevel-knowledge` at ship time, rebased on `main`
(2026-08-18):** typecheck 0 · lint 0 · **1,858 unit** (1,051 functions · 786 frontend ·
21 scripts) · **38 rules** · **329 integration** · **16 e2e**. All six green — 2,241 cases.

Slice 9 added 129 functions unit cases and 4 integration cases, and **nothing anywhere
else**: no frontend file, no route, no collection, no rules block, no new dependency. It is
`functions/src/llm/` plus five files it touches around it, one fixture, and its four slice
documents. The rules count not moving is the correct outcome rather than an omission — the
slice adds no collection, and that was verified against `main` rather than assumed. The e2e
count does not move either: AC-26 extends Slice 6's existing walk in `tests/e2e/files.spec.ts`,
so the differentiator is read out of the editor inside the run that generated it.

**A clean rebase is not a safe one, and Slice 9 is the case for saying so.** Slice 7 merged
to `main` while Slice 9 was in review, and took the file editor's textarea with it. The
rebase produced no conflict — the two slices edited different hunks of
`tests/e2e/files.spec.ts` — and the result was still wrong: Slice 9's AC-26 assertion still
reached for `file-editor-input`, a testid that no longer exists, and failed on a missing
element rather than on anything it claims. Nothing but the L5 run could have caught it;
typecheck, lint and the other 2,240 cases were green either side of it. **The full suite is
re-run after the ship-time rebase, not before it** — that ordering is the whole reason this
was found before the PR rather than in CI.

Slice 7's ship-time run, for comparison: **1,729 unit** (922 functions · 786 frontend ·
21 scripts) · **38 rules** · **325 integration** · **16 e2e** — 2,108 cases.
`npm run build` clean, entry chunk 10.76 kB with monaco in its own chunks.

**The three things Slice 9 could not discharge**, all needing a real `ANTHROPIC_API_KEY` the
unattended sessions do not have: one credentialed generation with the produced `app.js` read
by eye, a two-generation cache confirmation (`cacheCreationInputTokens > 0`, then
`cacheReadInputTokens > 0`), and the `high` vs `xhigh` effort sweep. Per D20 no automated
test in this repository can assert what the model *does*, so these are called out in the PR
rather than left in a checklist. The sweep inherits a constraint from the review:
`thinking: {type:'disabled'}` becomes a `400` at `xhigh` and above, so effort and thinking
have to move together.

The rebase put Slice 7 on top of Slice 8, so the functions, rules and integration counts
are Slice 8's, unchanged. Slice 7 added 102 frontend unit cases and 2 e2e cases, and
**nothing anywhere else**: no route, no collection, no rules block, no index, no fixture.
It is `frontend/` plus three files under `tests/e2e/` plus these two documents. Five of
those unit cases are its
review's own, written test-first for the four defects that review found — including one
the **e2e caught on a re-run**: a model created before its file's bytes arrive inherits the
platform's line ending, so an empty model could come out CRLF and the first keystroke would
mark every line of the file changed. Line endings are now pinned to LF in the registry
rather than left to whichever text the model happened to be created from.

Slice 8 added 223 unit cases (172 functions · 49 frontend · 2 scripts), 2 rules cases and
33 integration cases. Thirty-three of the unit cases are its review's own, written test-first
for the ten findings that review fixed — two of them in files that exist only because of it,
`hl/tokenStore.spec.ts` and `hl/index.spec.ts`. The e2e count does not move: AC-48 extends
Slice 2's existing connect walk in `tests/e2e/highlevel.spec.ts` rather than adding a case,
so pressing **Check data access** is asserted inside the run that connected the account.

**The one thing Slice 8 could not discharge:** the definition of done's manual sandbox check —
one `curl` per surface against the real account, confirming the fixtures recorded on 2026-08-14
still match the live shapes. The unattended sessions had no HighLevel credentials. It is the
item R6 rests on, and it is called out in the PR rather than left in a checklist.

Slice 6 added 447 unit cases (326 functions · 121 frontend), 8 rules cases, 60 integration
cases and 2 e2e cases — twelve of the unit cases are its review's own, written test-first
for the three defects that review found. The scripts suite went 15 → 19 on `main` rather
than in that slice: `99e3f2d` made the emulator port band selectable so two autopilot
checkouts can run the suite at once, and brought four cases with it.

**Both findings Slice 6 handed to Slice 7 are closed.**

- **The scroll cap is on the element that scrolls**, and `EditorPanel.spec.ts` pins the two
  classes to one element. Monaco made the second half of that finding much sharper, and L5
  caught a live instance of it: `EditorPanel`'s `h-full` resolves inside a stretch-sized
  `ResizablePanel` but **not** inside a `TabsContent` sized by `flex-grow`, so in the narrow
  layout the panel fell back to its content height and Monaco — which measures its container
  and has no intrinsic height — rendered a **5 px** editor with no error. Slice 6's textarea
  had hidden the same broken chain behind its own `min-h-40`. The chain is now flex the whole
  way down rather than a percentage of a flex-sized box.
- **`useProjectFiles` is deliberately not extracted** (Slice 7, D22), and the reason is
  recorded rather than deferred by omission: Slice 7 *rewrote* the file half — one buffer
  became a map keyed by path, one selection became a tab list — so extracting it in the same
  PR would have produced a diff in which everything both moved and changed, which is the shape
  a review misses things in. Three of the four new modules (`editorLanguage`, `editorContent`,
  `editorModels`) are pure and live outside the store regardless, so the store lands near where
  it started. **Revisit in Slice 12's audit.**

Slice 5 added 205 unit cases (138 functions · 63 frontend · 4 scripts), 2 rules cases,
34 integration cases and 3 e2e cases. Five of those cases are the review's own, written
test-first for the two behavioural findings it raised — three L1 plus one L4 for `/generate`
writing past the 200-message cap, one L1 for `send()`'s guard not checking `generating`. The
functions count did not move, because deleting `sendHttpError` took three redundant cases
with it.

**Two findings from Slice 5 worth carrying**, both measured rather than assumed:

- **`Connection` must not be set by hand on the SSE response.** It is a hop-by-hop header the
  HTTP layer owns. Slice 0's stub set `Connection: keep-alive` and it was harmless only because
  nothing ever sent a second request over that socket. With it set, the first generation of a
  session succeeded and the **next `POST /generate` on the reused connection came back as an
  empty 400** — the second prompt of every conversation failed in the running app, with nothing
  in the logs. Every single-turn test passed at all five levels. "Two prompts in a row" is now a
  permanent e2e case.
- **The functions emulator does not propagate a client disconnect to the function runtime.**
  Instrumenting `req`/`res` `close` and `aborted` and then aborting a real `fetch` mid-stream
  produces no event until after the turn completes. `res.on('close')` is the right listener on
  Cloud Run (`req` has already ended, because `express.json()` drained it); it simply cannot be
  exercised here, so AC-17 and AC-18 are L1 and the platform half is a Slice 13 hand-check.

Slice 4 added 112 unit cases (14 functions · 98 frontend), 7 rules cases, 43 integration cases
and 3 e2e cases. The previous full run, at Slice 3's ship time, was 636 unit · 19 rules ·
155 integration · 6 e2e. Six of the frontend cases are the review's own — the staleness guard
in `stores/workspace.ts`, written test-first after the build's 742-case run.

Slice 3 added 131 unit cases, 7 rules cases, 69 integration cases and 2 e2e tests. The rules
suite grew for the first time since 2b — `users/{uid}/projects/{projectId}` is a new
collection, and every one of its cases is an `assertFails`, because rules do not cascade into
subcollections and this block is required rather than decorative.

Previously, on `slice/02b-api-data-access` at ship time: typecheck 0 · lint 0 · **476 unit**
(183 functions · 282 frontend · 11 scripts) · **12 rules** · **86 integration** · **4 e2e**.

The rules suite went 19 cases on `main` to 12 — it shrank, deliberately. Slice 2b collapsed
`users/{uid}` to deny-all, so the four `assertSucceeds` cases that asserted a *permitted*
client write have nothing left to permit, and the field-level allowlist cases they anchored
went with them. Every remaining case is an `assertFails`; there is no `assertSucceeds`
import in the file any more, which is the statement `firestore.rules` should now make.
(The `16 rules` figure this line previously carried predated Slice 2.)

**Scope grew in Slice 1 and it was the right call**, but it needs saying out loud: what the
brief specifies as "email + password sign up/sign in" shipped as a non-disclosing
registration endpoint, a blocking email-verification gate enforced in Firestore rules, a
two-key rate limiter, App Check on the registration endpoint, and a daily sweep of
never-verified accounts. That is well above the line the brief draws.

**Every review finding is closed.** AC-53's console controls were confirmed on 2026-08-16 —
email-enumeration protection enabled, and the password policy on *Require enforcement* with
all four composition classes, min 8, max 50, matching the code field for field. Slice 1 is
ready to ship; `05-review.md` carries the evidence.

**Slices 2–13 do not get the same latitude** — the brief's own words are the ceiling from
here, because F7 (the proxy) and F10 (the differentiator) are what this assignment is
actually judged on, and there are four days of clock left.

---

## 1. The working agreement

Every slice runs the same five stages. Each stage is a skill you invoke; each ends with a
**hard stop** so you stay in control.

| # | Stage | Skill | Produces | Who acts next |
|---|---|---|---|---|
| 1 | Discovery + PRD | `/feature-prd <id>` | `02-prd.md` — decisions, acceptance criteria, test matrix · `02-prd.html` — published design companion | You answer questions, then approve scope |
| 2 | Tech plan | `/feature-plan <id>` | `03-plan.md` — file map, ordered TDD tasks | You approve approach |
| 3 | Build | `/feature-build <id>` | Code on `slice/<id>-<slug>`, `04-build-log.md` | — |
| 4 | Review | `/feature-review <id>` | `05-review.md`, fixes applied | — |
| 5 | Ship | `/feature-ship <id>` | Pull request, then **STOP** | You review + merge |

Stage 1 interviews you first and writes the PRD from your answers — the decisions table in
`02-prd.md` is the record that `01-discovery.md` used to be. Doc filenames keep their
original prefixes so slices 0–1 stay readable.

Stage 1 also produces `02-prd.html`, a published design companion that **draws** what the
PRD can only describe: the trust boundary, the flow with its steps numbered, the one
concurrency or ordering hazard the slice exists to get right, and where every failure path
lands. It is not a restyled PRD — the acceptance criteria and the test matrix stay in the
markdown, which remains the contract the build is graded against. Slices 0 and 1 predate it
and do not have one.

After you merge, we start the next slice from `main`. Nothing in stage 3 begins before
stages 1–2 are approved, and nothing merges without you.

### Two speeds

The full five-stage loop is right for slices with real unknowns. For slices where
`PRODUCT_SPEC.md` already answers the questions, run **fast mode** — pass `--fast` to
stage 1 and it skips the interview, writing acceptance criteria straight from the spec. This matters because the clock is five days; ceremony that isn't buying
you clarity is just cost. Recommended mode is marked on each slice below.

### What "vertical" means here

A slice is vertical if you can **demo it to a human when it merges**. Every slice touches
the UI, the API/function layer, the data layer, and its own tests. We never merge a
backend with no screen, or a screen with no backend. The demo line in each slice below is
the thing you actually show.

---

## 2. Test strategy

Test-driven means the failing test exists before the implementation, at whichever level
the acceptance criterion lives. Five levels, used deliberately:

| Level | Tool | What goes here |
|---|---|---|
| **L1 Unit** | Vitest | Pure logic: token expiry math, SSE event parsing, LLM output → file ops, prompt assembly |
| **L2 Component** | Vitest + Vue Test Utils | Forms, panels, empty/loading/error states, streaming accumulation into the editor |
| **L3 Rules** | `@firebase/rules-unit-testing` | Every new Firestore collection: owner can read, non-owner cannot, client cannot read tokens |
| **L4 Integration** | Vitest against Firebase emulators | Cloud Functions end to end, with HighLevel and the LLM stubbed |
| **L5 E2E** | Playwright against emulators | The golden path only — at most one per slice |

Rules of thumb: logic that can be pure, is pure, and gets an L1 test. Anything touching
Firestore gets an L3 test the same day the collection is created. L5 is expensive — one
per slice, covering the demo line, no more.

**Fixtures over live calls.** HighLevel and the LLM are stubbed in all automated tests.
Record real responses once into `tests/fixtures/` and replay them; the sandbox account is
for manual verification and the Loom demo, not for CI.

---

## 3. Definition of done (every slice, no exceptions)

- [ ] Every acceptance criterion in the PRD maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:e2e`
- [ ] New Firestore collections have rules **and** rules tests
- [ ] Error paths from `PRODUCT_SPEC.md` F8 handled for this slice's surface
- [ ] Loading, empty, and error states exist for every new screen
- [ ] No secrets in source; `.env.example` updated if config changed
- [ ] Runs clean on `firebase emulators:start` from a fresh clone
- [ ] README delta written if setup steps changed
- [ ] PR opened with demo evidence; **human approves before merge**

---

## 4. The slices

Fourteen slices. Slice 0 is the only non-user-facing one and exists so that Slice 1 isn't
a 60-file pull request. Dependencies are strict — a slice cannot start before its
dependencies have merged.

Each slice below carries a **Libraries** line naming the exact packages it introduces.
Those names come from the brief (`PRODUCT_SPEC.md` §7) — a slice that substitutes an
equivalent has to record why in its PRD decisions table, not decide it at the keyboard.

### Slice 0 — Rails ✅ merged
**Spec:** F9.4 · **Depends on:** — · **Mode:** fast · **Day 1**

The walking skeleton. Monorepo layout (`/frontend`, `/functions`, `firebase.json`,
`.firebaserc`), Vue 3 + TS + Vite + Tailwind v4 + shadcn-vue, Firebase project with
emulators for auth/firestore/functions, the five test harnesses wired and running, and a
GitHub Actions workflow running typecheck + lint + unit + rules on every PR.

Vertical proof: a `/health` page that calls a Cloud Function that writes and reads one
Firestore doc — with a test at every level, so the harness itself is proven.

**Also settled here, and worth naming because later slices depend on all three:** region
`asia-south1`, the named Firestore database `hl-genesis`, and a `generate` stub that
streams SSE through a Hosting rewrite — which is what retired §8's "does Functions v2
stream in this region" risk before Slice 5 could be blocked by it.

**Libraries:** `vue`, `vue-router`, `pinia`, `tailwindcss` v4, `reka-ui` + `cva` + `clsx` +
`tailwind-merge` (the shadcn-vue substrate), `firebase`, `firebase-admin`,
`firebase-functions` v7, `express`, `cors`, `zod`, plus the L1–L5 harnesses.
**Demo:** open `/health`, see `ok` with a round-trip timestamp.

---

### Slice 1 — Account & session 🔵 in review
**Spec:** F1.1 · **Depends on:** 0 · **Mode:** fast (ran long — see below) · **Day 1**

Email + password sign up, sign in, sign out. Session persists across refresh. Route guards
redirect unauthenticated users. A `users/{uid}` document is created on first sign-in.
Firestore rules deny all cross-user access.

**What actually shipped, beyond the line above.** Discovery turned up an account-enumeration
oracle in the naive flow and the fix cascaded: registration moved server-side to a Cloud
Function (the client SDK leaks `EMAIL_EXISTS` on the wire), every registration returns an
identical response, and email verification became a **blocking gate enforced in Firestore
rules** rather than a client-side courtesy — which is what makes an unverified account
genuinely inert. Around that: a two-key rate limiter (per-email authoritative, per-IP
best-effort), App Check on `/api/auth/*`, scheduled deletion of unverified accounts, and a
`/auth/action` route owning both `verifyEmail` and `resetPassword`. Thirty-one numbered
decisions in `docs/slices/01-account-session/01-discovery.md`; D29, D30 and D31 reverse
earlier ones after the platform was measured.

**Open question — resolved.** Google SSO is **out** (D1). Email + password only; the brief
mandates nothing more, and popup flows are awkward to e2e-test.

**Libraries:** no new mandated packages. `vuefire` was evaluated and **removed** — plain
`firebase` inside Pinia stores. shadcn-vue `alert` and `card` vendored here.
**Key tests:** L3 rules (owner reads own doc, stranger denied, unverified token denied
everything), L2 form validation and error rendering, L5 sign up → verify → dashboard →
refresh → sign out.
**Demo:** create an account, get held at the gate, verify, refresh, sign out.

---

### Slice 2 — HighLevel connection
**Spec:** F1.2, F1.3 · **Depends on:** 1 · **Mode:** full · **Day 1**

The riskiest slice, so it goes early. Connect button → HighLevel authorize URL with a CSRF
`state` → callback Cloud Function → code-for-token exchange → tokens stored server-side
scoped to the Firebase uid → connection status UI showing the location name → disconnect.
Refresh-on-expiry with the ~24h token lifetime from `HIGHLEVEL_PLATFORM.md` §2.

**Libraries:** no new runtime package — the proxy and the token exchange are plain `fetch`.
Add `@gohighlevel/api-client` as a **devDependency for its type definitions only**
(`PRODUCT_SPEC.md` §7.3); its auto-refresh would reintroduce the rotation race.
**Inherited contract from Slice 1 (D26):** every authenticated Cloud Function checks
`email_verified` on the decoded ID token, not merely that a token is present. The OAuth
callback is the first endpoint that would otherwise inherit that gap.
**Key tests:** L1 expiry math and refresh triggering, L4 callback happy path plus denied /
bad-state / exchange-failure paths, L3 client cannot read the token document at all, L5
connect against a stubbed HighLevel.
**Demo:** connect the sandbox account, see the location name appear, disconnect.
**Risk:** high — redirect URL must match exactly (`HL_REDIRECT_URI` and the marketplace app
setting, byte for byte, pointing at the `/api/**` Hosting rewrite), and scope changes force
re-authorization. Run `HIGHLEVEL_PLATFORM.md` §9's checklist before writing code.

---

### Slice 2b — API-only data access
**Spec:** F9.4 (architecture) · **Depends on:** 2 · **Mode:** full · **Day 2**

**An architectural decision taken on 2026-08-17, after Slice 2 merged: the frontend does
not talk to Firestore.** Every read and write goes through a Cloud Function route that
authenticates the caller, parses with Zod, and scopes by uid through the Admin SDK.
Security rules stay and deny clients outright — the backstop that keeps a mistake in a
route a bug rather than a breach.

This slice exists because the decision is retroactive. Slice 1 left `users/{uid}` written
by the client SDK under owner-scoped rules; that path moves behind the API here, so the
codebase carries exactly one data-access pattern before Slice 3 adds a second collection
to it. `hlConnections` was already server-only and is unaffected.

The reusable half matters more than the migration: this slice establishes the route
shape, the auth+Zod boundary helper, and the L3 denial-test pattern that every collection
from Slice 3 on inherits.

**Libraries:** none new — `zod` is already a functions dependency.
**Key tests:** L4 the migrated routes end to end, including a caller reading another
user's document; L3 every collection denies every client operation; L2 the profile
surface against the new client; L1 the boundary helper.
**Demo:** the app behaves exactly as before, with the Firestore client SDK gone from the
bundle — grep `dist/` for `firestore` and find nothing.
**Risk:** medium. The trap is a route that authenticates the caller and then trusts a
`uid` from the request body instead of the token.

---

### Slice 3 — Projects
**Spec:** F2.1, F2.2, F2.3 · **Depends on:** 2b · **Mode:** fast · **Day 2**

Project create, read, update, soft-delete. Dashboard list with empty state. Strict
per-user scoping — **enforced in the API routes**, with rules denying clients outright.

**Libraries:** first slice to need shadcn-vue's **`dialog`** (create/rename/confirm-delete)
— a component the brief names explicitly. Add it with `npx shadcn-vue@latest add dialog`.
**Key tests:** L4 routes per operation including cross-tenant denial, L3 client denial,
L2 list and empty state, L5 create → appears → rename → soft-delete → gone.
**Demo:** create a project, rename it, delete it.

---

### Slice 4 — Workspace shell & chat persistence
**Spec:** F6.1, F6.2, F3.4 (partial) · **Depends on:** 3 · **Mode:** full · **Day 2**

Three-panel workspace (chat | editor | preview) in shadcn-vue, responsive behaviour
decided here. Chat panel with message history, input, and persistence to Firestore. The
assistant is a **stub** that echoes — no LLM yet. This exists so the layout and the
persistence model get reviewed without streaming complexity on top.

**Libraries:** the layout slice, so it carries most of the remaining shadcn-vue surface the
brief names — **`tabs`** and **`badge`** (both named explicitly), plus the layout primitives
**`resizable`**, **`scroll-area`** and **`separator`**. All via the CLI. After this slice the
"inputs, buttons, dialogs, tabs, badges, and layout primitives" list from the brief is
complete except `sheet`, which Slice 11 needs. **A sixth was added and recorded:**
**`textarea`**, for the chat composer — see the slice PRD's D21 and `PRODUCT_SPEC.md` §7.2.
**Key tests:** L2 panel layout and message rendering, L3 messages scoped to project owner,
L5 send a message, reload, history is still there.
**Demo:** open a project, send a message, reload, history persists.

**Built 2026-08-17** on `slice/04-workspace-shell`. Two routes in a new `functions/src/messages/`
module — `GET` and attested `POST /api/projects/:projectId/messages` — a deny-all rules block
with L3 tests, the `createdAt`+`seq` composite index, one `useWorkspaceStore`, a typed client,
`WorkspaceView` with the `lg` layout switch, `ChatPanel`, `MessageComposer`, two labelled
placeholders, `meta.layout` on the app shell, and the dashboard's project name as a link.

The **one hazard worth carrying forward**: a `WriteBatch` resolves every `serverTimestamp()`
in it to the *same* commit timestamp, so both messages of a turn tie on `createdAt` exactly and
Firestore falls through to its random-auto-id tiebreak. `seq` (0 user, 1 assistant) plus a
two-key `orderBy` is the fix, and Slice 5 keeps both: when the assistant write moves to the
stream's `done` handler the timestamps genuinely differ, so `seq` costs nothing and the query
does not change.

**What Slice 5 changed here, as planned** (PRD D6): the assistant write moved to `/generate`'s
terminal handler, the user write stayed in the `POST`, and the response became the user message
alone — kept as a one-element array, so the store's append was untouched. `echoFor()`,
`messagePair()` and the stub badge are gone. The 409 still checks `count + 2`, deliberately: the
reply the `POST` is about to make the user trigger needs room.

---

### Slice 5 — Streaming generation
**Spec:** F3.1, F4.1, F4.2 (token/done/error), F4.3 · **Depends on:** 4 · **Mode:** full · **Day 2–3**

The SSE Cloud Function: prompt in, real LLM call, `token` / `done` / `error` events out,
tokens accumulating live in the chat panel. Disconnect and interruption handling with
partial results preserved. Still no file operations — this slice proves the transport.

**Libraries:** **`@anthropic-ai/sdk`** — the exact package the brief names. Non-negotiable
call shape, from `CLAUDE.md`: model **`claude-opus-5`**, **always** `client.messages.stream()`
(never `messages.create`; request/response is a brief violation, not a style choice),
`max_tokens: 64000`, and the HighLevel cheat-sheet pinned at the front of the system prompt
behind a `cache_control` breakpoint so it is a cache read rather than a re-send on every
generation. `ANTHROPIC_API_KEY` is already declared in `functions/.env.example` and belongs
in Secret Manager (`firebase functions:secrets:set`), with `functions/.secret.local` for
emulator runs. The `generate` endpoint also picks up the ID-token check and the long
timeout the Slice 0 stub deliberately withheld.
**Key tests:** L1 SSE event encoder and client-side parser, L1 accumulator, L4 stream with
a stubbed LLM including mid-stream abort, L5 prompt → tokens visibly appear → done.
**Demo:** type a prompt, watch text stream in token by token.
**Risk:** downgraded. Slice 0's `generate` stub already proved Functions v2 streams
unbuffered from `asia-south1` through a Hosting rewrite, which was §8's open item. What
remains is the SDK's stream shape and the accumulation trap in
`.claude/skills/feature-review/references/typescript-vue.md`.

**Built 2026-08-17** on `slice/05-streaming-generation`. A new `functions/src/llm/` module —
body schema, system prompt with its `cache_control` breakpoint, the transcript → context
builder, the request parameters, the SDK-event mapper, the narrow `LlmStream` port and the
emulator-only fake — plus `POST /generate` rewritten as its own small Express app on its own
function, `truncated` on the message schema, `readTranscript` and `appendAssistantMessage`,
`frontend/src/lib/sse.ts` and `generateApi.ts`, the store's `generating` / `streamingText` /
`generateError` and its `AbortController`, and the chat panel's badge, placeholder, interrupted
marker and Retry.

**Three decisions a later slice revisits**, recorded so they read as planned rather than as
churn:

- **D6 — trailing assistant turns are dropped when the context is assembled.** A trailing
  assistant message *is* a prefill, and prefill is a 400 on `claude-opus-5`. It is exactly what
  Retry after an interruption produces, so untreated the failure lands on the recovery path.
  Slice 6 must keep the drop when file operations join the context.
- **D15 — `output_config: { effort: 'low' }`.** This slice generates prose. **Slice 9 owns
  generation quality** and re-tunes effort against real HighLevel prompts, where `high` or
  `xhigh` is the documented starting point.
- **D16 — the `cache_control` breakpoint is declared and is a no-op until Slice 9.**
  `claude-opus-5`'s minimum cacheable prefix is 512 tokens and this slice's system prompt is far
  shorter, so `cache_creation_input_tokens` and `cache_read_input_tokens` both read `0` and
  nothing errors. The `generation.complete` log line is where that becomes a real cache read once
  the cheat-sheet is added above the breakpoint.

**Deferred to Slice 13's checklist:** the README gains an `ANTHROPIC_API_KEY` setup step —
Secret Manager for a deploy, `functions/.secret.local` (created automatically by
`scripts/ensure-secret-local.mjs`) for emulator runs. And R2's hand-check, that a real
generation survives the Hosting rewrite end to end, together with the client-disconnect path the
emulator cannot deliver.

---

### Slice 6 — File operations
**Spec:** F3.3, F5.1, F4.2 (file boundaries) · **Depends on:** 5 · **Mode:** full · **Day 3**

Parse the LLM's final output into validated file operations, reject or repair malformed
output without corrupting project state, persist files to Firestore, render a file tree,
read a file, save a manual edit. Plain textarea for now — Monaco is the next slice.

**Libraries:** `zod` only. The brief's "validated file operations" is a Zod schema at the
boundary — parse, don't validate — and the parse failure is what F8.1's user-facing error
is built from.
**Key tests:** L1 parser against a fixture corpus including malformed cases, L1 validation
rejects path traversal and oversized files, L3 file rules, L5 generate → tree populates →
edit → save → reload.
**Demo:** generate, see files appear in the tree, edit one, reload, edit persisted.

✅ **Shipped.** The reply is split into files **as it streams**, by a line-oriented state
machine between the stream mapper and the SSE framing — so `file_start` / `file_chunk` /
`file_end` are live boundaries rather than a second parse at the end. The wire format is a
`<genesis:file path="…">` tag pair on its own line (D2); the op set is validated as **one set,
refused whole** (D9), and a turn's message and every file it wrote commit in a single
`WriteBatch` (D11). Three routes expose the collection, none naming a user. The editor is
read-only while a stream is open (D21), which closes the only collision that actually happens.

Two things the build learned that the plan had not:

- **The chunking-invariance property found a real bug** (T7). Once a partial line has been
  emitted, the rest of it arrives in a later push and is *not* at a line start — so
  `x</genesis:file>` closed a block when the two halves arrived in separate deltas and did not
  when they arrived together. All 65 hand-written cases passed, because a hand-written test
  chunks on whole tags.
- **A whole path segment of `..` never reaches the file handler.** URL normalisation collapses
  `/files/..` and `/files/%2E%2E` before routing, so the request resolves one segment up.
  Measured, not assumed; the case asserts the negative that matters rather than the 400 the
  plan expected.

---

### Slice 7 — Monaco editor ✅
**Spec:** F6.3 · **Depends on:** 6 · **Mode:** fast · **Day 3** · **Built 2026-08-18**

Swapped the textarea for `@guolao/vue-monaco-editor`. Tabbed editing, clickable file tree,
tokens appear live in the editor during generation, read-only while streaming.

**Libraries:** **`@guolao/vue-monaco-editor`** ^1.6.0 — the exact package the brief names —
with `monaco-editor` **pinned to `0.52.2`**, not caretted: 0.55 added an `exports` map and
0.56 restructured the ESM tree, so the deep path the wrapper's own `.d.ts` imports stops
resolving, which is a typecheck failure inside a package the brief requires. Monaco is
bundled locally and handed to the loader (`loader.config({ monaco })`), so nothing is
fetched from a CDN and the app runs from a fresh clone with the network unplugged.

**What was decided rather than merely built.** Streamed chunks reach the document as
`applyEdits` **appends**, never `setValue` — the naive version passes every test below L5
while snapping the viewport to line 1 on each chunk and re-tokenizing the whole file, so
the rule is a pure module with its own tests. Models are **ours**, keyed
`inmemory://genesis/<projectId>/<path>`, because the wrapper keys them in monaco's *global*
registry and two projects would share one `index.html` with one undo stack. No language
services (`edcore.main` plus four `basic-languages` contributions), because they put red
squiggles on LLM-generated code. The editor instance lives in a `shallowRef` — the trap
`.claude/skills/feature-review/references/typescript-vue.md` names — and AC-28 asserts
identity rather than commenting on it.

**Tests:** 97 frontend unit cases and 2 e2e. Monaco itself never runs below L5 (jsdom has
no layout and no canvas metrics), so everything decidable was pushed into pure modules with
a hand-written fake monaco, and L5 was left proving what genuinely needs a browser —
colouring, layout, and `readOnly` actually refusing a keystroke. It earned its keep: it
caught the narrow-layout collapse described in §0.
**Demo:** code streams coloured into a locked editor; a second tab; an unsaved edit
surviving a tab switch; Save; a reload.

---

### Slice 8 — HighLevel API proxy
**Spec:** F7.1, F7.2, F8.3 (the HighLevel half), F1.3 (token refresh, completing Slice 2's
deferral) · **Depends on:** 2 · **Mode:** full · **Day 3–4**

The authenticated proxy generated apps call. Attaches and refreshes the user's token
server-side, allowlists routes across Contacts, Conversations, and Calendars, maps
HighLevel errors to clear client errors (401 → prompt to reconnect).

**Libraries:** none — a hand-written `fetch` wrapper, deliberately. The route allowlist is
one table with three consumers (the proxy, the system prompt in Slice 9, and the README),
per `HIGHLEVEL_PLATFORM.md` §8. Token refresh must be the Firestore transaction from
`HIGHLEVEL_PLATFORM.md` §3 — rotation-on-use means two parallel preview fetches hitting an
expired token will both try to refresh, and the loser bricks the connection.
**Key tests:** L4 one test per API surface with recorded fixtures, unauthenticated request
rejected, expired-token refresh path, error mapping, L1 route allowlist rejects anything
not on it.
**Demo:** curl the proxy with a signed-in session, get real sandbox contacts back.
**Risk:** high — this is where a mistake leaks another tenant's data. Rules and auth checks
get adversarial tests.

**Built 2026-08-18** on `slice/08-highlevel-proxy`. A new `functions/src/hl/` half — `routes.ts`
(the thirteen-row allowlist as exported *data*, a specificity-ordered matcher, and upstream URL
and body assembly), `proxyError.ts` (the pure upstream-condition → `{ status, code, detail }`
mapper), `tokenStore.ts` (the Firestore `TokenDeps` adapter Slice 2 deferred: the fast-path read
and the transactional rotation) and `proxy.ts` (`handleProxy`, the four-header upstream call, the
20-second abort, the 5 MiB cap and the `hl.proxy` log line) — mounted as
`<METHOD> /api/hl/proxy/**` behind `requireAppCheck` and `withVerifiedUser`. Around it:
`resolveConnection` and the `needsReconnect` short-circuit in `token.ts`, `detail` on `HttpError`,
`ProxyLogContext` in `lib/log.ts`, the `X-RateLimit-*` set on the CORS `exposedHeaders` list, the
fake's three replayed surfaces with their failure markers — and on the frontend `hlProxyApi.ts`,
the store's `checkDataAccess()` probe, and the connection panel's **Data access** section.

**Three properties worth carrying forward**, because each is a place a later change would quietly
undo the slice:

- **The upstream URL is assembled from the matched row's own `pattern`** (D6), with
  `[A-Za-z0-9_-]{1,64}` parameters substituted into it — never by appending the caller's path. That
  is what makes `..`, `%2F` and an absolute URL unrepresentable rather than filtered.
- **`locationId` is a reserved key** (P1). It is removed from the query string and from the top
  level of the JSON body on *every* row, then re-added from the connection exactly where the row's
  `locationIn` says. A caller-supplied location therefore never reaches HighLevel on any route.
- **On `invalid_grant` the refresh transaction must commit** (P8). The refusal is a sentinel
  returned from the transaction body and thrown after it resolves; throwing from inside discards
  `needsReconnect: true` with everything else, and the failure then reads like a Firestore bug.

**Constraints two later slices inherit:** Slice 9 imports `HL_ROUTES` rather than restating it (D2)
and owns the N+1 instruction the rate-limit ceiling actually needs (D34); Slice 10 must satisfy both
App Check and the `srcdoc` iframe's opaque origin, and D16 records the recommended shape — a
parent-side `postMessage` bridge, so no credential crosses into the sandbox (R8).

**Deferred to Slice 13's checklist:** the README gains the allowlist as a section of its own — one
table, three consumers — and `HL_ALLOW_MESSAGE_SEND` as a deployment note saying why it is off in
every environment, including the tests.

---

### Slice 9 — HighLevel knowledge injection
**Spec:** F3.2 · **Depends on:** 8, 6 · **Mode:** full · **Day 4**

The key differentiator. A curated endpoint cheat-sheet plus the proxy calling convention
in the system prompt, with bounded context assembly (project files + chat history within a
token budget), so generated code calls **real** HighLevel endpoints.

**Key tests:** L1 prompt assembly and context-budget truncation, L1 golden-prompt fixtures
asserting generated code targets proxy routes rather than inventing URLs.
**Demo:** "build a contact dashboard" produces code that calls the Contacts route.

---

### Slice 10 — Live preview
**Spec:** F6.4, F8.3 · **Depends on:** 9 · **Mode:** full · **Day 4**

Sandboxed iframe (`srcdoc`) with a runtime shim injecting the proxy base URL and session
auth. Refreshes after generation completes. HighLevel failures surface visibly in the
preview rather than failing silently.

**Libraries:** none. The brief offers "Sandpack, WebContainers, or srcdoc" and we take
`srcdoc` — no in-browser bundler, and full control of the shim that injects the proxy base
URL and the session credential. Record the choice in the README's architecture bullets.
**The open problem this slice must solve:** a `srcdoc` iframe has an **opaque origin**, so
it cannot read our cookies or Firebase session and its `fetch` to the proxy is
cross-origin-ish by default. Decide the credential-passing mechanism in discovery
(`postMessage` handshake vs. a short-lived scoped token baked into the shim) — this is one
of the two hardest unknowns in the build and it is *not* a HighLevel problem.
**Key tests:** L2 shim injection and sandbox attributes, L4 preview fetches proxied data,
L5 the full golden path ending in real data on screen.
**Demo:** the money shot — generated dashboard rendering real sandbox contacts.

---

### Slice 11 — Snapshots & restore
**Spec:** F5.2, F5.3, F6.6 · **Depends on:** 6 · **Mode:** fast · **Day 4–5**

Snapshot every project file on each generation, list snapshots by timestamp in a shadcn
Sheet, restore any previous one.

**Libraries:** shadcn-vue **`sheet`** — the brief says "a ShadCN sheet or dialog", and a
sheet reads better against a three-panel workspace than a modal that covers it.
**Key tests:** L1 snapshot diffing, L4 restore round-trip fidelity, L3 rules, L5 generate
twice → restore first → files match.
**Demo:** generate, generate again, restore version one.

**Built 2026-08-18** on `slice/11-snapshots-restore`. A new `functions/src/snapshots/` half —
`plan.ts` (the pure boundary: the resulting-set merge, the `seq` allocation, the prune selection
and the set-equality check), `schema.ts` (the stored shapes, `SNAPSHOT_LIMIT = 20`, and Slice 6's
`id === path` invariant one collection deeper), `handlers.ts` (`stageSnapshot` plus the two route
handlers) and `index.ts` (the router, mounted after `filesRouter`) — around it `readFilePaths`
becoming `readStoredFiles` in `files/`, an `AssistantTurn` object replacing
`appendAssistantMessage`'s positional parameters, and two deny-all rules blocks. On the frontend:
the vendored `sheet`, `snapshotsApi.ts`, the store's list and `restoreSnapshot()`, and a
**History** sheet opened from the code panel header. No new index, no change to the SSE protocol,
no change to the prompt.

**Five properties worth carrying forward**, each one a place a later change would quietly undo the
slice:

- **A snapshot is the project's whole file set, not the turn's writes** (D1). A generation that
  rewrites `app.js` alone leaves `index.html` untouched, so a copy of the turn's writes is a copy
  of *part* of an app — and restoring it would produce exactly the half-restored, silently-broken
  state Slice 6's D9 refuses on the write path.
- **The files hang off the snapshot in a subcollection, id = path** (D3), by arithmetic rather
  than taste: `FILE_LIMIT` × `FILE_BYTES_MAX` is 2,000,000 bytes against Firestore's
  1,048,576-byte document limit, so an inline `Record<path, content>` fails on precisely the
  largest, most valuable projects.
- **The snapshot commits on the turn's own `WriteBatch`** (D4) — message, file writes, snapshot,
  its file documents and any prune staged once and committed once, worst case 63 writes. Two
  commits would leave a crash window in which the tree has moved on and the history has not, which
  is the state a user opens the sheet to escape.
- **Restore makes the file set *equal* the version's**, deleting every file that version does not
  hold (D7). It is the only operation in the product that deletes a file document, and it is what
  Slice 6's D18 kept generations non-destructive *for*. It snapshots the current state first (D9),
  refuses whole on an unreadable copy (409 `snapshot_unreadable`, D8), and writes nothing at all
  when the project already **is** that version (D10) — without that check, a double-click would
  fill a twenty-row history with copies of one moment and prune the versions that mattered.
- **Rules do not cascade, so `…/snapshots/{snapshotId}/files/{fileId}` needs its own deny-all
  block** (D15) — the easy miss, and the one holding the actual generated code: a client that
  could write there could plant its own JavaScript and have a later restore hand it to Slice 10's
  preview.

**The fixture is load-bearing, not convenience** (D24). The LLM fake replays one reply, so two
generations produce byte-identical files and a restore that did nothing at all would pass every
level. `__alt_files` → `reply-alt.json` rewrites one file and adds a fourth, which is what makes
both halves of D7 — content restored, later file deleted — assertable at L4 and visible at L5.
`reply.json` is untouched, so nothing that already passed moved.

---

### Slice 12 — Error handling & state hardening
**Spec:** F8.1, F8.2, F8.3 · **Depends on:** 10, 11 · **Mode:** fast · **Day 5**

A cross-cutting audit rather than new features. Every screen gets loading, empty, and
error states; every failure mode from F8 gets a user-facing message and a test. Malformed
LLM output, interrupted streams, expired connections.

**Libraries:** shadcn-vue **`skeleton`** (loading) and **`sonner`** (transient errors) —
the last two primitives, and only if the audit shows the screens actually need them. Do not
add components speculatively.
**Demo:** deliberately break each dependency, show the app degrades legibly.

---

### Slice 13 — Deliverables
**Spec:** F9.1–F9.5 · **Depends on:** 12 · **Mode:** fast · **Day 5**

Deploy frontend and functions, register the deployed callback URL, write the root README,
the sandbox seed script (`scripts/seed-sandbox.ts`, ~20 contacts and 5–10 appointments),
and the Loom script.

**This slice is graded on a literal checklist, so it gets one.** Every line below is a
sentence from the brief's Deliverables section:

- [ ] Public GitHub repository — `/functions`, `/frontend`, `firebase.json`, `.firebaserc` at root ✅ *(layout already conforms)*
- [ ] **`.env.example` at the repo root.** We currently ship `frontend/.env.example` and
      `functions/.env.example`, which are better documentation but are *not* what the brief's
      layout lists. Add a root `.env.example` that carries every variable and points at the
      two — cheap, and it removes a "where is it?" moment for the reviewer.
- [ ] README — **Live URLs** (Hosting frontend + Functions base URL)
- [ ] README — **HighLevel setup**: marketplace app config, OAuth redirect URI, sandbox account
- [ ] README — **Local setup with `firebase emulators:start`**, verified from a fresh clone.
      See `PRODUCT_SPEC.md` §5: `npm run dev` points at real Firebase, so the emulator path
      (`npm run emulators` + `npm run dev:emulator`) has to be written down and actually walked,
      not assumed. The README today claims `npm run dev` starts emulators — it does not. Fix it.
- [ ] README — **architecture decisions, ≤10 bullets.** Strong candidates: srcdoc + shim over
      Sandpack · Firestore-for-files making snapshots trivial · the proxy as confused-deputy
      fix · transactional token refresh against rotation-on-use · date-pinned HL API versions
      with v3 as a known follow-up · rules-as-enforcement (the unverified-account gate) ·
      one `api` function over many · cheat-sheet in a `cache_control` block over tool-calling
- [ ] README — **what you'd improve, ≤5 bullets**
- [ ] README — **deployment notes**: Firebase project setup, CI, manual steps
- [ ] Secrets in Secret Manager only; verify nothing is a plain env var on the Cloud Run service
- [ ] **Loom ≤5 min** walking the exact path the brief scripts: sign up → connect HighLevel →
      create project → prompt → watch the stream → real HL data in preview → edit a file →
      restore a snapshot → one architecture decision. Link it in the README *and* the email.

**Demo:** the Loom video itself.

---

### Stretch slices (only if the clock allows)

| Slice | Spec | Why it's worth it |
|---|---|---|
| S1 — Iterative refinement | F10.1 | Highest value per hour; mostly prompt and context work |
| S2 — Generation cancellation | F10.2 | Small, and it makes the demo feel finished |
| S3 — Diff view per generation | F10.3 | Visually impressive, moderate cost |
| S4 — Rate limiting | F10.4 | Cheap, reads as production-minded |

---

## 5. Day map

**Original plan:**

| Day | Slices | The bet |
|---|---|---|
| 1 | 0, 1, 2 | Rails plus the riskiest integration first — if OAuth is going to hurt, find out now |
| 2 | 3, 4, 5 | Data model and the streaming transport proven |
| 3 | 6, 7, 8 | Generation produces real files; the proxy is live |
| 4 | 9, 10, 11 | The differentiator and the money shot |
| 5 | 12, 13 | Harden, deploy, document, record |

**Reality, as of 2026-08-16.** Day 1 delivered 0 and 1; Slice 2 did not start, because
Slice 1's enumeration work consumed the day. One slice behind, with a day's worth of
buffer already spent. The recovered plan:

| Day | Slices | Note |
|---|---|---|
| 2 (today) | **2, 3, 4** | Slice 2 first, and early — it is still the riskiest thing in the build and it has now been deferred once |
| 3 | 5, 6, 7 | Streaming, file ops, Monaco |
| 4 | 8, 9, 10 | Proxy → knowledge injection → preview. **This is the chain the assignment is actually judged on** |
| 5 | 11, 12, 13 | Snapshots, hardening, deploy, README, Loom |

**Cut order if you fall behind again — decide by this list, not in the moment:**

1. Stretch slices S1–S4 (all of them, no debate)
2. Slice 7 — the textarea ships instead of Monaco. *Costs a named brief requirement, so
   this is the first genuinely painful cut; take it before anything below.*
3. Slice 11 (snapshots) down to snapshot-and-list without restore
4. Slice 12 down to the error states the golden path actually crosses

**Never cut:** Slice 8's tests (a mistake there leaks another tenant's data), Slice 9 (the
differentiator — "generates apps that talk to HighLevel" is the whole assignment), or the
Loom. A working demo with a textarea beats a Monaco editor with no preview.

**The clock is the real constraint now.** Slice 1's decision log is excellent work and
also the reason we are behind. Slices 2–13 ship the brief's line, not a hardened version
of it.

---

## 6. Conventions

**Branches:** `slice/<nn>-<slug>` — e.g. `slice/02-highlevel-connection`
**Commits:** imperative, one per green TDD cycle — `test: contact token refresh triggers at expiry`, then `feat: refresh HighLevel token before expiry`
**PR title:** `Slice NN — Name`
**PR body:** what changed, acceptance criteria with test names, how to verify locally, demo evidence, anything deliberately deferred
**Docs:** `docs/slices/<nn>-<slug>/` holds the five stage documents for that slice

---

## 7. Repo setup — as built

The repository exists and CI runs. `main` carries Slice 0; `slice/01-account-session` is
open and awaiting merge.

| | |
|---|---|
| Remote | `origin` — public GitHub repository, one branch per slice |
| CI | GitHub Actions: typecheck · lint · unit · rules · integration · e2e on every PR |
| Firestore | named database `hl-genesis`, rules in `firestore.rules` |
| Functions region | `asia-south1` — pinned in `setGlobalOptions()` and both Hosting rewrites |
| Local secrets | `frontend/.env`, `functions/.env`, `functions/.secret.local` — all gitignored |
| Deployed secrets | Secret Manager (`firebase functions:secrets:set`), never plain env vars |

`scripts/bootstrap-github.sh` did its job and is now historical; leave it or delete it in
Slice 13's cleanup.

**Running it:**

```bash
npm run install:all      # root + frontend + functions
npm run dev              # emulators + SPA against them, in ONE command — the local path
npm run dev:cloud        # SPA against REAL Firebase, for checking a deploy
npm run emulators        # the emulators alone, without a SPA
npm test                 # typecheck + lint + unit + rules + integration
```

`npm run dev` is emulator-backed **as of Slice 2**, reversing the Slice 0–1 arrangement where
it pointed at real Firebase. The reason is in `PRODUCT_SPEC.md` §5: with the old default, an
endpoint that existed only on a branch answered 404 on the developer's own machine, because
the SPA proxied `/api` to the deployed functions. Nothing could be tried before it shipped.

It starts auth, firestore and functions, imports and re-exports `.emulator-data` so a local
account survives a restart, and wires a stubbed HighLevel so the whole OAuth loop runs
offline. Slice 13 still owes the README a walked-through version of this, because the brief
names `firebase emulators:start` explicitly.

---

## 8. Open decisions

`PRODUCT_SPEC.md` §6 lists these; this table is where their state is tracked. Anything
still open gets settled in the discovery interview of the slice that first needs it, not before.

| Decision | Needed by | State |
|---|---|---|
| Client-direct Firestore vs API-only data access | Slice 2b | ✅ **Settled: API-only** (2026-08-17). The frontend uses no Firestore client SDK; every read and write goes through a Cloud Function route that authenticates, parses with Zod, and scopes by uid. Rules deny clients outright and are proven by L3 denial tests. Retroactive — Slice 2b migrates `users/{uid}`. Costs `onSnapshot`: liveness is refetch-after-mutation, or an existing SSE stream |
| SSE transport on Functions v2 | Slice 5 | ✅ **Settled in Slice 0.** Streams unbuffered from `asia-south1` through the Hosting rewrite; no chunked-fetch fallback needed |
| LLM provider | Slice 5 | ✅ **Settled.** `@anthropic-ai/sdk`, `claude-opus-5`, `messages.stream()`, `max_tokens: 64000`, cheat-sheet behind `cache_control` |
| Google SSO alongside email + password | Slice 1 | ✅ **Settled: out** (Slice 1, D1). Not required by the brief |
| Preview runtime: `srcdoc` vs Sandpack | Slice 10 | ✅ **Settled: `srcdoc` + shim.** The *credential-passing mechanism* into an opaque-origin iframe is still open — decide it in Slice 10 discovery |
| File storage: Firestore vs Cloud Storage | Slice 6 | ✅ **Settled: Firestore.** Snapshots and restore stay trivial; the brief also says snapshots live in Firestore |
| Generated app format: single-file vs multi-file | Slice 6 | ✅ **Settled: multi-file plain HTML/JS/CSS**, flat, `index.html` the entry point (Slice 6 D1). Extensions allowlisted, no directories, 20 files and 100 KB each. See `docs/slices/06-file-operations/02-prd.md` |
| File-op wire format from the LLM | Slice 6 | ✅ **Settled: a `<genesis:file path="…">` tag pair, each tag alone on its line** (Slice 6 D2) — *not* fenced blocks, which the model emits inside generated markdown and which have no unambiguous close. Split as it streams so F4.2's boundaries are live; the resulting op set is parsed by Zod and refused whole (D9) |
| HL knowledge: cheat-sheet vs tool-calling | Slice 9 | ✅ **Settled: cheat-sheet** (Slice 9, D1). Rendered at module load from `HL_ROUTES` — one table, three consumers — into the system prompt's stable prefix, behind the `cache_control` breakpoint. Tool-calling would have the model *call* HighLevel during generation; what the artefact needs is code that calls HighLevel *later*, from a browser. See `docs/slices/09-highlevel-knowledge/02-prd.md` |
| HL API version: date-pinned vs `v3` | Slice 2 | ✅ **Settled: date-pinned** (`2021-07-28` / `2021-04-15`). v3 migration is a named README follow-up |

---

## 9. Brief conformance ledger

One row per requirement the assignment states, so nothing is graded on a line we never
read. `PRODUCT_SPEC.md` §7 holds the package-level version of this.

| Brief requirement | Spec | Slice | State |
|---|---|---|---|
| Email + password auth, session persists | F1.1 | 1 | ✅ shipped (plus a verification gate) |
| HighLevel OAuth 2.0, full flow via Cloud Function callback | F1.2 | 2 | ✅ shipped in 2 — authorize URL with a CSRF `state`, `GET /api/oauth/callback`, code-for-token, tokens written server-side and never returned to the browser |
| Tokens in Firestore scoped to the Firebase user, refresh on expiry | F1.3 | 2, 8 | ✅ storage and the skew arithmetic in 2; **8 supplies the effect behind them** — the Firestore `TokenDeps` adapter, the proactive five-minute refresh and the rotation inside a `runTransaction` with a re-read short-circuit |
| One HighLevel location per user | F1.3 | 2 | ✅ — falls out of Target User = Sub-account; the proxy injects that one location on every call (8, D10) |
| Project CRUD incl. soft-delete, scoped per user by the API | F2.1–2.3 | 3 | ✅ |
| Server-side generation: bounded context → stream → validated file ops → persist | F3.1–3.4 | 5, 6, 9 | 🟡 all four shipped — context, stream and persist in 5; **validated file ops in 6**, parsed as they stream and refused as one set. Only the HighLevel knowledge in the context is owed, in 9 |
| SSE endpoint; protocol covers tokens, file boundaries, completion, errors | F4.1–4.3 | 5, 6 | ✅ `POST /generate` — `token`, `file_start`, `file_chunk`, `file_end`, `done` and `error` frames, both error channels, keep-alives |
| File tree, read file, save manual edits | F5.1 | 6, 7 | ✅ shipped — three routes (list without content, read one, `PUT` an edit), a tree that fills in as the reply streams, and Monaco over it since 7 |
| Snapshot per generation; list and restore | F5.2–5.3 | 11 | ✅ shipped — every turn that stores files also stores a copy of the project's **whole** file set, on the turn's own batch and in its one commit; twenty kept per project, the twenty-first pruning the oldest *and its file documents*. `GET /api/projects/:projectId/snapshots` lists them newest-first by a stored `seq` (so pruning cannot renumber a version out from under the user), and `POST …/snapshots/:snapshotId/restore` makes the file set equal that version exactly — deleting what the version does not hold — after snapshotting what was there, so the one destructive operation in the product is itself undoable. Neither path names a user |
| shadcn-vue as the primary component library | F6.1 | 0–12 | 🟡 `button`/`input`/`label`/`card`/`alert`/`dialog`/`tabs`/`badge`/`resizable`/`scroll-area`/`separator`/`textarea`/`sheet` in — `sheet` vendored by the CLI in 11, like every other one, so its provenance stays diffable; only `skeleton`/`sonner` (12) owed |
| Three-panel workspace: chat · editor · preview | F6.1 | 4, 6, 7 | 🟡 shell shipped — resizable at ≥1024px, tabbed below; the code panel is a real screen since 6 and Monaco since 7. Only the preview is still a labelled placeholder, until 10 |
| Chat panel with history and input | F6.2 | 4, 5 | ✅ history, input and persistence in 4; the echo and its badge deleted in 5, replaced by a real streamed reply, a `Generating…` status, an interrupted marker and a Retry |
| Monaco via `@guolao/vue-monaco-editor`, tabs, live tokens, read-only while streaming | F6.3 | 7 | ✅ shipped — the named package with `monaco-editor` pinned `0.52.2` and bundled locally (no CDN); a hand-rolled tab strip over one buffer per path, so an unsaved edit survives a tab switch; chunks applied as **append edits** with the view following the tail; `readOnly` with a message for the length of a stream |
| iframe preview showing **real** HL data, refreshes after generation | F6.4 | 10 | ⏭ — the money shot |
| SSE client handles all event types, survives disconnects | F6.5 | 5 | 🟡 all three event types handled and chunk-split-safe by construction (the parser is driven split at every offset); the client's own abort is proven, and the **server**-side disconnect is L1-proven but undeliverable from the emulator — a Slice 13 hand-check |
| Snapshot history in a sheet/dialog with Restore | F6.6 | 11 | ✅ shipped — a shadcn-vue `sheet`, opened by **History** in the code panel header because versions are versions *of the files*; rows newest-first with their version number, origin (*Generation* / *Before restore*), file count, size and time. **Restore** confirms **inline in the row** rather than in a second overlay over a sheet, is disabled for the length of a stream — in the component *and* in the store, because a keyboard path does not go through the button — and open tabs reconcile behind it: re-read, or closed outright when the restore deleted the file |
| Contacts · Conversations · Calendars exposed to generated apps | F7.1 | 8 | ✅ thirteen allowlisted rows over `<METHOD> /api/hl/proxy/**` — contacts search/get/create/update, conversations search/get/messages/send, calendars list/get/events/appointment/free-slots. `POST /conversations/messages` ships **disabled** behind `HL_ALLOW_MESSAGE_SEND` (D5): it sends a real message. The table is data, so 9 renders it and 13 documents it from the same rows |
| Authenticated proxy attaching/refreshing tokens server-side | F7.2 | 8 | ✅ ID token + `email_verified` + App Check on the caller's side; on HighLevel's side our `Authorization`, the row's `Version`, `Accept` and nothing of the caller's — the token is attached and rotated server-side and the browser never sees one |
| Sandbox HL account | F7.3 | 2, 13 | ⏭ — create it before Slice 2, seed it before the Loom |
| Malformed LLM output handled without corrupting state | F8.1 | 6, 12 | 🟡 shipped in 6 — a bad path, a duplicate, an oversized file, an over-cap set and an unterminated block each refuse the **whole** turn's files, name the reason on screen, and leave the stored tree byte-identical. The message still commits. Slice 12 covers the rest of F8 |
| Interrupted streams: partial results preserved | F8.2 | 5, 12 | 🟡 a partial is persisted with `truncated: true` on every interruption the emulator can reach — a mid-stream upstream failure — and marked in the transcript, with a Retry beside it; the client-disconnect trigger is the Slice 13 hand-check above |
| Failed HL calls surfaced clearly | F8.3 | 8, 10, 12 | 🟡 the proxy half shipped in 8 — every upstream condition maps to its own status and `code` in the existing envelope, carrying HighLevel's own message as `detail` (never a 401, which would sign the user out of Genesis), and a dead connection reaches a **Reconnect HighLevel** button in the dashboard's Data access section; **surfacing a failure inside the preview is Slice 10** |
| Hosting + Functions deployed, live URLs in README | F9.1 | 13 | ⏭ |
| Secrets via env/Secret Manager, `.env.example` | F9.2 | 13 | 🟡 per-package examples exist; **root `.env.example` owed** |
| Deployed callback registered as the HL redirect URI | F9.3 | 2, 13 | ⏭ |
| Repo layout + README (setup, ≤10 decisions, ≤5 improvements, deploy notes) | F9.4 | 13 | 🟡 layout ✅, README sections owed |
| Loom ≤5 min walking the golden path | F9.5 | 13 | ⏭ |
| Emulators: `firebase emulators:start` documented and working | NFR | 13 | 🟡 emulators back the test suites; the documented dev path is owed |
| Streaming mandatory — never request/response | NFR | 5 | ✅ `messages.stream()` only, and a source scan over `functions/src` asserts `messages.create` appears in no file |
