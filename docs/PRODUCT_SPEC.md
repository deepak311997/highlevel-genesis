# Genesis — AI-Powered HighLevel App Builder

**Product Spec v2** · Source: HighLevel Senior Engineer take-home (GENESIS_ASSIGNMENT_V2)
**Time limit:** 5 days · **Stack (mandated):** Vue 3 + TypeScript + shadcn-vue + Firebase (Auth, Firestore, Cloud Functions, Hosting) + Claude/OpenAI (streaming mandatory)
**Re-reviewed against the brief:** 2026-08-16 — §3 rewritten as-built, §7 (exact packages) added.

---

## 1. Product Overview

Genesis is an AI app builder (think Lovable/Bolt, scoped to the HighLevel ecosystem). A user signs in, connects their HighLevel account via OAuth 2.0, creates a project, and describes the app they want in a chat interface. An LLM generates a working web app whose code calls **real HighLevel APIs** (Contacts, Conversations, Calendars), streamed token-by-token into a code editor, with a live preview rendering real CRM data.

**Key differentiator (per the brief):** the AI doesn't generate generic web apps — it generates apps that talk to the HighLevel platform. "Build me a dashboard showing recent contacts and upcoming appointments" must produce code that calls the Contacts API and Calendars API and displays real data.

## 2. Target User & Core Flow

HighLevel agency/marketplace users who want custom mini-apps over their CRM data without writing code.

**Golden path (this is also the demo script for the Loom video):**
1. Sign up / sign in (email + password, Firebase Auth)
2. Connect HighLevel account via OAuth → connection status shows location name
3. Create a project (name, description, linked HL location)
4. Send a prompt: *"build a contact dashboard with search and a list of upcoming appointments"*
5. Watch generation stream live into the editor (SSE)
6. Preview renders the generated app with **real** HighLevel data
7. Manually edit a file; preview updates
8. Open snapshot history; restore a previous version

## 3. System Architecture

Not a sketch — the region, database id and rewrites below are pinned in `firebase.json`,
`functions/src/index.ts` and `frontend/vite.config.ts`, and drifting from them breaks the
build. Slices marked ✅ have shipped.

```
Browser — Vue 3 SPA (shadcn-vue · Monaco · sandboxed iframe preview)
   │
   │  Firebase Auth ID token, browserLocalPersistence
   │  Firestore reads/writes authorised by SECURITY RULES, never by client code
   │
   ├── same-origin fetch, resolved by Firebase Hosting rewrites:
   │        /api/**    →  function `api`       (asia-south1)  Express router
   │        /generate  →  function `generate`  (asia-south1)  SSE, unbuffered
   ▼
Cloud Functions v2 · Node 22 · region asia-south1
   ├─ api/health          round-trip diagnostic                              ✅ Slice 0
   ├─ api/auth/*          register · throttle · unverified-account cleanup   ✅ Slice 1
   ├─ api/oauth/callback  HL authorize → code-for-token → Firestore             Slice 2
   ├─ generate            prompt → bounded context → Claude stream →
   │                      SSE events → validated file ops → snapshot          Slices 5, 6, 9, 11
   └─ api/hl/*            HighLevel proxy: route allowlist, transactional
                          token refresh, error normalisation                   Slice 8
   ▼
Firestore — NAMED database `hl-genesis` (not `(default)`)
   users · authThrottle · hlConnections · projects · files · snapshots · messages
```

**Three architecture facts that are easy to get wrong and are already settled:**

1. **Region is `asia-south1`** everywhere — `setGlobalOptions()` in functions, the Hosting
   rewrite targets, and the dev-server proxy in `vite.config.ts` all name it. Slice 0
   proved Cloud Functions v2 streams unbuffered from this region through a Hosting rewrite,
   which was §6.3's open risk.
2. **Firestore is a named database.** `getFirestore(app)` silently connects to `(default)`,
   which is empty. The id is passed explicitly on both sides and mirrored by
   `FIRESTORE_DATABASE_ID` / `VITE_FIREBASE_DATABASE_ID`.
3. **Functions are reached same-origin through Hosting rewrites**, not via
   `cloudfunctions.net`. CORS is defence in depth (an origin allowlist), not the mechanism.

**Why a HighLevel proxy function matters:** generated apps run in a sandboxed iframe and can't hold OAuth tokens or call HL APIs directly (CORS + secret exposure). The generated code calls our proxy endpoint; the proxy attaches the user's token, handles refresh, and forwards to HighLevel. This is also what makes "real data in the preview" achievable safely.

## 4. Feature List

### F1. Authentication & Account Linking
- **F1.1** Email + password sign up / sign in via Firebase Auth; session persists across refreshes
- **F1.2** "Connect HighLevel" OAuth 2.0 flow: redirect to HL authorize URL → Cloud Function callback → store access/refresh tokens in Firestore, scoped to the Firebase user
- **F1.3** Token lifecycle: refresh on expiry, one HL location per user, connection status UI (location name or "Not connected")

### F2. Project Management
- **F2.1** Project CRUD: create, read, update, soft-delete (name, description, HL location ID, file list)
- **F2.2** Strict per-user scoping via Firestore security rules
- **F2.3** Project dashboard/list screen

### F3. Chat & AI Generation (backend)
- **F3.1** Generation Cloud Function: accepts prompt, gathers bounded context (project files, chat history, HL API knowledge), streams LLM completion
- **F3.2** System prompt embedding HighLevel API knowledge (Contacts, Conversations, Calendars endpoints + the proxy calling convention) so generated code uses real endpoints
- **F3.3** Parse final LLM output into validated file operations (create/update files); reject/repair malformed output
- **F3.4** Persist chat messages, generated files, and generation metadata to Firestore

### F4. SSE Streaming Protocol
- **F4.1** HTTP Cloud Function streaming Server-Sent Events to the browser
- **F4.2** Event protocol covering at minimum: `token`, `file_start` / `file_end` (file boundaries), `done`, `error`
- **F4.3** Graceful handling of disconnects and interrupted streams; partial results preserved

### F5. File Management & Version Control
- **F5.1** List project file tree, read file content, save manual edits
- **F5.2** Snapshot on every generation: point-in-time copy of all project files in Firestore
- **F5.3** List snapshots (timestamps) and restore any previous snapshot

### F6. Workspace UI (frontend)
- **F6.1** Three-panel workspace: chat | code editor | live preview — all shadcn-vue components
- **F6.2** Chat panel: user/assistant message history, input box, streaming assistant status
- **F6.3** Monaco editor (`@guolao/vue-monaco-editor`): file tree with clickable files, tabbed editing, tokens appear live during generation, read-only while streaming
- **F6.4** Live preview in an iframe (srcdoc or Sandpack) showing **real HL data**; refreshes after generation completes
- **F6.5** SSE client: handles all event types, accumulates tokens into the editor, reconnect/graceful failure
- **F6.6** Snapshot history in a shadcn Sheet/Dialog with Restore action

### F7. HighLevel API Integration
- **F7.1** Three API surfaces exposed to generated apps: **Contacts** (list/search/create/update), **Conversations** (list, get messages, send), **Calendars** (list, appointments, availability)
- **F7.2** Authenticated proxy endpoint that generated apps call; attaches/refreshes OAuth tokens server-side
- **F7.3** Sandbox HL account for safe testing

### F8. Error Handling (mandatory, cross-cutting)
- **F8.1** Malformed LLM responses → validation + clear user-facing error, no corrupted project state
- **F8.2** Interrupted streams → partial results preserved, user can retry
- **F8.3** Failed HL API calls → clear errors surfaced in preview/UI (e.g., expired connection → prompt to reconnect)

### F9. Deployment & Deliverables
- **F9.1** Frontend on Firebase Hosting; all functions deployed; live URLs in README
- **F9.2** Secrets via env/Firebase Secret Manager only; `.env.example` provided
- **F9.3** Deployed callback URL registered as OAuth redirect URI in the HL marketplace app
- **F9.4** Repo layout: `/functions`, `/frontend`, `firebase.json`, `.firebaserc`, root README (HL setup, local emulator setup, ≤10 architecture-decision bullets, ≤5 improvement bullets, deployment notes)
- **F9.5** Loom video ≤5 min walking the golden path + one architecture decision

### F10. Bonus (not required, ranked by impressiveness-per-effort)
- **F10.1** Iterative refinement — second prompt modifies existing code (high value; mostly prompt/context work)
- **F10.2** Generation cancellation (abort mid-stream)
- **F10.3** Diff view of what the LLM changed per generation
- **F10.4** Rate limiting on Cloud Function endpoints
- **F10.5** Generated app handles HL API pagination
- **F10.6** Webhook support — generated app reacts to HL webhook events

## 5. Non-Functional Requirements
- Streaming is mandatory (no request/response-only LLM calls)
- No secrets in source, ever
- All data access scoped to the authenticated user by security rules
- Runs locally on Firebase emulators — **the brief names this explicitly in the README
  deliverable, so it must work from a fresh clone.**

  **`npm run dev` is the emulator path, and that reverses an earlier decision.** Slices 0–1
  pointed `npm run dev` at *real* Firebase on the reasoning that the development path should
  be the production path. In practice that meant local changes could not be exercised at all
  before deploying — the SPA proxied `/api` to the deployed functions, so any endpoint not
  yet shipped answered 404 on a developer's own machine. Reversed in Slice 2: `npm run dev`
  now starts the emulators *and* the SPA against them in one command, with state persisted
  between runs, and a stubbed HighLevel so the OAuth loop works offline. The real-Firebase
  path is still there as `npm run dev:cloud`.

## 6. Key Design Decisions to Make (input for phasing)
1. **Preview runtime:** iframe `srcdoc` (simplest, full control) vs Sandpack vs WebContainers — recommend `srcdoc` with a small runtime shim that injects the proxy base URL + auth
2. **Generated app format:** single-file HTML+JS vs multi-file Vue app — single-file or plain HTML/JS/CSS multi-file keeps preview trivial and LLM output reliable
3. **SSE transport:** Cloud Functions v2 (onRequest) supports streaming responses — verify region/runtime; fallback is chunked fetch
4. **LLM provider:** Claude (`@anthropic-ai/sdk`) with streaming; structured file-ops format (e.g., fenced blocks with file-path headers or tool-use JSON)
5. **File storage:** Firestore documents (files are small text) vs Cloud Storage — Firestore keeps snapshots/restore trivial
6. **HL knowledge injection:** curated endpoint cheat-sheet in the system prompt vs tool-calling — cheat-sheet is simpler and deterministic

Items 1–6 above were leanings when this spec was written. Their current state — decided,
proven, or still open — lives in `IMPLEMENTATION_PLAN.md` §8, which is the one place that
tracks them.

---

## 7. Mandated stack — the exact packages

The brief names specific packages, not categories. A reviewer will `cat package.json`
before they read a line of our code, so this table is the contract: **left column is what
the assignment says, middle is exactly what we install, right is where it lands.** Nothing
substitutes for a named package without a recorded decision.

### 7.1 Named by the brief

| Brief says | Exact package | Where | Status |
|---|---|---|---|
| Vue 3 | `vue` ^3.5 | frontend | ✅ installed |
| TypeScript | `typescript` ^6, `vue-tsc` | both | ✅ `strict` + four extra flags (see CLAUDE.md) |
| **ShadCN for Vue (`shadcn-vue`)** | `shadcn-vue` CLI + vendored components | frontend | ✅ see §7.2 — *this one needs reading* |
| **Monaco (`@guolao/vue-monaco-editor`)** | `@guolao/vue-monaco-editor`, `monaco-editor` | frontend | ⏳ Slice 7 — use the exact package, not `monaco-editor-vue3` |
| **Claude (`@anthropic-ai/sdk`)** | `@anthropic-ai/sdk` ^0.117.1 | functions | ✅ installed in Slice 5 — model `claude-opus-5`, `client.messages.stream()` only, `max_tokens: 64000`; the pin is deliberate, that release types `output_config.effort` and `MessageStreamParams` so no cast is needed |
| Firebase Auth / Firestore / Functions / Hosting | `firebase` (web), `firebase-admin`, `firebase-functions` v7 (v2 API), `firebase-tools` | all | ✅ installed |
| Live preview: Sandpack / WebContainers / **srcdoc** | none — `srcdoc` + a hand-written runtime shim | frontend | ⏳ Slice 10 (decision: §6.1) |

### 7.2 shadcn-vue is a registry, not a dependency — read this before doubting conformance

`shadcn-vue` will never appear in `dependencies`, and that is correct, not a shortcut. It
is a **copy-in registry**: `npx shadcn-vue@latest add button` writes the component source
into `src/components/ui/` and it becomes ours to own. What shows up in `package.json` is
what those components import:

| Package | Why it is there |
|---|---|
| `reka-ui` | shadcn-vue's headless primitive layer (the Radix equivalent). Every shadcn-vue component is built on it. **This is the marker of a real shadcn-vue install, not a departure from one.** |
| `class-variance-authority` | `buttonVariants`, `alertVariants` — the variant API shadcn generates |
| `clsx` + `tailwind-merge` | the `cn()` helper in `src/lib/utils.ts` |
| `lucide-vue-next` | the icon library declared in `components.json` |
| `tailwindcss` v4 | the styling layer; CSS-variable theming, `components.json` → `cssVariables: true` |

`frontend/components.json` is the shadcn-vue config and is committed. **Rule from here on:
new primitives are added with `npx shadcn-vue@latest add <name>` and then edited, never
hand-written from scratch** — provenance has to be checkable by diffing against upstream.
Where we deviate from upstream (the `Alert` role-follows-variant change, `Button`'s
`as-child`), the component carries a comment saying so.

**Component inventory.** The brief calls out "inputs, buttons, dialogs, tabs, badges, and
layout primitives", plus "a ShadCN sheet or dialog" for snapshot history:

| Component | Brief calls for it | Slice |
|---|---|---|
| `button`, `input`, `label`, `card`, `alert` | ✅ | ✅ Slices 0–1 |
| `dialog` | ✅ named explicitly | ✅ Slice 3 |
| `tabs`, `badge` | ✅ named explicitly | ✅ Slice 4 |
| `resizable`, `scroll-area`, `separator` | layout primitives, three-panel workspace | ✅ Slice 4 |
| `textarea` | not named — see below | ✅ Slice 4 |
| `sheet` | ✅ snapshot history | Slice 11 |
| `sonner` or `toast`, `skeleton` | error + loading states (F8, DoD) | Slice 12 |

**`textarea` is a departure from the list, recorded rather than decided at the keyboard**
(Slice 4, D21). The brief names "inputs" and `IMPLEMENTATION_PLAN.md` §4 named five
components for Slice 4; the chat composer needs a sixth, because "build a contact dashboard
with search and a list of upcoming appointments" does not belong in a single-line `Input`.
It is an input primitive in the same family as the ones the brief lists, and it was added
by the CLI like every other one so its provenance stays diffable against upstream.

**Slice 4's vendored blocks carry deviation comments**, as the rule above requires. Nine of
the seventeen generated files failed this project's `strictTypeChecked` /
`exactOptionalPropertyTypes` on one shared cause — upstream forwards props with
`reactiveOmit` / `useForwardProps(Emits)`, whose result carries keys whose value is
`undefined`, which the compiler treats as different from absent. Each is fixed the way
`ui/label/Label.vue` documents, and says so in its own header. No new runtime dependency
was added: all six blocks sit on `reka-ui`, `class-variance-authority`, `clsx`,
`@vueuse/core` and the already-present `lucide-vue-next`.

### 7.3 Ours, not mandated — recorded so the choice is visible

| Package | Role | Why this one |
|---|---|---|
| `zod` v4 | every boundary: request bodies, LLM file-ops output, HL responses | Parse-don't-validate. F3.3's "validated file operations" is a Zod schema, not hand-rolled checks. |
| `pinia` | auth, project, generation stores | The Vue 3 default |
| `vue-router` | routing + the three-state auth guard | — |
| `express` + `cors` | one `api` function multiplexing routes | Keeps cold starts to one function instead of a dozen |
| `vitest`, `@vue/test-utils`, `@firebase/rules-unit-testing`, `@playwright/test` | test levels L1–L5 | See IMPLEMENTATION_PLAN §2 |
| `@gohighlevel/api-client` | **types only, devDependency** | Its `.d.ts` is the most reliable parameter reference for the HL APIs. Production calls go through our own `fetch` proxy — the SDK's auto-refresh would reintroduce the token-rotation race (HIGHLEVEL_PLATFORM §3). |

### 7.4 Explicitly rejected

| Not using | Instead | Because |
|---|---|---|
| `openai` | `@anthropic-ai/sdk` | Brief allows either; CLAUDE.md pins Claude |
| Sandpack / WebContainers | iframe `srcdoc` + shim | Full control of the shim that injects the proxy base URL and auth; no bundler in the browser |
| `vuefire` | plain `firebase` SDK in Pinia stores | Removed in Slice 1 — an extra reactivity layer over Firestore we did not need |
| a mail provider (SMTP2GO et al.) | Firebase Auth's own sender | Slice 1 D31 — one fewer secret, one fewer domain to verify |
| `@gohighlevel/api-client` at runtime | our own `fetch` proxy | See §7.3 |
