# Genesis — Implementation Plan

**How we build this: one vertical slice at a time, test-first, with a human gate before every merge.**

This document is the spine of the project. It defines (1) the workflow we run for every
feature, (2) the slices the work is cut into, and (3) the rules that decide when a slice
is done. Source of truth for *what* we build is `PRODUCT_SPEC.md`; source of truth for
*how HighLevel works* is `HIGHLEVEL_PLATFORM.md`.

---

## 1. The working agreement

Every slice runs the same six stages. Each stage is a skill you invoke; each ends with a
**hard stop** so you stay in control.

| # | Stage | Skill | Produces | Who acts next |
|---|---|---|---|---|
| 1 | Discovery | `/feature-discovery <id>` | `docs/slices/<id>/01-discovery.md` | You answer questions |
| 2 | PRD | `/feature-prd <id>` | `02-prd.md` — acceptance criteria, test matrix | You approve scope |
| 3 | Tech plan | `/feature-plan <id>` | `03-plan.md` — file map, ordered TDD tasks | You approve approach |
| 4 | Build | `/feature-build <id>` | Code on `slice/<id>-<slug>`, `04-build-log.md` | — |
| 5 | Review | `/feature-review <id>` | `05-review.md`, fixes applied | — |
| 6 | Ship | `/feature-ship <id>` | Pull request, then **STOP** | You review + merge |

After you merge, we start the next slice from `main`. Nothing in stage 4 begins before
stages 1–3 are approved, and nothing merges without you.

### Two speeds

The full six-stage loop is right for slices with real unknowns. For slices where
`PRODUCT_SPEC.md` already answers the questions, run **fast mode** — pass `--fast` to
stage 1 and it collapses discovery and PRD into a single short doc with acceptance
criteria only. This matters because the clock is five days; ceremony that isn't buying
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

### Slice 0 — Rails
**Spec:** F9.4 · **Depends on:** — · **Mode:** fast · **Day 1**

The walking skeleton. Monorepo layout (`/frontend`, `/functions`, `firebase.json`,
`.firebaserc`), Vue 3 + TS + Vite + Tailwind + shadcn-vue, Firebase project with emulators
for auth/firestore/functions/hosting, the five test harnesses wired and running, and a
GitHub Actions workflow running typecheck + lint + unit + rules on every PR.

Vertical proof: a `/health` page that calls a `ping` Cloud Function that writes and reads
one Firestore doc — with a test at every level, so the harness itself is proven.

**Demo:** `firebase emulators:start`, open `/health`, see `ok` with a round-trip timestamp.
**Risk:** low, but do not skip the CI wiring — it is what keeps every later slice honest.

---

### Slice 1 — Account & session
**Spec:** F1.1 · **Depends on:** 0 · **Mode:** fast · **Day 1**

Email + password sign up, sign in, sign out. Session persists across refresh. Route guards
redirect unauthenticated users. A `users/{uid}` document is created on first sign-in.
Firestore rules deny all cross-user access.

**Open question for discovery:** Google SSO is roughly an hour on top of this with Firebase
Auth and it demos well — in or out?

**Key tests:** L3 rules (owner reads own doc, stranger gets denied), L2 form validation and
error rendering, L5 sign up → dashboard → refresh → still signed in → sign out.
**Demo:** create an account, refresh, sign out.

---

### Slice 2 — HighLevel connection
**Spec:** F1.2, F1.3 · **Depends on:** 1 · **Mode:** full · **Day 1**

The riskiest slice, so it goes early. Connect button → HighLevel authorize URL with a CSRF
`state` → callback Cloud Function → code-for-token exchange → tokens stored server-side
scoped to the Firebase uid → connection status UI showing the location name → disconnect.
Refresh-on-expiry with the ~24h token lifetime from `HIGHLEVEL_PLATFORM.md` §2.

**Key tests:** L1 expiry math and refresh triggering, L4 callback happy path plus denied /
bad-state / exchange-failure paths, L3 client cannot read the token document at all, L5
connect against a stubbed HighLevel.
**Demo:** connect the sandbox account, see the location name appear, disconnect.
**Risk:** high — redirect URL must match exactly, and scope changes force re-authorization.

---

### Slice 3 — Projects
**Spec:** F2.1, F2.2, F2.3 · **Depends on:** 1 · **Mode:** fast · **Day 2**

Project create, read, update, soft-delete. Dashboard list with empty state. Strict
per-user rules scoping.

**Key tests:** L3 rules per operation, L2 list and empty state, L5 create → appears →
rename → soft-delete → gone.
**Demo:** create a project, rename it, delete it.

---

### Slice 4 — Workspace shell & chat persistence
**Spec:** F6.1, F6.2, F3.4 (partial) · **Depends on:** 3 · **Mode:** full · **Day 2**

Three-panel workspace (chat | editor | preview) in shadcn-vue, responsive behaviour
decided here. Chat panel with message history, input, and persistence to Firestore. The
assistant is a **stub** that echoes — no LLM yet. This exists so the layout and the
persistence model get reviewed without streaming complexity on top.

**Key tests:** L2 panel layout and message rendering, L3 messages scoped to project owner,
L5 send a message, reload, history is still there.
**Demo:** open a project, send a message, reload, history persists.

---

### Slice 5 — Streaming generation
**Spec:** F3.1, F4.1, F4.2 (token/done/error), F4.3 · **Depends on:** 4 · **Mode:** full · **Day 2–3**

The SSE Cloud Function: prompt in, real LLM call, `token` / `done` / `error` events out,
tokens accumulating live in the chat panel. Disconnect and interruption handling with
partial results preserved. Still no file operations — this slice proves the transport.

**Key tests:** L1 SSE event encoder and client-side parser, L1 accumulator, L4 stream with
a stubbed LLM including mid-stream abort, L5 prompt → tokens visibly appear → done.
**Demo:** type a prompt, watch text stream in token by token.
**Risk:** high — verify Cloud Functions v2 streaming in your region early (spec §6.3).

---

### Slice 6 — File operations
**Spec:** F3.3, F5.1, F4.2 (file boundaries) · **Depends on:** 5 · **Mode:** full · **Day 3**

Parse the LLM's final output into validated file operations, reject or repair malformed
output without corrupting project state, persist files to Firestore, render a file tree,
read a file, save a manual edit. Plain textarea for now — Monaco is the next slice.

**Key tests:** L1 parser against a fixture corpus including malformed cases, L1 validation
rejects path traversal and oversized files, L3 file rules, L5 generate → tree populates →
edit → save → reload.
**Demo:** generate, see files appear in the tree, edit one, reload, edit persisted.

---

### Slice 7 — Monaco editor
**Spec:** F6.3 · **Depends on:** 6 · **Mode:** fast · **Day 3**

Swap the textarea for `@guolao/vue-monaco-editor`. Tabbed editing, clickable file tree,
tokens appear live in the editor during generation, read-only while streaming.

**Key tests:** L2 read-only during stream, tab switching preserves unsaved state, L5
golden path in the real editor.
**Demo:** watch code stream into Monaco, switch tabs, edit after the stream ends.

---

### Slice 8 — HighLevel API proxy
**Spec:** F7.1, F7.2 · **Depends on:** 2 · **Mode:** full · **Day 3–4**

The authenticated proxy generated apps call. Attaches and refreshes the user's token
server-side, allowlists routes across Contacts, Conversations, and Calendars, maps
HighLevel errors to clear client errors (401 → prompt to reconnect).

**Key tests:** L4 one test per API surface with recorded fixtures, unauthenticated request
rejected, expired-token refresh path, error mapping, L1 route allowlist rejects anything
not on it.
**Demo:** curl the proxy with a signed-in session, get real sandbox contacts back.
**Risk:** high — this is where a mistake leaks another tenant's data. Rules and auth checks
get adversarial tests.

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

**Key tests:** L2 shim injection and sandbox attributes, L4 preview fetches proxied data,
L5 the full golden path ending in real data on screen.
**Demo:** the money shot — generated dashboard rendering real sandbox contacts.

---

### Slice 11 — Snapshots & restore
**Spec:** F5.2, F5.3, F6.6 · **Depends on:** 6 · **Mode:** fast · **Day 4–5**

Snapshot every project file on each generation, list snapshots by timestamp in a shadcn
Sheet, restore any previous one.

**Key tests:** L1 snapshot diffing, L4 restore round-trip fidelity, L3 rules, L5 generate
twice → restore first → files match.
**Demo:** generate, generate again, restore version one.

---

### Slice 12 — Error handling & state hardening
**Spec:** F8.1, F8.2, F8.3 · **Depends on:** 10, 11 · **Mode:** fast · **Day 5**

A cross-cutting audit rather than new features. Every screen gets loading, empty, and
error states; every failure mode from F8 gets a user-facing message and a test. Malformed
LLM output, interrupted streams, expired connections.

**Demo:** deliberately break each dependency, show the app degrades legibly.

---

### Slice 13 — Deliverables
**Spec:** F9.1–F9.5 · **Depends on:** 12 · **Mode:** fast · **Day 5**

Deploy frontend and functions, register the deployed callback URL, write the root README
(HighLevel setup, emulator setup, ≤10 architecture decisions, ≤5 improvements, deployment
notes), `.env.example`, the sandbox seed script (`scripts/seed-sandbox.ts`, ~20 contacts and
5–10 appointments), and the Loom script.

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

| Day | Slices | The bet |
|---|---|---|
| 1 | 0, 1, 2 | Rails plus the riskiest integration first — if OAuth is going to hurt, find out now |
| 2 | 3, 4, 5 | Data model and the streaming transport proven |
| 3 | 6, 7, 8 | Generation produces real files; the proxy is live |
| 4 | 9, 10, 11 | The differentiator and the money shot |
| 5 | 12, 13 | Harden, deploy, document, record |

If you fall behind, cut from the stretch list first, then Slice 7 (textarea ships), then
Slice 11. Never cut Slice 8's tests.

---

## 6. Conventions

**Branches:** `slice/<nn>-<slug>` — e.g. `slice/02-highlevel-connection`
**Commits:** imperative, one per green TDD cycle — `test: contact token refresh triggers at expiry`, then `feat: refresh HighLevel token before expiry`
**PR title:** `Slice NN — Name`
**PR body:** what changed, acceptance criteria with test names, how to verify locally, demo evidence, anything deliberately deferred
**Docs:** `docs/slices/<nn>-<slug>/` holds the five stage documents for that slice

---

## 7. Repo setup

Not a git repository yet, and `gh` is not authenticated. Run:

```bash
gh auth login                 # interactive — run this yourself
./scripts/bootstrap-github.sh # creates the repo, pushes main, opens an issue per slice
```

The script is checked in and does nothing until you run it. Read it first — it creates a
repository under your account.

---

## 8. Open decisions

These are called out in `PRODUCT_SPEC.md` §6 and get settled in the discovery stage of the
slice that first needs them, not before:

| Decision | Needed by | Leaning |
|---|---|---|
| Preview runtime: `srcdoc` vs Sandpack | Slice 10 | `srcdoc` with a shim — simplest, full control |
| Generated app format: single-file vs multi-file | Slice 6 | Multi-file plain HTML/JS/CSS — reliable LLM output, trivial preview |
| SSE transport on Functions v2 | Slice 5 | Verify in Slice 0 so there's time for the chunked-fetch fallback |
| LLM provider and file-op format | Slice 5 | Claude with streaming; fenced blocks with path headers |
| File storage: Firestore vs Cloud Storage | Slice 6 | Firestore — keeps snapshot and restore trivial |
| Google SSO in addition to email + password | Slice 1 | Ask — cheap, demos well, not required |
