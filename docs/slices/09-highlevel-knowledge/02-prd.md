# Slice 09 — HighLevel knowledge injection · PRD
**Spec:** F3.2 (and the last owed half of F3.1) · **Branch:** `slice/09-highlevel-knowledge` · **Depends on:** 8, 6 · **Date:** 2026-08-18

## Problem

Genesis generates working web apps, and none of them can talk to the CRM. The model is
told what Genesis is and how to write files (Slices 5, 6) and is told nothing at all about
HighLevel — so "build a contact dashboard" produces a dashboard over data it invents, or
over a URL it guessed. Meanwhile the context it *is* given is the chat transcript alone:
the project's own files are never sent, so the second prompt in a project cannot modify
what the first one wrote, and nothing bounds how much of a 200-message transcript is spent
on every call.

This is the slice the assignment is judged on. `PRODUCT_SPEC.md` §1 states the
differentiator in one sentence — "the AI doesn't generate generic web apps — it generates
apps that talk to the HighLevel platform" — and F3.2 is the mechanism: HighLevel API
knowledge in the system prompt, so generated code calls real endpoints.

## The demo

Type "build a contact dashboard with a list of upcoming appointments" into a project, watch
the files stream into the editor, open `app.js`, and read
`await hl('POST', '/contacts/search', { pageLimit: 20 })` — a route the proxy actually
allows, with no invented URL, no token, and no `locationId`.

## Decisions

Made from `PRODUCT_SPEC.md`, `HIGHLEVEL_PLATFORM.md`, `IMPLEMENTATION_PLAN.md` and the
merged slice docs, because this stage ran unattended (`--fast`). Each is the answer an
interview would have produced, with the alternative it beat.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Cheat-sheet in the system prompt, or tool-calling? | **Cheat-sheet.** This closes `IMPLEMENTATION_PLAN.md` §8's last open decision, which was "🟡 open, leaning cheat-sheet". | Tool-calling would have the model *call* HighLevel during generation; what we need is code that calls HighLevel *later*, from a browser. A cheat-sheet is deterministic (the same bytes every request), cacheable behind the `cache_control` breakpoint Slice 5 already declared, and adds no round trips to a stream whose first token already waits on thinking. Tool-calling adds latency, non-determinism and a second failure surface for zero benefit to the generated artefact. |
| D2 | Where does the endpoint list come from? | **Rendered at module load from `HL_ROUTES`** (`functions/src/hl/routes.ts`), never restated. | Slice 8 D2 exported the allowlist as *data* precisely so this slice could render it; `HIGHLEVEL_PLATFORM.md` §8 says "one table, three consumers". A hand-written copy would drift on the first allowlist change, and the failure mode is the worst one available: the model confidently generating a route the proxy answers `403` on. AC-1/AC-2 assert the correspondence in both directions. |
| D3 | Does the disabled `POST /conversations/messages` row appear? | **No — rows are filtered by `isRouteEnabled(row, process.env)` at module load.** With `HL_ALLOW_MESSAGE_SEND=true` it appears; in every real environment it does not. | Teaching a route that answers `403 route_disabled` produces apps that break on the one action a user would try. Reading the environment once at module load keeps the prompt a constant within a process, so the cached prefix is stable (D18); flipping the flag changes the prefix and costs one cache write, which is correct rather than a bug. Rejected: omitting flagged rows unconditionally — then enabling the flag grants a capability the model never uses. |
| D4 | What calling convention is taught? | **`await hl(method, path, payload?)`** — payload is the query string on `GET`, the JSON body on `POST`/`PUT`. **No HighLevel origin and no `/api/hl/proxy` string appears in the prompt at all.** | `HIGHLEVEL_PLATFORM.md` §8: "Do not put raw HighLevel URLs in the system prompt — generated code cannot reach them." The signature is already implemented, argument for argument, in `frontend/src/lib/hlProxyApi.ts`, whose header says Slice 9 teaches this exact string and Slice 10's shim mirrors it. Teaching the proxy path instead would invite `fetch('/api/hl/proxy/...')` from an opaque-origin iframe, which cannot attest and cannot carry the ID token (Slice 8 D16). AC-4 asserts both absences. |
| D5 | What does a failed `hl()` call look like to generated code? | **It rejects.** The error carries `message` (a sentence to show the user), `status`, and `code` — one of `proxyError.ts`'s stable codes, rendered into the prompt from that module. The prompt tells the model to `try`/`catch` every call, show `message`, and on `hl_reconnect_required` tell the user to reconnect HighLevel. | F8.3 is "failed HL calls surfaced clearly", and the brief names the expired-connection case explicitly. A rejection is the idiom every JS developer already wraps in `try`/`catch`; a result union would be silently ignored by generated code that forgot to check. **Constraint Slice 10 inherits:** the shim's rejection must carry `code`; today `ApiError` carries only `message` and `status`. Recorded in *Constraints later slices inherit*. |
| D6 | How much of `/contacts/search`'s filter DSL do we teach? | **Only the verified minimum** — `{ pageLimit, page }` — plus an explicit instruction that the filter grammar is not documented here and that the app should request a page and filter it in the browser rather than guess. | `HIGHLEVEL_PLATFORM.md` §6.1 and §10 item 4 mark the `filters`/`sort` grammar ⚠️ unverified, and Slice 8 R6 left it to this slice. Teaching a guessed DSL yields a `400` the user reads as "Genesis is broken". Teaching the verified shape yields an app that works and is merely less clever. Rejected: transcribing the community-sourced grammar — the one thing §6.1 says is "the single most important thing to get right", and we cannot verify it without credentials this session does not have. |
| D7 | `/calendars/events` time format? | **Epoch milliseconds**, stated in the prompt with the trap named: ISO-8601 returns `{"events":[]}` with HTTP 200. | Settled and measured in `HIGHLEVEL_PLATFORM.md` §6.3 / §10 item 3. It is the highest-value line in the cheat-sheet, because the wrong format is indistinguishable from an empty calendar — an app that silently shows nothing, in the demo. |
| D8 | Does generated code ever send `locationId`? | **Never**, stated as a rule naming the key. | Slice 8 P1 removes `locationId` from the query and the body of *every* row and re-adds it from the connection. A model that sends one is not wrong, but it is writing code whose most visible parameter is silently discarded — and a reader of that code would conclude the app is multi-location when it is not. |
| D9 | The N+1 instruction Slice 8 D34 assigned here. | **A hard rule in the cheat-sheet:** use the list/search endpoint and render from its results; never one request per row. The burst ceiling (100 requests / 10 seconds per location) is named so the rule reads as arithmetic rather than taste. | `HIGHLEVEL_PLATFORM.md` §5: the burst limit "is reachable if generated code renders a contact list and then fires one `GET /contacts/{id}` per row — a very plausible LLM output". Slice 8 D34/R7 explicitly deferred the fix to this slice's prompt; per-user quota stays stretch S4. |
| D10 | Response-shape examples? | **Yes — one trimmed record per surface, hand-authored from `tests/fixtures/highlevel/`,** with an L1 test asserting every field name used in an example also appears in the corresponding recorded fixture. | §9's closing note: "real payloads beat prose, and they're what makes generated code render real data on the first try." Pasting the raw fixtures (8–20 KB each) would triple the prompt for fields no dashboard reads. The fixture-conformance test is what stops the trimmed version from becoming fiction. |
| D11 | Where do the project's files go in the request? | **A second `system` block, appended after the `cache_control` breakpoint.** A project with no files produces no extra block at all. | Volatile content must sit after the last breakpoint or the cached prefix dies (`shared/prompt-caching.md`: render order is `tools` → `system` → `messages`; a change anywhere in the prefix invalidates everything after it). Rejected: a synthetic leading `user` message — it invents a turn in a transcript whose whole value is being a true record (Slice 5 D6's reasoning). Rejected: a mid-conversation `{role:'system'}` message in `messages[]` — supported on `claude-opus-5` and genuinely the operator channel, but it buys nothing here (the transcript is not cached, so both placements are equally cache-safe), it is model-gated, and the SDK's `MessageParam` role union would force a cast, which `CLAUDE.md` rules out in favour of `satisfies`. |
| D12 | One context budget or two? | **Two independent budgets** — one for project files, one for the transcript — measured in characters, with tokens estimated at 4 characters per token. | A single pooled budget makes a long conversation able to evict the code, which is precisely the context F3.2 exists to preserve. Two budgets make each failure mode local and each test independent. Characters rather than tokens because an exact count needs `messages.count_tokens`, i.e. a network round trip and a charge on every generation, to decide something a conservative estimate already decides safely. |
| D13 | The numbers. | **Project files: 120,000 characters (~30,000 tokens). Transcript: 80,000 characters (~20,000 tokens).** | The worst cases are 20 × 100 KB = 2 MB of files (~500k tokens) and 200 × 4,000 = 800 KB of transcript (~200k tokens); at $5/M input that is a dollar a generation for context nobody reads. A realistic generated app is 3–6 files totalling 20–120 KB, so the file budget truncates only pathological projects, and 80,000 characters of transcript is at minimum twenty full-length turns. Both are exported constants, so re-tuning is one edit and a test. |
| D14 | Which files, when they do not all fit? | **Whole files only, never a fragment.** `index.html` first when it exists, then the rest by ascending size. Files that do not fit are still listed — path and size — under a line saying they exist and were not included. | A truncated file is the hazard the slice must not ship: the model completes it from imagination and writes the whole thing back, so a file the user never touched is silently rewritten. Ascending size maximises the number of complete files. `index.html` is the entry point (Slice 6 D1), so it is the one file whose absence changes what the app *is*. Listing the omissions stops the model from concluding a file does not exist and creating a second one under a different name. |
| D15 | Which messages, when the transcript does not fit? | **Trimmed from the oldest end, newest kept.** Then any **leading** assistant messages are dropped. | Order matters and this is the slice's second hazard: the Messages API requires the first message to be `user`, and trimming from the front lands on an assistant turn roughly half the time. Untreated it is a `400 invalid_request_error` that reaches the user as "generation failed" — and only on long conversations, which no fixture-sized test would reach. Slice 5 D6's trailing-assistant drop still runs first and is unchanged. |
| D16 | Can trimming empty the context? | **No.** The newest user message is always kept, whatever the budget says. | `handleGenerate` answers `400 empty_context` on an empty context (Slice 5 D7), and a project whose last message overflowed the budget would hit it permanently. It cannot happen in practice — `CONTENT_MAX` caps one message at 4,000 characters against an 80,000-character budget — but the guarantee is one line and the alternative is an unrecoverable project. |
| D17 | Re-tune `output_config.effort` (Slice 5 D15). | **`high`**, up from `low`. | `low` was chosen when this slice generated prose; it now generates code against a fifteen-hundred-token cheat-sheet. `high` is the documented minimum for intelligence-sensitive work and is the API default. Rejected: `xhigh`, which the docs name as the starting point for coding — it lengthens the pause before the first token, and the visible thing in this project's demo is *tokens appearing*, with R2 (the Hosting-rewrite window) still only argued rather than measured. Choosing between `high`, `xhigh` and `max` properly needs an effort sweep against real generations, which needs credentials this session does not have; the sweep is named in the definition of done as a manual check. `max_tokens` stays 64,000, which the docs call the floor for `high` and above. |
| D18 | Does the `cache_control` breakpoint become real? | **Yes**, and that is asserted rather than hoped: the stable prefix must estimate to at least 1,024 tokens, twice `claude-opus-5`'s 512-token cacheable minimum. | Slice 5 D16 recorded the breakpoint as a declared no-op "until Slice 9", because the prefix was far under the minimum and nothing errors when a prefix is too short — `cache_creation_input_tokens` and `cache_read_input_tokens` simply both read `0`. The cheat-sheet crosses it. The estimate is not the tokenizer, hence the 2× margin; the real confirmation is `cache_read_input_tokens > 0` on the second generation of a session, which the `generation.complete` log line already carries and the definition of done checks by hand. |
| D19 | How do we know the differentiator works at all? | **A pure `extractHlCalls(code)`**, used by the golden-fixture test *and* wired into `generation.complete` as two counters: how many extracted calls match an allowlisted route and how many do not. | F3.4 already puts generation metadata in a log line, and this is the one metric that says whether F3.2 landed. The counters carry no user content — they are two integers — which keeps `GenerationLogContext`'s existing guarantee that nothing a user or the model wrote reaches Cloud Logging. Rejected: keeping the extractor test-only, which leaves the project with no signal at all outside a fixture. |
| D20 | Can we record a golden reply from the real model? | **No — the fixture is hand-authored** to the shape the prompt specifies, and says so in its own file. The real-model check is a definition-of-done item, discharged by hand with credentials. | This session has no `ANTHROPIC_API_KEY`; the same constraint left Slice 8's sandbox `curl` in the PR rather than in a checklist. Stated plainly so nobody reads the fixture as evidence about the model: **the L1 prompt tests assert what the model is told, and no automated test in this repo can assert what the model does.** |
| D21 | Does this slice add a screen? | **No.** The demo runs entirely through the chat panel and the editor that Slices 4–6 shipped. | The plan's own demo line for Slice 9 is "'build a contact dashboard' produces code that calls the Contacts route" — the visible change is what the model writes, not a new surface. The definition of done's loading/empty/error requirement is therefore satisfied vacuously, and that is stated rather than quietly skipped. The vertical proof is the e2e (AC-26): a prompt, in the real UI, ending in HighLevel-shaped code in the editor. |
| D22 | Should `/generate` refuse when no HighLevel account is connected? | **No**, and the model is not told the connection state either. | It would add a Firestore read per generation and a volatile field to the prompt in exchange for prose. A user may legitimately want a static page, and the failure they would actually hit is already handled where it happens: the proxy answers `409 hl_not_connected` with a clear sentence (Slice 8), the dashboard shows a **Reconnect HighLevel** button, and Slice 10 surfaces the failure inside the preview. |
| D23 | Anything else in the call shape? | **Unchanged.** `claude-opus-5`, `client.messages.stream()`, `max_tokens: 64000`, `thinking` omitted (on by default on this model — Slice 5 D14). | `CLAUDE.md`'s non-negotiables. Worth restating because `thinking: { type: 'disabled' }` is rejected outright above effort `high` on `claude-opus-5`, so D17's change is only safe *because* D14 already left thinking on. |
| D24 | Are project-file contents sanitised before they go in the prompt? | **No.** They are delimited by a marker that is deliberately **not** the `<genesis:file>` tag pair, and passed through byte for byte. | The content is the user's own — files reach Firestore only from this user's generations and this user's `PUT` (Slice 6), so there is no cross-tenant path. Sanitising would corrupt the code the model is being asked to modify, which is the whole point of sending it. The distinct delimiter matters for a different reason: a file whose own text contains `</genesis:file>` on a line must not appear to the model as an example of how to close a block it is writing. |
| D25 | How does an integration test see what was sent? | **A new `__context` marker on the emulator-only LLM fake**, which streams back the number of system blocks it received, the number of messages, and the paths it was shown. | The fake's existing markers already put test intent on the page (`__refuse`, `__bad_path`). Without this, budget trimming is provable only at L1 and the wiring between `handleGenerate`, the file read and `buildParams` is proven by nothing. The fake is gated on `FUNCTIONS_EMULATOR` and unreachable in a deploy (Slice 5 D20). |
| D26 | Where does the file content come from? | **A new `readProjectFiles(uid, projectId)` in `functions/src/files/handlers.ts`** — the same query as `readFileList` without the `select(...)` projection, parsed with `storedFileSchema`. | `readFileList` is deliberately a projection with no `content` (Slice 6), and widening it would ship 20 × 100 KB to every workspace that opens. A second reader beside it, sharing the ordering, the `FILE_LIMIT` and the unreadable-document logging, is one function rather than a second answer to "what files does this project hold". |

## In scope

- A HighLevel section in the system prompt's stable prefix: the `hl()` calling convention,
  the allowlist rendered from `HL_ROUTES`, per-surface parameter notes, trimmed response
  shapes, the error contract, and the N+1 rule.
- The `cache_control` breakpoint moved to the end of the new stable prefix, and asserted to
  clear the model's cacheable minimum.
- Project files in the request, as a system block after the breakpoint, within a budget.
- Transcript trimming within a budget, with the leading-assistant guard.
- `output_config.effort` re-tuned to `high`.
- `extractHlCalls` plus two counters on the `generation.complete` log line.
- `readProjectFiles`, and the `__context` marker on the LLM fake.

## Out of scope

| Not here | Where it lands |
|---|---|
| The `srcdoc` shim that *defines* `hl()` at runtime, and the credential bridge into the iframe | Slice 10 (F6.4) — this slice defines the contract the shim must satisfy |
| Surfacing a HighLevel failure inside the preview | Slice 10 (F8.3) |
| `ApiError` gaining `code`, so a rejection can carry the proxy's stable code | Slice 10, as a constraint recorded below |
| Per-user or per-project rate limiting on the proxy | Stretch S4 (F10.4) — Slice 8 D34 |
| The verified `/contacts/search` filter DSL (D6) | Not scheduled. It needs a live token; the README follow-up list is the right home (Slice 13) |
| A second prompt that *modifies* existing code as a distinct mode | Stretch S1 (F10.1). This slice supplies the context iterative refinement needs; it adds no refinement UI or prompt mode |
| Snapshotting the files that were sent as context | Slice 11 (F5.2) |
| Any new screen, and any change to the chat or editor panels | — (D21) |
| Counting context tokens with `messages.count_tokens` | Not scheduled (D12) |

## User flow

1. The user opens a project that already holds `index.html`, `app.js` and `styles.css`.
2. They type "add a section showing this week's appointments" and press send.
3. `POST /api/projects/:projectId/messages` stores the user turn; the workspace opens the
   SSE stream against `POST /generate`.
4. `handleGenerate` reads the project, the transcript and now the project's files.
5. The transcript has its trailing assistant turns dropped, is trimmed to the transcript
   budget from the oldest end, and any leading assistant turns are dropped.
6. The files are ordered — `index.html`, then ascending size — and taken whole until the
   file budget is spent; the rest are listed by name and size only.
7. The request goes out: the stable prefix (identity, file format, HighLevel cheat-sheet,
   breakpoint), then the project-state block, then the trimmed transcript.
8. Tokens stream back. The reply's prose lands in the chat panel; its `<genesis:file>`
   blocks land in the editor as they arrive (Slice 6).
9. The user clicks `app.js` in the tree and reads
   `const res = await hl('GET', '/calendars/events', { startTime, endTime, calendarId })` —
   an allowlisted route, epoch-millisecond times, no `locationId`, wrapped in `try`/`catch`.
10. `generation.complete` records two known `hl()` calls and zero unknown ones.

## Data model

**No new collection, no rules change, no index.** This slice reads
`users/{uid}/projects/{projectId}/files` — which Slice 6 created, whose rules already deny
every client outright, and whose L3 denial tests already exist — with a second reader that
returns `content` where `readFileList` returns a projection. The definition-of-done line
"new Firestore collections have rules and rules tests" is satisfied vacuously and the
existing rules suite is unchanged.

One extra Firestore read per generation: at most 20 documents, ordered by `path`, capped at
`FILE_LIMIT`. It runs after the project ownership check and before the flush, so a failure
is an ordinary 500 with a real status rather than a mid-stream `error` frame (Slice 5 D9).

## API contracts

No new route, and no change to any request or response shape.

`POST /generate` keeps its `{ projectId }` body, its `token` / `file_start` / `file_chunk` /
`file_end` / `done` / `error` frames, and every status it can answer with. What changes is
what the server sends *upstream*:

| Part of the upstream request | Before | After |
|---|---|---|
| `system[0]` | identity and response style | unchanged |
| `system[1]` | file format, `cache_control` here | file format, breakpoint moved off it |
| `system[2]` | — | HighLevel cheat-sheet, **`cache_control` here** |
| `system[3]` | — | project state — present only when the project holds files |
| `messages` | transcript, trailing assistants dropped | also trimmed to budget, leading assistants dropped |
| `output_config.effort` | `low` | `high` |

The contract this slice *defines* for Slice 10 to implement, and teaches the model verbatim:

```js
// The only way a generated app reaches HighLevel.
// Auth and locationId are attached server-side. Never send either.
const page = await hl('POST', '/contacts/search', { pageLimit: 20 })
const events = await hl('GET', '/calendars/events', { startTime, endTime, calendarId })
```

- Third argument: query parameters on `GET`, JSON body on `POST` and `PUT`.
- Resolves with HighLevel's own JSON body, unwrapped (Slice 8 D17).
- Rejects with an error carrying `message` (show it), `status`, and `code` — one of
  `route_not_allowed`, `route_disabled`, `invalid_path`, `hl_reconnect_required`,
  `hl_not_connected`, `hl_forbidden`, `hl_not_found`, `hl_rate_limited`, `hl_bad_request`,
  `hl_unavailable`, `hl_timeout`, `hl_too_large`.

## Edge cases and failure modes

| Case | What happens | User sees | Retry? | AC |
|---|---|---|---|---|
| Project holds no files | No project-state block is appended; the request is byte-identical in shape to today's | Nothing different | — | AC-13 |
| Files exceed the budget | The largest are omitted whole and listed by name and size; nothing is truncated mid-file | Nothing; the model is told the files exist | — | AC-15, AC-17 |
| One file alone exceeds the whole budget | It is omitted, not truncated; the block still renders with the manifest line | Nothing | — | AC-17 |
| Transcript exceeds the budget | Oldest messages dropped; the newest user message always survives | Nothing; the chat panel still shows the whole stored transcript | — | AC-18, AC-21 |
| Trimming leaves an assistant message first | Leading assistant turns are dropped before the request goes out | Nothing — this is the guard that stops a `400` | — | AC-19 |
| Transcript ends on an assistant turn (Retry after an interruption) | Trailing assistant turns still dropped first (Slice 5 D6) | The reply streams; Retry works | — | AC-20 |
| Everything trims away except the newest user message | That message is kept and the generation runs | Normal reply | — | AC-21 |
| A file's content contains `</genesis:file>` | Passed through byte for byte inside a different delimiter | Nothing | — | AC-14 |
| `HL_ALLOW_MESSAGE_SEND` unset (every environment) | `POST /conversations/messages` is absent from the cheat-sheet | The model never writes an app that sends a message | — | AC-3 |
| The file read fails | Ordinary `500` before the flush, with the reason logged | "Something went wrong. Please try again." | Yes | AC-28 |
| The model writes a route that is not allowlisted | The proxy refuses it at runtime with `403 route_not_allowed`; `generation.complete` records it as an unknown call | Handled in the preview, Slice 10 | — | AC-24, AC-25 |
| The cheat-sheet drifts from `HL_ROUTES` | The suite fails in both directions before it can ship | — | — | AC-1, AC-2 |

## Acceptance criteria

**The cheat-sheet**

- **AC-1** — Given the allowlist, when the stable prefix is rendered, then every enabled row
  in `HL_ROUTES` appears in it as its method and its exact `pattern`.
- **AC-2** — Given the stable prefix, when every HighLevel-shaped path in it is matched
  against `matchRoute`, then each one resolves to an enabled row — the prefix names no path
  the proxy would refuse.
- **AC-3** — Given `HL_ALLOW_MESSAGE_SEND` unset, when the prefix is rendered, then
  `POST /conversations/messages` is absent; given it set to `'true'`, then it is present.
- **AC-4** — Given the stable prefix, then it contains neither `services.leadconnectorhq.com`
  nor `/api/hl/proxy`, and it contains `hl('` — the model is taught one function and no URL.
- **AC-5** — Given the stable prefix, then it instructs that `locationId` is never sent,
  naming the key.
- **AC-6** — Given the stable prefix, then it states that `/calendars/events` takes
  `startTime` and `endTime` as epoch milliseconds, and that ISO-8601 returns an empty
  success rather than an error.
- **AC-7** — Given `proxyError.ts`'s code set, then every one of its codes appears in the
  stable prefix, and the prefix instructs the model to catch a rejected `hl()` call and show
  its `message`.
- **AC-8** — Given the stable prefix, then it forbids one request per row and names the
  100-requests-per-10-seconds burst ceiling.
- **AC-9** — Given each response-shape example in the prefix, then every field name it uses
  appears in the corresponding recorded fixture under `tests/fixtures/highlevel/`.
- **AC-10** — Given the stable prefix, then it is a module-level constant containing no
  value computed per call (no date, no id, no interpolated project name).
- **AC-11** — Given the stable prefix, then its estimated token count is at least 1,024 —
  twice `claude-opus-5`'s 512-token cacheable minimum.
- **AC-12** — Given the assembled `system` array, then exactly one block carries
  `cache_control`, and it is the last block of the stable prefix.

**Context assembly**

- **AC-13** — Given a project with no files, when parameters are built, then `system` is the
  stable prefix and nothing else.
- **AC-14** — Given a project with three files, when parameters are built, then `system`
  carries one extra block, positioned after the block holding `cache_control`, containing
  each file's path and its content byte for byte.
- **AC-15** — Given files whose combined content exceeds the file budget, when the block is
  built, then the included files' content sums to no more than the budget, and every omitted
  file is named with its size under a line saying it was not included.
- **AC-16** — Given a project holding `index.html` plus larger and smaller files, when the
  block is built, then `index.html` appears first and the remaining included files appear in
  ascending size order.
- **AC-17** — Given a single file larger than the whole file budget, when the block is
  built, then no fragment of that file appears anywhere in the block.
- **AC-18** — Given a transcript exceeding the transcript budget, when the context is built,
  then the newest messages are kept, the oldest are dropped, and the total kept content is
  within the budget.
- **AC-19** — Given a transcript that, after trimming, would begin with an assistant
  message, when the context is built, then the first message returned has role `user`.
- **AC-20** — Given a transcript ending in an assistant message, when the context is built,
  then that message is absent (Slice 5 D6 preserved) and the result is still non-empty.
- **AC-21** — Given a transcript whose newest user message alone exceeds the budget, when
  the context is built, then that message is returned and the result is not empty.

**Call shape and observability**

- **AC-22** — Given the request parameters, then `output_config.effort` is `high` and
  `max_tokens` is 64,000.
- **AC-23** — Given generated code, when `extractHlCalls` runs over it, then it returns the
  method and path of every literal `hl('METHOD', '/path'` call and returns nothing for text
  containing no such call.
- **AC-24** — Given a completed generation, then `generation.complete` carries the count of
  extracted calls matching an allowlisted route and the count that do not, and carries no
  message content, no file content and no path.
- **AC-25** — Given the golden reply fixture, when every call `extractHlCalls` finds in its
  file blocks is matched against `matchRoute`, then all of them resolve to enabled rows.

**End to end**

- **AC-26** — Given a signed-in, verified user in a project, when they send a prompt and the
  stream completes, then a generated file is readable in the editor and its content contains
  an `hl(` call.
- **AC-27** — Given a project that already holds files, when a generation runs against the
  emulator with the `__context` marker, then the fake reports three system blocks plus a
  project-state block, and reports the paths it was shown.
- **AC-28** — Given the file read fails, when a generation is requested, then the caller
  receives a JSON `500` with the existing envelope and no `text/event-stream` headers were
  sent.

## Test matrix

Every AC appears at least once. L5 is the demo path and adds no new case — it extends the
existing generate walk, as Slice 8 did with the connect walk.

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1 | L1 | `functions/src/llm/hlKnowledge.spec.ts` | Every enabled `HL_ROUTES` row's method and pattern appears in the rendered section |
| AC-2 | L1 | `functions/src/llm/hlKnowledge.spec.ts` | Every path-shaped string in the prefix resolves through `matchRoute` to an enabled row |
| AC-3 | L1 | `functions/src/llm/hlKnowledge.spec.ts` | Flagged row absent with the env unset, present with it `'true'` |
| AC-4 | L1 | `functions/src/llm/prompt.spec.ts` | No HighLevel origin, no proxy path, `hl(` present |
| AC-5 | L1 | `functions/src/llm/hlKnowledge.spec.ts` | The `locationId` prohibition is present |
| AC-6 | L1 | `functions/src/llm/hlKnowledge.spec.ts` | Epoch-millisecond rule and the ISO empty-200 warning present |
| AC-7 | L1 | `functions/src/llm/hlKnowledge.spec.ts` | Every `ProxyErrorCode` appears; the catch-and-show instruction is present |
| AC-8 | L1 | `functions/src/llm/hlKnowledge.spec.ts` | N+1 prohibition and the burst number present |
| AC-9 | L1 | `functions/src/llm/hlKnowledge.spec.ts` | Every example field name appears in the matching recorded fixture |
| AC-10 | L1 | `functions/src/llm/prompt.spec.ts` | Pattern scan for interpolated per-call values (extends the Slice 5 case) |
| AC-11 | L1 | `functions/src/llm/prompt.spec.ts` | `estimateTokens(stable prefix) >= 1024` |
| AC-12 | L1 | `functions/src/llm/params.spec.ts` | Exactly one `cache_control`, on the last stable block |
| AC-13 | L1 | `functions/src/llm/params.spec.ts` | No files → `system` is the stable prefix |
| AC-14 | L1 | `functions/src/llm/projectState.spec.ts` | Extra block after the breakpoint; contents byte-identical, including a file holding a close tag |
| AC-15 | L1 | `functions/src/llm/projectState.spec.ts` | Budget respected; omitted files named with sizes |
| AC-16 | L1 | `functions/src/llm/projectState.spec.ts` | `index.html` first, then ascending size |
| AC-17 | L1 | `functions/src/llm/projectState.spec.ts` | An over-budget file contributes no substring to the block |
| AC-18 | L1 | `functions/src/llm/context.spec.ts` | Oldest dropped, newest kept, total within budget |
| AC-19 | L1 | `functions/src/llm/context.spec.ts` | First message is `user` after trimming lands on an assistant turn |
| AC-20 | L1 | `functions/src/llm/context.spec.ts` | Trailing assistant dropped and result non-empty (regression on Slice 5 D6) |
| AC-21 | L1 | `functions/src/llm/context.spec.ts` | Oversized newest user message survives; result non-empty |
| AC-22 | L1 | `functions/src/llm/params.spec.ts` | `effort: 'high'`, `max_tokens: 64000` |
| AC-23 | L1 | `functions/src/llm/hlCalls.spec.ts` | Extraction over a corpus: multiple calls, none, and near-miss text |
| AC-24 | L1 | `functions/src/generate.spec.ts` | `logGeneration` emits both counters and no content field |
| AC-25 | L1 | `functions/src/llm/hlCalls.spec.ts` | Golden fixture's calls all resolve to enabled rows |
| AC-26 | L5 | `tests/e2e/files.spec.ts` | Existing generate walk additionally asserts `hl(` in the opened file |
| AC-27 | L4 | `tests/integration/generate-context.spec.ts` | `__context` reports the block count and the paths sent |
| AC-28 | L4 | `tests/integration/generate-context.spec.ts` | A failing file read answers a JSON 500, not an SSE frame |

## Definition of done

The checklist from `IMPLEMENTATION_PLAN.md` §3, plus this slice's own:

- [ ] Every acceptance criterion maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`, `test:e2e`
- [ ] No new Firestore collection, so no new rules — stated, and the rules suite unchanged
- [ ] F8 error paths for this surface: the file read's failure is a pre-flush JSON error, and
      the `hl()` error contract is taught in full (AC-7)
- [ ] No new screen, so the loading/empty/error requirement is vacuous — recorded in D21,
      not skipped
- [ ] No secrets in source; `.env.example` unchanged (`HL_ALLOW_MESSAGE_SEND` already documented)
- [ ] Runs clean on `firebase emulators:start` from a fresh clone
- [ ] README delta: none owed here; the allowlist section stays Slice 13's
- [ ] PR opened with demo evidence; **human approves before merge**
- [ ] **Manual, with credentials — one real generation** of "build a contact dashboard with
      a list of upcoming appointments", with the generated `app.js` pasted into the PR. This
      is the only evidence that exists about what the model *does* (D20).
- [ ] **Manual, with credentials — the cache is real.** Run two generations in one session
      and confirm `generation.complete` shows `cacheCreationInputTokens > 0` on the first and
      `cacheReadInputTokens > 0` on the second. This is what retires Slice 5 D16 (D18).
- [ ] **Manual, with credentials — an effort sweep.** Run the same prompt at `high` and
      `xhigh`, record time-to-first-token and the generated code, and note in the PR whether
      D17 should change.

## Constraints later slices inherit

- **Slice 10 owns `hl()`.** The shim must define a global `hl(method, path, payload?)` with
  exactly this slice's semantics: payload as query on `GET` and JSON body otherwise, resolve
  with HighLevel's body unwrapped, reject with `message`, `status` and `code`. The name and
  the argument order are already fixed by `frontend/src/lib/hlProxyApi.ts`; what is new is
  **`code` on the rejection**, which `ApiError` does not carry today (D5). Generated code
  written against this prompt will branch on `err.code === 'hl_reconnect_required'`, and if
  the shim drops the field that branch silently never runs.
- **Slice 10 must not re-teach the URL.** The prompt names no proxy path, so the shim is the
  only thing that knows one. Keep it that way.
- **Slice 11's snapshots and this slice's context are different things.** A snapshot is what
  a generation *wrote*; the project-state block is what it was *shown*, after a budget.
- **Slice 13's README** renders the allowlist from the same `HL_ROUTES` table this slice
  renders into the prompt — the third consumer `HIGHLEVEL_PLATFORM.md` §8 names.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The whole slice is judged on model behaviour no automated test can observe.** The prompt tests assert what the model is told; whether it complies is unverifiable here (D20). | Stated rather than papered over. Three manual checks in the definition of done — a real generation, a cache confirmation, an effort sweep — with the generated code pasted into the PR. The bidirectional allowlist tests (AC-1/AC-2) at least make "the model was told something false" impossible. |
| R2 | **A truncated file would silently rewrite code the user never touched** — the model completes the fragment and writes the whole file back. | D14 makes fragments unrepresentable: files are whole or absent, and absence is announced in a manifest line. AC-17 asserts the negative — no substring of an over-budget file appears anywhere in the block. |
| R3 | **A leading assistant message is a `400`, and it only appears on long conversations.** No fixture-sized test would reach the trimming path that produces it. | D15 makes the guard part of the same function as the trim, and AC-19 drives it with a transcript built to land there. The `__context` marker (D25) puts the same property under an emulator test. |
| R4 | **`/contacts/search`'s filter grammar is still unverified** (`HIGHLEVEL_PLATFORM.md` §10 item 4), and it is the parameter a contact dashboard most wants. | D6 teaches only the verified shape and tells the model to filter a page in the browser. The cost is a less clever app; the alternative is a `400` in the demo. Named as a README follow-up for Slice 13. |
| R5 | **The cheat-sheet is a second place the allowlist can be wrong**, and a wrong line here is worse than a missing one — the model writes it confidently. | D2 makes it rendered data, not prose, and AC-1/AC-2 check both directions. The per-surface *notes* are still hand-written and are the residual exposure; AC-9 ties the response examples to recorded fixtures so at least the shapes cannot be invented. |
| R6 | **Effort `high` lengthens the pause before the first token**, on the one surface whose demo value is tokens appearing. | Keep-alive comments already cover an idle stream (Slice 5 D28) and the `Generating…` badge makes the pause legible. `high` rather than `xhigh` is the conservative half of that trade (D17), and the sweep is a named manual check rather than a guess. |
| R7 | **Prompt-injection through a project's own files.** A file edited via `PUT` can carry instructions the model reads. | Self-injection only: files are uid-scoped and reach the prompt only for their own owner, so there is no cross-tenant path. The controls that matter are downstream and unaffected — the op set is validated and refused whole (Slice 6 D9), and the proxy allowlist decides what any generated code can reach regardless of what it was told (Slice 8 D6). D24 records the decision not to sanitise, and why. |
| R8 | **Two more Firestore reads' worth of latency and one more failure mode** on the path that already reads the project and the transcript. | The file read is capped at 20 documents and happens before the flush, so its failure is an ordinary 500 with a real status rather than a mid-stream frame (AC-28). |
