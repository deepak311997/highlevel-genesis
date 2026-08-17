# Slice 05 — Streaming generation · PRD

**Spec:** F3.1, F4.1, F4.2 (`token`/`done`/`error`), F4.3, F6.2 (streaming status), F6.5, F8.2 ·
**Branch:** `slice/05-streaming-generation` · **Depends on:** 4 · **Date:** 2026-08-17

## Problem

The workspace has a chat that persists, and an assistant that says `You said: …`. Everything
downstream of it — file operations, the editor, HighLevel knowledge injection, the preview — is
waiting on one thing that does not exist yet: a real LLM call whose output arrives token by token.

Slice 0 proved the transport in the abstract: a `generate` function streams five hard-coded words
through a Hosting rewrite from `asia-south1`, unauthenticated, with a 60-second timeout and no test
at any level. This slice makes it real — an authenticated, attested endpoint that reads the
project's transcript, calls `claude-opus-5` with `messages.stream()`, and emits `token` / `done` /
`error` frames that the chat panel renders as they arrive. Still no file operations: this slice
proves the transport and the interruption story, and Slice 6 gives the output structure.

## The demo

Open a project, type "build a contact dashboard", and watch a real Claude reply appear a few
characters at a time in the chat panel; reload and it is still there, whole — then kill the stream
mid-reply and find the partial answer preserved with a **Retry** beside it.

## Decisions

No interview was run: this slice ships under the unattended loop, so every question below was
answered from `PRODUCT_SPEC.md` §4 (F3.1, F4.1–4.3, F6.2, F6.5, F8.2) and §7.1,
`IMPLEMENTATION_PLAN.md` §4 (Slices 0, 4, 5, 6, 9, 11) and §8, `CLAUDE.md`'s non-negotiables, the
`claude-api` reference skill for the SDK's current call shape, and the merged code of Slices 0–4.
Load-bearing decisions carry the alternative that was rejected, because a decision with no rejected
alternative was not a decision.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | What is the endpoint's path? | **`POST /generate`** — Slice 0's Hosting rewrite and Vite dev-proxy entry, both unchanged. | The route names an action, not a user, which is what `CLAUDE.md`'s rule actually forbids; the resource id travels in the body and is ownership-checked against the token's uid. Rejected: **`/api/projects/:projectId/generate`**, which reads better and costs two environment-specific mappings that differ from each other — the Hosting rewrite list would need a more specific rule inserted *before* `/api/**`, and `vite.config.ts` would need a matching per-path exception routing that one path to the `generate` function while every other `/api/**` path goes to `api`. Two hand-maintained mappings that must agree is precisely the class of defect this project has already paid for twice (the `(default)` database, the missing composite index): it works in one environment and 404s in the other. Keeping Slice 0's path also keeps Slice 0's *proof* — the streaming path a reviewer can already trust is the one we build on. |
| D2 | What is in the request body? | **`{ projectId }` and nothing else**, `.strict()`. The prompt is **not** sent. | The model's input is the transcript, and the transcript is the server's own record. A body carrying the prompt lets the client's copy disagree with what is stored — the same failure D5 of Slice 4 closed, one level up: a caller could stream a reply to a prompt that is not in the history the reply gets appended to. It is also what makes Retry (D26) work with no new user message and no special case. Rejected: `{ projectId, content }`, which is the obvious shape and duplicates both the 4,000-character validation and the 200-message cap in a second place. |
| D3 | How many requests does one turn take? | **Two.** `POST /api/projects/:projectId/messages` writes the user turn and returns it; `POST /generate` streams the reply and writes it. | This is Slice 4's D6, executed as planned rather than reopened: "the assistant write moves to the stream's `done` handler, the user write stays in the `POST`". It has a property one request does not: **the user's prompt is durable before the expensive, failure-prone half begins**, which is the whole of F8.2 — a generation that dies before producing a byte still leaves a transcript the user recognises and a Retry that works. Rejected: one `POST /generate` doing both, which would leave Slice 4's route with no caller (a route that exists only to be deleted) and would re-implement its body schema, its 404 and its 409 inside a streaming handler where a validation failure is much harder to answer cleanly. |
| D4 | What does `POST /api/projects/:projectId/messages` return now? | **`201 { messages: [ <user message> ] }`** — the array shape is kept, with one element. | The store already appends whatever the server returned (Slice 4 D12), so a one-element array changes no frontend code at all. Rejected: `{ message: … }`, which is a nicer singular shape and a gratuitous edit to the client, the store and four tests. |
| D5 | What context does the LLM get? | **The project's stored transcript**, oldest first, read with Slice 4's `transcriptQuery`, plus a small stable system prompt. | F3.1 asks for bounded context from project files, chat history and HL knowledge. Files do not exist until Slice 6 and the cheat-sheet is Slice 9's whole purpose; chat history exists *now*, is already hard-capped at 200 messages, and sending it is what makes the panel a conversation rather than 200 amnesiac one-shots. **Token-budget truncation is explicitly Slice 9's** (`IMPLEMENTATION_PLAN.md` §4), and the 200-message cap is what makes deferring it safe rather than optimistic. |
| D6 | **The transcript can end with an assistant message. What then?** | **Trailing assistant turns are dropped when the context is assembled**, so the array handed to the SDK always ends on a user turn. | **This is the slice's one real hazard.** A trailing assistant message *is* an assistant prefill, and **prefill returns a 400 on `claude-opus-5`** — so the request fails with `invalid_request_error` rather than streaming. It is not a theoretical shape: it is exactly what Retry after an interruption produces (user, assistant-truncated → Retry), and it is also what every project carrying Slice 4's echo messages looks like. The failure would therefore land on the recovery path — the one thing that is supposed to work when something has already gone wrong. Dropping trailing assistants is one loop with an L1 test. Rejected: sending the transcript verbatim and letting the SDK complain (the 400 surfaces as a generic "generation failed" and the cause is invisible); rejected: appending a synthetic "continue" user turn, which invents a message the user never wrote into a transcript whose whole value is being a true record. |
| D7 | What if dropping leaves nothing? | **`400 empty_context`**, before any LLM call. | An empty `messages` array is a 400 from the API anyway; answering it ourselves costs nothing, names the real cause, and is reachable — Retry on a project whose only messages are Slice 4 echoes lands exactly here. |
| D8 | Which SSE events does this slice emit? | **`token`, `done`, `error`**, plus comment frames for keep-alive. `file_start` and `file_end` stay declared in `SseEventName` and unused. | F4.2 names the file-boundary events, and `IMPLEMENTATION_PLAN.md` §4 assigns them to Slice 6 along with the file operations that give them something to bound. Emitting them now with nothing to say would be a protocol nobody can test. The union already lists them, so Slice 6 adds handlers rather than a vocabulary. |
| D9 | What terminates a stream? | **Exactly one terminal event: `done` or `error`.** `done` carries `{ message }` — the assistant turn as persisted. `error` carries `{ error, code, message }`, where `message` is the persisted partial or `null`. | The client needs the server's id and `createdAt` to replace its placeholder bubble with a real message, and it needs that on *both* paths or the interrupted case is a second rendering path with its own bugs. Putting the persisted message on `error` collapses success and interruption into one client code path: whatever arrives, the placeholder is replaced by what the server actually stored. Rejected: `error` carrying only a message string, leaving the client to keep its own accumulated text as an id-less bubble that then disagrees with the server's copy on the next load. |
| D10 | Errors before the response has started vs after? | **Two channels, and the boundary is `flushHeaders()`.** Everything before it — auth, App Check, body parse, project lookup, empty context — is an ordinary JSON error in the existing `{ error, code }` envelope with a real status. Everything after it is an `error` event on a 200 stream. | Once headers are flushed the status line is spent; a stream cannot go back and become a 401. So all the refusals that *can* be decided cheaply are decided first, deliberately, and the streaming half only has to express failures that are genuinely mid-flight. Rejected: opening the stream immediately and reporting everything as `error` events, which makes every client failure a 200 and throws away the status codes the rest of the API answers with. |
| D11 | How does the browser open the stream? | **`fetch` + `ReadableStream`**, reading `response.body`. Not `EventSource`. | `EventSource` cannot set headers and cannot POST, so it can carry neither the ID token nor the App Check token; the workaround is a credential in the query string, which puts a bearer token into browser history, Hosting access logs and any intermediary's. That is not a trade-off worth making for a built-in reconnect we do not want anyway — an SSE auto-reconnect would silently start a *second* paid generation. |
| D12 | Auth on `/generate`? | **`withVerifiedUser` — ID token and `email_verified` — and `requireAppCheck`.** | Slice 1's D26 and Slice 2's inherited contract, unchanged. `firebase-functions` v2 hands the handler Express-shaped `req`/`res`, so both compose without a second implementation. Attestation matters more here than on any route so far: this is the first endpoint where an unattested call spends money. |
| D13 | Model and call shape? | **`claude-opus-5`, `client.messages.stream()`, `max_tokens: 64000`.** | `CLAUDE.md`'s non-negotiables and `PRODUCT_SPEC.md` §7.1. `messages.create` is a brief violation, not a style choice. `max_tokens` at 64,000 also requires streaming to avoid the SDK's HTTP timeout, which is the same constraint from the other side. |
| D14 | Extended thinking? | **Left at the `claude-opus-5` default — adaptive, on, `display` omitted.** Thinking deltas are never forwarded as `token` events. | Thinking is **on by default on `claude-opus-5`** (unlike Opus 4.8, where omitting the field meant off), so this is a decision either way. Rejected: `thinking: { type: 'disabled' }`, which the API accepts at effort `high` or below and which carries a documented Opus-5-specific failure mode that is disqualifying here — with thinking off the model can leak `<thinking>` tags into its *visible* output. Model-internal XML in the chat transcript is ugly today; from Slice 6, when that same text is parsed into files, it is corruption. The cost of leaving thinking on is a pause before the first token, which D15 shortens and D30 makes legible. |
| D15 | Effort level? | **`output_config: { effort: 'low' }` for this slice.** | Three reasons and one caveat. `low` on `claude-opus-5` is documented as unusually strong; it keeps thinking short, so the pause D14 accepts stays small; and it keeps a whole turn well inside the window a Hosting rewrite is known to tolerate (R2). The caveat: this slice generates prose, not code. **Slice 9 owns generation quality** and will re-tune effort against real HighLevel prompts, where `high` or `xhigh` is the documented starting point. Recorded so that change reads as planned. |
| D16 | The `cache_control` breakpoint? | **Declared now**, on the last block of the stable system prefix. It will not actually cache until Slice 9. | `CLAUDE.md` requires the HL cheat-sheet pinned behind a breakpoint. The cheat-sheet is Slice 9's; what this slice owes is the *structure* — a stable prefix, a breakpoint at its end, and nothing volatile above it. The honest note: `claude-opus-5`'s minimum cacheable prefix is **512 tokens**, and this slice's system prompt is far shorter, so `cache_creation_input_tokens` will be 0 and **no error will say so**. That is a silent no-op, not a bug, and it becomes a real cache read in Slice 9 when the cheat-sheet crosses the minimum. The L1 test that matters now is the one asserting nothing volatile — no project name, uid, or timestamp — appears above the breakpoint. |
| D17 | What goes in the system prompt? | **One stable block**: what Genesis is, that it builds small web apps over a HighLevel CRM, and the response-style constraints. No HighLevel endpoints, no file-format instructions. | No speculative content: an endpoint list written now would be wrong by Slice 9 and a file-format instruction would describe a parser that does not exist until Slice 6. Stability is the requirement the breakpoint imposes, and the surest way to be stable is to say only what is already true. |
| D18 | Server-side refusal fallbacks? | **No.** A refusal becomes an `error` event with a user-facing message and code `refused`. | `claude-opus-5` can decline a request — HTTP 200 with `stop_reason: 'refusal'` — and the SDK guidance is to opt into `fallbacks: 'default'`. Declined here, deliberately: the workload is CRM app scaffolding, which is not a refusal-prone domain; the parameter is behind a beta header with its own repricing and routing semantics; and **a stubbed LLM cannot exercise it**, so it would ship as untested code in a project whose testing rule is that the LLM is always stubbed. Recorded as a README follow-up rather than a silent omission. The `stop_reason` check is *not* optional, though — reading `content[0]` unconditionally breaks on a refusal, so the terminal handling reads `stop_reason` first. |
| D19 | Where does the API key live? | **`defineSecret('ANTHROPIC_API_KEY')`, bound to the `generate` function**; `functions/.secret.local` for emulator runs; the client is constructed lazily on first use. | Already the declared shape in `functions/.env.example`. Lazy construction for `getDb()`'s reason: `firebase deploy` loads and analyses the module before injecting config, so a client built at module scope is built with no key. |
| D20 | How is the LLM stubbed in tests? | **`functions/src/llm/fake.ts`, gated on `FUNCTIONS_EMULATOR` and nothing else**, replaying recorded event sequences from `tests/fixtures/llm/`. Behaviour is selected by a marker in the last user message. | `buildFakeHlRouter`'s pattern, for its reasons: `FUNCTIONS_EMULATOR` is the one signal an operator cannot set and a deploy cannot carry, and a config flag would be a remotely-settable way to replace the model with a fake. Selecting behaviour by prompt marker rather than a control API keeps the intent on the page in the test (`prompt('__fail_midstream')`) and needs no second endpoint. Markers: `__fail_midstream` (two tokens then an upstream error), `__refuse` (`stop_reason: 'refusal'`), `__long` (enough tokens to observe an abort), `__slow` (delays, for the keep-alive and disconnect tests). |
| D21 | What happens to a stream the client abandoned? | **The SDK stream is aborted and any produced text is persisted**, marked `truncated`. No event is emitted — nobody is listening. | F4.3 and F8.2. `req.on('close')` (with `res.destroyed` as the belt-and-braces check Slice 0 already uses) is the signal; the SDK stream gets an `AbortSignal`. Persisting rather than discarding is the whole point: a user who closed the tab mid-reply comes back to what had been written, not to a prompt with no answer. Aborting rather than letting it run to completion is the other half — an orphaned generation still bills. |
| D22 | Is the accumulated text bounded? | **Yes — 800,000 UTF-8 bytes.** Crossing it stops consuming the stream and ends the turn as `done` with `truncated: true`. | A Firestore document is capped at 1,048,576 bytes, and `max_tokens: 64000` can in principle produce more text than fits. Without a cap the failure mode is the worst one available: a generation that succeeded completely, streamed perfectly, and then failed at the write — losing everything the user just watched arrive. The cap converts that into a truncated-but-saved reply. Typical output is ~250 KB, so this only bites on pathological generations. |
| D23 | And `stop_reason: 'max_tokens'`? | **`done`, with `truncated: true`** — not an `error`. | The model produced a real, useful, incomplete answer. Calling that an error would offer a Retry for something that did not fail and would hide the text that did arrive. `truncated` is the one flag both this and D21/D22 set, so the UI has one thing to render. |
| D24 | How is `truncated` stored? | **One flat boolean field, `truncated`, defaulting to `false` on parse**, present on the wire for every message. | Slice 4's stored documents do not have the field, so a default is required for them to keep parsing — and a default on an *absent* field is not the `.catch` D27 of Slice 4 forbids, which is about a *corrupt* one. Rejected: a Zod discriminated union on `role` with the flag only on assistant messages, which is the right instinct in general (`typescript-vue.md`) and buys nothing for a single boolean while doubling the schema a reviewer has to read. |
| D25 | F3.4 says "generation metadata" is persisted. Where? | **In one structured log line**, `generation.complete` — model, stop reason, and the four token counts including `cache_read_input_tokens`. Not in Firestore. | Nothing in the product reads it, and an unread field is a schema to maintain, a wire shape to version and a test to write, for a value whose only consumer is a human debugging. The log is where that human looks anyway, and it is also how the D16 cache claim gets verified in production. F3.4's per-generation record lands in Slice 11, where a snapshot document exists to carry it and is actually read. |
| D26 | Can a failed generation be retried? | **Yes.** An interrupted or failed turn shows **Retry** in the chat panel, which re-opens `POST /generate` for the same project — no new user message. The truncated message **stays**. | F8.2 asks for it in as many words. It is free given D2: the endpoint's whole input is the transcript. Keeping the truncated message is Slice 4's D13 append-only rule holding under pressure — the transcript then reads user → assistant (interrupted) → assistant (complete), which is longer and is what actually happened. Rejected: deleting or overwriting the partial on retry, which is a mutation on an append-only collection and destroys the evidence that an interruption occurred. This is also the case D6 exists for. |
| D27 | Two generations at once for one project? | **Not prevented server-side.** The composer is disabled while a stream is open, which covers the single-tab case. | Two tabs can produce two replies to one prompt. The consequence is a longer transcript ordered correctly by `createdAt`, not corruption — there is no shared mutable state and no counter to contend on. A server-side lock is a document to write, contend on and expire, for a case a user has to work at. Rejected: a `generating` flag on the project document, which turns every generation into a two-collection write and needs a stale-lock policy the moment a function times out holding one. |
| D28 | Idle connections? | **A comment frame every 15 seconds while nothing else is being written.** | `encodeSseComment` has existed unused since Slice 0 for exactly this. Adaptive thinking (D14) means the first token can be seconds away, and an intermediary that closes an idle connection would kill the request during the model's most productive moment. |
| D29 | Function configuration? | **`timeoutSeconds: 540`, `memory: '512MiB'`, `secrets: [ANTHROPIC_API_KEY]`.** | Slice 0 pinned 60 seconds deliberately, saying the long timeout arrives "in Slice 5, together with the ID-token check that makes it safe to grant" — the check is D12, so the grant lands here. 512 MiB because the SDK plus an accumulating string is more than 256 MiB deserves to be tight against. |
| D30 | What does the chat panel say while a stream is open? | **The `Echo mode` badge is replaced by a `Generating…` badge** shown only while a stream is open, and the placeholder bubble renders the accumulated text as it grows. | F6.2's "streaming assistant status", which Slice 4's R7 deferred to exactly here. It also discharges D14's cost: the pause before the first token is a labelled state rather than a frozen screen. `badge` is still used twice, so Slice 4's D19 still holds. `echoFor()` and the badge go together, as Slice 4 said they would. |
| D31 | Where does the accumulating text live? | **A plain `ref<string>` in `useWorkspaceStore`**, re-assigned per token, rendered as one placeholder bubble keyed by a synthetic id. | The store, not the component, for Slice 4 D17's reason — the `lg` breakpoint swaps component trees and would eat mid-stream state exactly as it ate the draft. A `ref<string>` re-assigned per token is the shape `typescript-vue.md` explicitly permits; the trap it warns about is an array of objects pushed to thousands of times, which is why the tokens accumulate into a string and become a `Message` only once, at the terminal event. |
| D32 | How does the stream request get its credentials? | **`authHeaders()` is exported from `frontend/src/lib/apiClient.ts`** and used by both `request` and the stream opener. | `apiClient` exists because the same logic previously lived privately in two clients and the copies diverged. A streaming call cannot use `request` — it must not read the body as JSON — so the choice is to share the credential minting or to repeat it. Sharing. |
| D33 | Where does the SSE parser live on the client? | **`frontend/src/lib/sse.ts`**, a pure function from a byte-chunk sequence to parsed events, with L1 tests that split frames across chunk boundaries. | This is the second-classic SSE bug after the newline one the server already guards: `ReadableStream` chunks have nothing to do with frame boundaries, so `event: to` / `ken\ndata: …` is a normal thing to receive and a naive per-chunk parser drops or corrupts it. It is pure logic, so it is pure logic with a unit test rather than something discovered in an e2e run. |
| D34 | Rate limiting on the endpoint that costs money? | **Out of scope — F10.4 / stretch slice S4.** | The controls that do exist are real: a verified account, App Check attestation, and the 200-message cap, which bounds a single project's spend absolutely. What is missing is a per-user rate limit, and `IMPLEMENTATION_PLAN.md` ranks S4 as cheap. Named here rather than left to be noticed, and carried in Risks. |
| D35 | Does anything change in Firestore's structure? | **No new collection, no rules change, no index change.** `messages` gains one field; the deny-all block already covers it, and `transcriptQuery`'s `createdAt`+`seq` index is unchanged. | Worth stating because the definition of done asks. `seq` still costs nothing: the assistant message is now written in a request of its own, so its `createdAt` genuinely differs from the user message's — which is precisely what Slice 4's D8 predicted. |
| D36 | Slice 4's e2e asserts `You said: …`. What happens to it? | **`tests/e2e/workspace.spec.ts` is updated in place** — the echo assertion becomes a streamed-reply assertion, and the interruption case is added beside it. No second e2e file. | The golden path is the same path; a second spec walking it again to assert one more thing is a duplicate fixture and a duplicate minute of CI. Recorded because deleting `echoFor()` breaks a passing test, and a reviewer should see that as planned rather than as collateral. |
| D37 | Is this one reviewable PR? | **Yes — comparable to Slice 4, and smaller than it in new surface.** One new functions module, one rewritten function, two changed handlers, one schema field, two new frontend library files, one store change, two component changes, plus tests. No new collection, no new rules, no new index, no new vendored components. | Checked deliberately. The mitigation is build order: the boundary first — schemas, then the context builder and the stream mapper as pure functions with L1 tests, then the endpoint, then the client library, then the UI. The security-relevant and hazard-bearing half (D6, D9, D21) is reviewable before a component changes. Everything that would have pushed it over is a named out-of-scope row. |

## In scope

- `functions/src/llm/` — a new module: the Anthropic client factory, the request parameters, the
  system prompt with its `cache_control` breakpoint, the transcript → `messages` context builder
  (including D6's trailing-assistant drop), the SDK-event → `GenerationEvent` mapper, and the
  emulator-only fake
- `functions/src/generate.ts` — rewritten: `withVerifiedUser` + `requireAppCheck`, `.strict()` body
  parse, project 404, context assembly, SSE framing, keep-alives, disconnect handling, terminal
  persistence, the `generation.complete` log line
- `functions/src/index.ts` — the `generate` export gains its secret, timeout and memory (D29)
- `functions/src/messages/handlers.ts` — `handleCreateMessage` writes only the user turn and returns
  it; `echoFor()` and `messagePair()` are deleted; a new `appendAssistantMessage` is used by the
  stream's terminal handler
- `functions/src/messages/schema.ts` — `truncated` on the stored document and the wire shape
- `functions/src/lib/sse.ts` — unchanged in shape; its spec gains the keep-alive and terminal cases
- `tests/fixtures/llm/` — recorded event sequences for the fake (D20)
- `functions/.env.example` — the `ANTHROPIC_API_KEY` comment updated from "Used from Slice 5" to
  the Secret Manager and `.secret.local` instructions actually needed
- `frontend/src/lib/sse.ts` — the client-side frame parser (D33)
- `frontend/src/lib/generateApi.ts` — opens `POST /generate` with shared credentials and yields
  parsed events
- `frontend/src/lib/apiClient.ts` — `authHeaders()` exported (D32)
- `frontend/src/lib/messagesApi.ts` — `truncated` on `Message`; `sendMessage` returns one message
- `frontend/src/stores/workspace.ts` — `generating`, `streamingText`, `generateError`, an
  `AbortController` cleared by `reset()`, `send()` sequencing the two requests, `retryGeneration()`
- `frontend/src/components/workspace/ChatPanel.vue` — the `Generating…` badge, the streaming
  placeholder bubble, the interrupted marker, the generation error with **Retry**
- `frontend/src/components/workspace/MessageComposer.vue` — disabled while a stream is open
- `tests/e2e/workspace.spec.ts` — the echo assertion replaced, the interruption case added (D36)
- `docs/IMPLEMENTATION_PLAN.md` and `docs/PRODUCT_SPEC.md` — status and conformance rows

## Out of scope

| Not here | Picked up by |
|---|---|
| Parsing the output into file operations; `file_start` / `file_end` handling (D8) | Slice 6 |
| The HighLevel cheat-sheet, and any token-budget truncation of context (D5, D17) | Slice 9 |
| Tokens streaming into a code editor; Monaco; read-only-while-streaming | Slice 7 |
| A per-generation snapshot document carrying generation metadata (D25) | Slice 11 |
| An explicit **Stop** button to cancel a running generation | Stretch S2 (F10.2) — D21 handles the *disconnect*, not a deliberate cancel |
| Per-user or per-project rate limiting on `/generate` (D34) | Stretch S4 (F10.4) |
| Server-side refusal fallbacks to another model (D18) | Not planned; a README follow-up |
| A server-side lock preventing concurrent generations for one project (D27) | Not planned |
| Editing, deleting or clearing messages; replacing a truncated message (D26) | Not planned |
| Rendering markdown or code blocks inside a message bubble | Slice 6, where the reply contains code |
| Surfacing token usage or cost in the UI (D25) | Not planned |
| Reconnecting a dropped stream to resume the same generation | Not planned. A dropped stream ends the turn with its partial preserved; **Retry** starts a new one |

## User flow

1. In a project's workspace, the user types "build a contact dashboard" and presses Enter.
2. The composer disables itself. `POST /api/projects/:projectId/messages` writes the prompt; on 201
   the user bubble appears immediately.
3. The store opens `POST /generate` with `{ projectId }`. The chat header shows a `Generating…`
   badge and an empty assistant placeholder bubble appears at the end of the transcript.
4. `token` frames arrive and the placeholder grows character by character; the transcript stays
   scrolled to the bottom.
5. On `done` the placeholder is replaced by the persisted message, the badge disappears, and the
   composer re-enables.
6. If the stream fails or is interrupted, the placeholder is replaced by whatever the server
   persisted — rendered with an "interrupted" marker — and the error appears with a **Retry**
   button. Retry re-opens the stream for the same transcript.
7. If the *message* write fails, nothing is appended, the draft is kept, and the error renders under
   the composer exactly as in Slice 4.
8. Navigating back to the dashboard mid-stream aborts the request; the server persists what it had.
   Returning to the project shows that partial in the transcript.
9. Reloading the page shows the whole transcript from the server, streamed replies included.

## Data model

No new collection. **`users/{uid}/projects/{projectId}/messages/{messageId}`** gains one field:

| Field | Type | Note |
|---|---|---|
| `role` | `'user' \| 'assistant'` | unchanged — server-assigned (Slice 4 D5) |
| `content` | string | unchanged. No maximum on the stored schema; the server caps accumulation at 800,000 UTF-8 bytes (D22) |
| `seq` | number | unchanged — `0` user, `1` assistant. Now genuinely distinct `createdAt` values, so it is belt and braces rather than the tiebreak it was |
| `createdAt` | Timestamp | unchanged |
| **`truncated`** | boolean | **new.** `true` when the reply is incomplete — client disconnect, mid-stream error, `stop_reason: 'max_tokens'`, or the byte cap. Absent on Slice 4's documents and parsed as `false` (D24) |

**Wire shape** (`Message`): `{ id, role, content, createdAt, truncated }`. `seq` still never crosses
the wire.

**Rules:** unchanged. The deny-all block on the messages subcollection already covers a new field,
and its L3 cases are re-asserted because the definition of done says every collection's denial is
proven in the commit that touches it.

**Indexes:** unchanged. `transcriptQuery` still orders by `createdAt` then `seq`, and the composite
index Slice 4 declared is still the one it needs.

## API contracts

Every error body is the existing envelope: `{ "error": "<user-facing message>", "code": "<machine
code>" }`.

### `POST /api/projects/:projectId/messages` — changed

Auth: ID token + `email_verified`. App Check: **required**. Body `.strict()`: `{ content: string }`,
1–4,000 characters after trimming.

- **201** → `{ "messages": [ { "id": "…", "role": "user", "content": "build a contact dashboard",
  "createdAt": "2026-08-17T…Z", "truncated": false } ] }` — **exactly one message**, the user's
  (D4). *Changed from Slice 4, which returned two.*
- **400** `invalid_body` · **400** `invalid_id` · **404** `not_found` · **409** `message_limit`
  (unchanged — the pair still has to fit, so the reply always has room)
- **401** `unauthenticated` · **403** `email_unverified`

### `GET /api/projects/:projectId/messages` — changed

Unchanged except that every message now carries `truncated`.

### `POST /generate` — new

Auth: ID token + `email_verified`. App Check: **required**. Not mounted on the `api` function — its
own function, reached through Slice 0's `/generate` Hosting rewrite (D1).

Body, `.strict()`: `{ "projectId": string }` — matched against `projectIdSchema`.

**Before the response starts** (D9), an ordinary JSON error:

- **401** `unauthenticated` — no or bad token
- **403** `email_unverified`
- **401** `app_check_failed`
- **400** `invalid_body` — unknown key, missing or non-string `projectId`, or one outside
  `[A-Za-z0-9_-]{1,64}`. No Firestore call is made
- **404** `not_found` — project absent, soft-deleted, unreadable, or another user's
- **400** `empty_context` — the assembled context is empty after D6's drop
- **500** `internal` — anything else before the first byte

**On success**, `200` with `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, headers flushed before the body:

```
: keep-alive

event: token
data: {"text":"Here"}

event: token
data: {"text":" is a contact dashboard"}

event: done
data: {"message":{"id":"…","role":"assistant","content":"Here is a contact dashboard","createdAt":"2026-08-17T…Z","truncated":false}}
```

- `token` → `{ text: string }` — one per text delta from the SDK. Thinking deltas are never
  forwarded (D14)
- `done` → `{ message: Message }` — the persisted assistant turn. Always the last frame on a
  successful turn
- `error` → `{ error: string, code: string, message: Message | null }` — codes: `upstream` (the API
  failed mid-stream), `refused` (`stop_reason: 'refusal'`), `internal`. `message` is the persisted
  partial, or `null` when no text had been produced
- comment frames (`: keep-alive`) every 15 s while nothing else is being written (D28)

## Edge cases and failure modes

| Situation | Behaviour | User sees | Retry? |
|---|---|---|---|
| Happy path | `token`* then `done` | Text appearing a few characters at a time, then the finished reply | n/a |
| The message write fails (400/404/409/network) | Nothing appended, draft kept, no stream opened | The server's message under the composer, text still in it | Re-submit |
| The stream fails to open (401/403/404/network) | The user message is already persisted; no assistant message is written | The user's prompt, an error, and **Retry** | Retry |
| Upstream LLM error after N tokens | Partial persisted with `truncated: true`; `error` code `upstream` | The partial reply, an "interrupted" marker, an error, **Retry** | Retry |
| Upstream LLM error before any token | Nothing persisted; `error` with `message: null` | The prompt, an error, **Retry** | Retry |
| `stop_reason: 'refusal'` | Nothing persisted (content is empty); `error` code `refused` | "Claude declined to answer that. Try rephrasing." | Retry after editing |
| `stop_reason: 'max_tokens'` | Persisted with `truncated: true`; `done` (D23) | The long reply with an "interrupted" marker, no error | n/a |
| Accumulated text crosses 800,000 bytes | Consumption stops, SDK stream aborted, persisted `truncated: true`, `done` | As above | n/a |
| Client closes the tab or navigates away mid-stream | `req.on('close')` aborts the SDK stream; partial persisted `truncated: true`; no event emitted (D21) | Nothing at the time. On return, the partial is in the transcript | Retry from the panel |
| User leaves the project and opens another mid-stream | `reset()` aborts the request and bumps the generation counter, so no late event reaches the new project's screen | The second project's own transcript | n/a |
| Transcript ends with an assistant message when generate is called (Retry, or a Slice 4 echo project) | Trailing assistant turns dropped (D6); the request is valid | A normal streamed reply | n/a |
| Every message is an assistant message, or there are none | `400 empty_context` before any LLM call | "There is nothing to generate from yet. Send a message first." | n/a |
| Project deleted in another tab, then a generate | `404 not_found` before the stream opens | "That project no longer exists." with **Retry** absent | n/a |
| Another account's project id in the body | `404` — the path composed from the token's uid names nothing | Same as above | n/a |
| `projectId` is `..`, 65 characters, or contains an illegal character | `400 invalid_body`, no Firestore read | n/a — no UI produces one | n/a |
| A body carrying `content`, `role`, or any other key | `400 invalid_body` under `.strict()` (D2) | n/a | n/a |
| Two tabs generate for one project at once | Both run; two assistant messages, correctly ordered (D27) | A longer transcript | n/a |
| The model thinks for several seconds before its first token | Keep-alive comments hold the connection; the badge reads `Generating…` (D14, D28, D30) | A labelled wait, not a frozen screen | n/a |
| A frame is split across two `ReadableStream` chunks | The client parser buffers and re-joins (D33) | Nothing — it is invisible when correct | n/a |
| No `ANTHROPIC_API_KEY` at runtime | `500 internal` before the stream opens; the reason is logged, not surfaced | "Something went wrong. Please try again." | Retry |
| A client tries the messages collection directly | Denied by `firestore.rules`; the frontend has no Firestore SDK to try with | n/a | n/a |
| Network failure while streaming | The reader throws; the store keeps what arrived and shows an error | The partial, an error, **Retry** | Retry |

## Acceptance criteria

**The endpoint — happy path**

- **AC-1** — Given a verified, attested caller who owns a project holding one user message, when
  they `POST /generate` with `{ projectId }`, then the response is 200 with
  `Content-Type: text/event-stream`, and the body is one or more `token` frames followed by exactly
  one `done` frame.
- **AC-2** — Given the same request, when the stream ends, then exactly one new assistant message
  exists under `users/{uid}/projects/{projectId}/messages`, its `content` equals the concatenation
  of every `token` frame's `text`, its `seq` is `1`, its `truncated` is `false`, and the `done`
  frame's `message` is that document in wire shape.
- **AC-3** — Given a completed generation, when the caller `GET`s the transcript, then the user
  message precedes the assistant message, and both carry `truncated: false`.
- **AC-4** — Given a `POST /api/projects/:projectId/messages` with valid content, then the response
  is 201 with **exactly one** message, `role: "user"`, and **one** document is written — no
  assistant message and no `You said:` text exists anywhere in the codebase or the store.
- **AC-5** — Given a generation completes, then a single structured log line `generation.complete`
  is emitted carrying the model id, the stop reason and the token counts, and carrying no message
  content.

**The endpoint — the LLM call shape**

- **AC-6** — Given the request parameters are assembled, then `model` is `claude-opus-5`,
  `max_tokens` is `64000`, the call is `messages.stream`, and `messages.create` appears nowhere in
  `functions/src`.
- **AC-7** — Given the system prompt is assembled, then it is a block array whose last stable block
  carries `cache_control: { type: 'ephemeral' }`, and no project name, uid, message content or
  timestamp appears in any block at or above that breakpoint.
- **AC-8** — Given a transcript of three user and two assistant messages in chronological order,
  when the context is assembled, then the result is those messages in the same order with `role`
  and text preserved and no `seq`, `id` or `createdAt` field.
- **AC-9** — Given a transcript whose last message is an assistant message, when the context is
  assembled, then that message and any assistant messages immediately before it are absent and the
  last element has `role: "user"`.
- **AC-10** — Given a transcript containing only assistant messages, and given an empty transcript,
  when the caller `POST`s `/generate`, then the response is `400 empty_context`, no LLM call is
  made, and no message is written.
- **AC-11** — Given a stream of SDK events containing thinking deltas and text deltas, when they are
  mapped, then only the text deltas become `token` events.

**The endpoint — interruption and failure (F4.3, F8.2)**

- **AC-12** — Given the LLM fails after two text deltas, when the caller reads the stream, then two
  `token` frames arrive followed by exactly one `error` frame with code `upstream`, and a single
  assistant message exists carrying those two tokens' text with `truncated: true`, and the `error`
  frame's `message` is that document.
- **AC-13** — Given the LLM fails before any text delta, then the stream ends with one `error` frame
  whose `message` is `null`, and no assistant message is written.
- **AC-14** — Given the model answers with `stop_reason: 'refusal'`, then the stream ends with one
  `error` frame with code `refused`, and no assistant message is written.
- **AC-15** — Given the model stops with `stop_reason: 'max_tokens'`, then the stream ends with
  `done`, and the persisted message has `truncated: true`.
- **AC-16** — Given the accumulated text would exceed 800,000 UTF-8 bytes, when the limit is
  reached, then consumption stops, the SDK stream is aborted, the stream ends with `done`, and the
  persisted message is `truncated: true` and no larger than the limit.
- **AC-17** — Given a client that reads two `token` frames and then destroys the connection, when
  the server observes the close, then the SDK stream is aborted, an assistant message carrying the
  text produced so far is persisted with `truncated: true`, and no further frame is written to the
  dead socket.
- **AC-18** — Given a client that disconnects before any text was produced, then no assistant
  message is written.
- **AC-19** — Given a stream that produces nothing for longer than the keep-alive interval, then at
  least one comment frame is written before the first `token`.

**The endpoint — the boundary**

- **AC-20** — Given a request with no `Authorization` header, then the response is `401
  unauthenticated`, the body is JSON rather than an event stream, and no message is written.
- **AC-21** — Given a token whose `email_verified` is false, then the response is `403
  email_unverified` as JSON, and no message is written.
- **AC-22** — Given verified users alice and bob, and bob owns a project, when alice `POST`s
  `/generate` for bob's project id, then the response is `404 not_found` as JSON and bob's
  transcript is unchanged.
- **AC-23** — Given a soft-deleted project id, and a never-existing one, then `/generate` answers
  `404 not_found` and writes nothing.
- **AC-24** — Given a body carrying an extra key (`content`, `role`, `uid`), a missing `projectId`,
  a non-string one, or one outside `[A-Za-z0-9_-]{1,64}`, then the response is `400 invalid_body`,
  no Firestore read is attempted and no LLM call is made.
- **AC-25** — Given the `api` function's router table and the `generate` function, then `/generate`
  carries both the verified-user wrapper and the App Check guard, and `POST
  /api/projects/:projectId/messages` still carries both.

**Rules — the backstop**

- **AC-26** — Given any client — the owner, another signed-in user, an anonymous one — when it
  reads, lists, creates, updates or deletes `users/{uid}/projects/{projectId}/messages/{messageId}`,
  then every operation is denied, `truncated` field included.
- **AC-27** — Given any client, when it touches `users/{uid}`, `users/{uid}/projects/{projectId}`,
  `hlConnections/{uid}` or `authThrottle/{key}`, then it is denied — re-asserted.

**Frontend — the SSE client**

- **AC-28** — Given a byte stream whose frames are split at arbitrary chunk boundaries — mid-`event:`
  line, mid-`data:` line, mid-terminator — when it is parsed, then the events emitted are exactly
  the events encoded, in order.
- **AC-29** — Given a stream containing a comment frame, an unknown event name, and a `data` line
  that is not valid JSON, when it is parsed, then the comment and the unknown event are ignored and
  the malformed frame does not throw or desync the parser.
- **AC-30** — Given `generateApi` opens a stream, then the request is a `POST` to `/generate` with a
  JSON body of `{ projectId }`, an `Authorization: Bearer` header and an App Check header, and no
  `firebase/firestore` import exists anywhere under `frontend/src`.
- **AC-31** — Given the response is not ok, then `generateApi` rejects with an `ApiError` carrying
  the server's message and status, and yields no events.

**Frontend — the store**

- **AC-32** — Given a draft and a project, when `send()` runs, then `POST
  /api/projects/:projectId/messages` is issued first and the returned user message is appended,
  then `POST /generate` is issued, and **no `GET` of the transcript is issued**.
- **AC-33** — Given the message write rejects, then no stream is opened, nothing is appended, the
  draft is kept, and `sendError` is set.
- **AC-34** — Given `token` events arrive, then `streamingText` grows to their concatenation and
  `messages` is unchanged; given `done`, then the returned message is appended, `streamingText` is
  cleared and `generating` is false.
- **AC-35** — Given `error` with a `message`, then that message is appended and `generateError` is
  set; given `error` with `message: null`, then nothing is appended and `generateError` is set. In
  both cases `streamingText` is cleared and `generating` is false.
- **AC-36** — Given `retryGeneration()` is called, then `POST /generate` is issued and **no message
  write** is issued.
- **AC-37** — Given a stream is open, when `reset()` runs or another project is opened, then the
  request is aborted and no later event mutates the store — `messages`, `streamingText` and
  `generating` all belong to the newly opened project.

**Frontend — the chat panel and composer**

- **AC-38** — Given a stream is open, when the chat panel renders, then a badge reads
  `Generating…`, a placeholder bubble shows the accumulated text, and no `Echo mode` badge exists
  anywhere in the app.
- **AC-39** — Given a stream is not open, then no `Generating…` badge is rendered.
- **AC-40** — Given a message with `truncated: true`, when its bubble renders, then it carries a
  visible interrupted marker; given `truncated: false`, then it does not.
- **AC-41** — Given `generateError` is set, then the chat panel shows the message and a **Retry**
  button, and clicking it calls `retryGeneration()` exactly once.
- **AC-42** — Given a stream is open, then the composer is disabled and pressing Enter issues no
  request; given the stream ends, then it is enabled again.
- **AC-43** — Given tokens arrive, then the scroll viewport's `scrollTop` equals its `scrollHeight`
  — the growing reply stays in view.

**End to end**

- **AC-44** — Given a verified account with a project, when the user sends "build a contact
  dashboard", then text appears in the chat panel progressively, a reply is present when the stream
  ends, and after a reload the same reply is still there; and when a generation is interrupted
  mid-stream, then the partial reply is on screen with an interrupted marker and a **Retry** that
  produces a second reply.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1, AC-2 | L4 | `tests/integration/generate.spec.ts` | The frame sequence, and the document the `done` frame describes |
| AC-3 | L4 | `tests/integration/generate.spec.ts` | Transcript order and `truncated` after a real streamed turn |
| AC-4 | L4 | `tests/integration/messages.spec.ts` | `POST` returns one message and writes one document |
| AC-4 | L1 | `functions/src/messages/handlers.spec.ts` | `echoFor`/`messagePair` are gone; the user document's shape |
| AC-5 | L1 | `functions/src/generate.spec.ts` | The `generation.complete` line's fields, and that it carries no content |
| AC-6 | L1 | `functions/src/llm/params.spec.ts` | Model, `max_tokens`, effort, and a source scan for `messages.create` |
| AC-7 | L1 | `functions/src/llm/prompt.spec.ts` | The breakpoint sits on the last stable block; nothing volatile above it |
| AC-8, AC-9 | L1 | `functions/src/llm/context.spec.ts` | Order and shape; trailing assistant turns dropped |
| AC-10 | L1 | `functions/src/llm/context.spec.ts` | Assembly yields empty for both inputs |
| AC-10 | L4 | `tests/integration/generate.spec.ts` | `400 empty_context` over the wire, nothing written |
| AC-11 | L1 | `functions/src/llm/stream.spec.ts` | Thinking deltas produce no `token` |
| AC-12, AC-13 | L4 | `tests/integration/generate.spec.ts` | `__fail_midstream` and its pre-token variant, with the persisted partial |
| AC-12 | L1 | `functions/src/llm/stream.spec.ts` | The mapper's error event carries the text produced so far |
| AC-14 | L4 | `tests/integration/generate.spec.ts` | `__refuse` → one `error` frame, code `refused`, nothing written |
| AC-15, AC-16 | L1 | `functions/src/llm/stream.spec.ts` | `max_tokens` and the byte cap both end in `done` with `truncated` |
| AC-16 | L4 | `tests/integration/generate.spec.ts` | The cap enforced end to end against `__long` |
| AC-17, AC-18 | L4 | `tests/integration/generate.spec.ts` | Client aborts against `__slow`; partial persisted or not, by case |
| AC-19 | L4 | `tests/integration/generate.spec.ts` | A comment frame precedes the first token on `__slow` |
| AC-19 | L1 | `functions/src/lib/sse.spec.ts` | The comment frame's bytes (existing case, retained) |
| AC-20, AC-21 | L4 | `tests/integration/generate.spec.ts` | 401 and 403 as JSON, not as a stream |
| AC-22, AC-23 | L4 | `tests/integration/generate.spec.ts` | Cross-tenant, soft-deleted and never-existed → 404 |
| AC-24 | L1 | `functions/src/llm/schema.spec.ts` | `.strict()` body: extra keys, missing, wrong type, malformed id |
| AC-24 | L4 | `tests/integration/generate.spec.ts` | The same refusals over the wire, nothing written |
| AC-25 | L1 | `functions/src/index.spec.ts` | The deployment surface: `generate`'s guards and its secret binding |
| AC-26, AC-27 | L3 | `tests/rules/firestore.spec.ts` | Every client operation on messages denied; existing denials re-asserted |
| AC-28, AC-29 | L1 | `frontend/src/lib/sse.spec.ts` | Split-chunk reassembly; comments, unknown events and bad JSON ignored |
| AC-30, AC-31 | L1 | `frontend/src/lib/generateApi.spec.ts` | Method, path, body, headers; a non-ok response rejects with `ApiError` |
| AC-30 | L1 | `frontend/src/lib/no-firestore.spec.ts` | Existing scan, unchanged |
| AC-32, AC-33 | L1 | `frontend/src/stores/workspace.spec.ts` | Request order; a failed write opens no stream and keeps the draft |
| AC-34, AC-35 | L1 | `frontend/src/stores/workspace.spec.ts` | Accumulation, and both terminal events including the `null` partial |
| AC-36, AC-37 | L1 | `frontend/src/stores/workspace.spec.ts` | Retry writes no message; abort on `reset()` and on reopening |
| AC-38, AC-39, AC-40, AC-41, AC-43 | L2 | `frontend/src/components/workspace/ChatPanel.spec.ts` | Badge, placeholder, interrupted marker, error + Retry, scroll |
| AC-42 | L2 | `frontend/src/components/workspace/MessageComposer.spec.ts` | Disabled while generating; Enter issues nothing |
| AC-3, AC-40 | L1 | `frontend/src/lib/messagesApi.spec.ts` | `truncated` parsed off the wire; `sendMessage` returns one message |
| AC-44 | L5 | `tests/e2e/workspace.spec.ts` | Send → progressive text → reply → reload; then interrupt → partial + Retry |

## Definition of done

- [ ] Every acceptance criterion above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`,
      `test:e2e`
- [ ] `messages.stream()` is the only LLM call shape in the codebase; `messages.create` appears
      nowhere in `functions/src` (AC-6) — a `grep` at review, because streaming is a brief
      requirement rather than a preference
- [ ] The `cache_control` breakpoint is declared, and the review notes explicitly that it is a
      **no-op until Slice 9** because `claude-opus-5`'s minimum cacheable prefix is 512 tokens and
      nothing errors when a prefix is shorter (D16)
- [ ] `ANTHROPIC_API_KEY` is bound as a secret on the `generate` function; no key in source, no key
      in `functions/.env`; `functions/.env.example` documents the Secret Manager and
      `.secret.local` paths
- [ ] The LLM is stubbed in every automated test, gated on `FUNCTIONS_EMULATOR` alone (D20) —
      verified by reading the gate, since no test can prove the negative
- [ ] Error paths from `PRODUCT_SPEC.md` F8 handled for this surface: every row of the failure table
      has a user-facing message, and F8.2's partial-preservation and retry are both tested
- [ ] The chat panel's streaming state ships with the loading, empty and error states Slice 4 built,
      all still passing
- [ ] `users/{uid}/projects/{projectId}/messages/{messageId}` denial re-asserted at L3 after the
      schema change
- [ ] No `firebase/firestore` import anywhere under `frontend/src`
- [ ] Runs clean on `npm run dev` (emulators) from a fresh clone, including a streamed reply from
      the fake through the Vite dev proxy (R3)
- [ ] `IMPLEMENTATION_PLAN.md` §0 status, §4 Slice 5, §8's LLM-provider row and §9's rows for
      F3.1, F4.1–4.3, F6.2, F6.5 and F8.2 updated
- [ ] `PRODUCT_SPEC.md` §7.1's `@anthropic-ai/sdk` row marked shipped
- [ ] README delta: the `ANTHROPIC_API_KEY` setup step is new — note it for Slice 13's README work
- [ ] PR opened with demo evidence, including a recording of text arriving progressively;
      **human approves before merge**

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **A trailing assistant message is a prefill, and prefill is a 400 on `claude-opus-5`.** The shape arises on exactly the path that matters least to break and most to work: Retry after an interruption, and any project still carrying Slice 4's echoes. Untreated, the recovery button is the thing that fails. | D6's drop rule, asserted twice: L1 over a synthetic transcript ending in one and in several assistant turns, and L4 by streaming, interrupting, and retrying against the fake. D7 covers what the drop can leave behind. |
| R2 | **A generation may outlive what the path in front of it tolerates.** Firebase Hosting fronts the rewrite and Cloud Run fronts the function; a multi-minute turn risks being cut somewhere we cannot observe from the emulator — the same shape as Slice 3's and 4's missing-index risk, where every test passes and production is where it shows. | Three levers, all cheap: headers are flushed before the first byte (Slice 0 proved this survives the rewrite), keep-alive comments hold an idle connection (D28), and `effort: 'low'` (D15) keeps a turn short. If a deployed generation is still cut, the documented fallback is `VITE_FUNCTIONS_BASE_URL` pointing the SPA straight at the function URL, bypassing Hosting — which is why that variable exists. Verified by hand against the deploy in Slice 13, and named in its checklist rather than pretended into a test. |
| R3 | **The Vite dev proxy is between the browser and the stream in development, and Slice 0 never proved it streams unbuffered.** Slice 0's evidence was the Hosting rewrite. A buffering dev proxy would make every local demo look broken while production was fine — or teach us to "fix" something that is not wrong. | It is in the definition of done as a fresh-clone check, and the e2e suite runs the SPA through that proxy, so a fully buffered stream shows up as an e2e failure on the progressive-text assertion (AC-44) rather than as a mystery. |
| R4 | **The client's SSE parser will be handed frames split at arbitrary byte offsets**, and the naive version passes every hand-written test because hand-written chunks are whole frames. | D33 puts the parser in its own module with L1 tests that split deliberately — mid-field-name, mid-JSON, mid-terminator — and drive it from a chunk sequence rather than a string. |
| R5 | **Generation costs money, and the only limits are a verified account, App Check and the 200-message cap.** A compromised session can spend. | Bounded rather than solved, and named: the cap makes any single project's spend finite, attestation stops a scripted caller outside the app, and rate limiting is stretch S4 (D34). Recorded so the gap is a decision rather than an oversight. |
| R6 | **The stream has two failure channels and one of them cannot use a status code.** A handler that throws after `flushHeaders()` writes an unparseable response; one that flushes too early loses the ability to answer 401 or 404. | D9 makes the boundary explicit and orders the handler around it: every cheap refusal is decided before the flush. The L4 suite asserts both channels — 401/403/404/400 as JSON with a status (AC-20 to AC-24), and mid-stream failures as `error` frames on a 200 (AC-12 to AC-14). |
| R7 | **`truncated` is a new field on documents Slice 4 already wrote**, which do not have it. A required field would make every existing message unreadable and silently empty every transcript created before this slice. | D24's parse default, with an L1 case that parses a Slice-4-shaped document and gets `truncated: false`, and an L4 case that seeds one and reads it back through the route. |
| R8 | **`output_config.effort` and `thinking` are recent parameters, and the installed SDK's typings may lag them.** The tempting fix is a cast, which is exactly what this codebase's standards forbid. | The plan picks the SDK version explicitly and, if a parameter is untyped, passes it the documented way with a comment naming why — not an `as`. It is a typecheck failure, so it cannot be missed. |
| R9 | **The `Echo mode` badge and `echoFor()` are load-bearing in Slice 4's tests**, including its e2e. Deleting them turns green tests red in a way that reads like a regression. | D36 records the change and its scope: Slice 4's e2e assertion becomes a streamed-reply assertion in the same file, and `handlers.spec.ts` loses the echo cases. The build order puts these edits in the same commit as the behaviour that replaces them. |

## Blocked

Nothing. Every question this slice raises is answered above.
