# Genesis — AI-Powered HighLevel App Builder

**Product Spec v1** · Source: HighLevel Senior Engineer take-home (GENESIS_ASSIGNMENT_V2)
**Time limit:** 5 days · **Stack (mandated):** Vue 3 + TypeScript + shadcn-vue + Firebase (Auth, Firestore, Cloud Functions, Hosting) + Claude/OpenAI (streaming mandatory)

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

## 3. System Architecture (high level)

```
Vue 3 SPA (shadcn-vue, Monaco, iframe preview)
   │  Firebase Auth session, Firestore reads (rules-scoped)
   │  SSE ── HTTP Cloud Function (LLM streaming)
   ▼
Firebase Cloud Functions
   ├─ OAuth callback (HL authorize → tokens → Firestore)
   ├─ Generation endpoint (prompt → context → LLM stream → file ops → snapshot)
   ├─ HighLevel API proxy (token refresh, called by generated apps in preview)
   └─ Project/file/snapshot operations (where rules aren't enough)
   ▼
Firestore: users, hlConnections (tokens), projects, files, snapshots, chat messages
```

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
- Runs locally on Firebase emulators (`firebase emulators:start`)

## 6. Key Design Decisions to Make (input for phasing)
1. **Preview runtime:** iframe `srcdoc` (simplest, full control) vs Sandpack vs WebContainers — recommend `srcdoc` with a small runtime shim that injects the proxy base URL + auth
2. **Generated app format:** single-file HTML+JS vs multi-file Vue app — single-file or plain HTML/JS/CSS multi-file keeps preview trivial and LLM output reliable
3. **SSE transport:** Cloud Functions v2 (onRequest) supports streaming responses — verify region/runtime; fallback is chunked fetch
4. **LLM provider:** Claude (`@anthropic-ai/sdk`) with streaming; structured file-ops format (e.g., fenced blocks with file-path headers or tool-use JSON)
5. **File storage:** Firestore documents (files are small text) vs Cloud Storage — Firestore keeps snapshots/restore trivial
6. **HL knowledge injection:** curated endpoint cheat-sheet in the system prompt vs tool-calling — cheat-sheet is simpler and deterministic
