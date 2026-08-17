# Slice 05 — Streaming generation · Build log

**Plan:** `03-plan.md` (approved) · **PRD:** `02-prd.md` · **Branch:** `slice/05-streaming-generation`
· **Date:** 2026-08-17

Appended as each task lands, not at the end — if this session dies at task 9, this file is what lets
a fresh one pick it up.

## Baseline

`main` at `aaa91bb`, clean. Full suite green before any change:

| Suite | Result |
|---|---|
| `typecheck` | pass |
| `lint` | pass (0 warnings) |
| `test:unit` | 286 functions + 451 frontend + 11 scripts |
| `test:rules` | 26 |
| `test:integration` | 198 |
| `test:e2e` | 9 |

## T1 — `truncated` on the message schema

**Commit:** `72845dc`

**Tests added**

| Level | File | What |
|---|---|---|
| L1 | `functions/src/messages/schema.spec.ts` | A Slice-4-shaped document (no `truncated` key) parses to `truncated: false`; `true` round-trips; `'yes'`, `1` and `null` all fail the parse; `toMessage` carries the flag and still omits `seq` |
| L4 | `tests/integration/messages.spec.ts` | The wire key list is now the five, every message carries `truncated: false`, and the seeded document is Slice-4-shaped — so the default is proven over the wire, not only in a unit |

**Green:** `truncated: z.boolean().default(false)` on `storedMessageSchema`, the field on `Message`,
`toMessage` carrying it.

**Deviation from the plan.** The plan put the integration wire-key edit in T2. It has to be in T1:
the moment `toMessage` gains a key, `messages.spec.ts`'s `Object.keys(...).sort()` assertions fail,
and a task that leaves a suite red so a later one can fix it is a task that cannot be reviewed on
its own — which is the plan's own argument for handling R9 inside T2. Same rule, applied one task
earlier. Nothing else moved.


## T2 — One document per `POST`, and the echo deleted

**Commit:** `bc9f3a0`

**Tests added / changed**

| Level | File | What |
|---|---|---|
| L1 | `functions/src/messages/handlers.spec.ts` | The `echoFor` and `messagePair` describes are deleted. `appendAssistantMessage` writes `{ role: 'assistant', seq: 1, truncated }` under the right path, stamps a `serverTimestamp()` sentinel, returns the committed document in wire shape with no `seq`, and fails closed on a document it cannot read back |
| L1 | `frontend/src/lib/messagesApi.spec.ts` | `sendMessage` resolves to **one** `Message`; an empty `messages` envelope rejects; `listMessages` carries `truncated` through |
| L1 | `frontend/src/stores/workspace.spec.ts` | `send()` appends the one returned message |
| L4 | `tests/integration/messages.spec.ts` | `POST` answers 201 with exactly one message and writes exactly one document, `seq: 0`, `truncated: false`; no `"You said:"` text reaches Firestore; each turn gets its own commit timestamp; the cap accepts at 198 → 199 and refuses at 199 |
| L5 | `tests/e2e/workspace.spec.ts` | The transcript is one bubble and no reply — the placeholder T19 replaces |

**Green:** `readTranscript` extracted (one definition of "what is in this transcript", shared by the
list route and `/generate`); `appendAssistantMessage` added; `echoFor`/`messagePair` deleted;
`handleCreateMessage` writes one document via a shared `readBackOrFail`; `messagesApi.sendMessage`
returns `Message`; the store appends one.

**Note.** The cap check stays `count + 2 > MESSAGE_LIMIT` even though one document is written, per
D4 — the reply needs room. `frontend/src/stores/auth.spec.ts` needed a `truncated` on its inline
message fixture; that is a type consequence of T1, not a behaviour change.

## T3 — The `/generate` body schema

**Commit:** `71b9862`

**Tests added:** L1 `functions/src/llm/schema.spec.ts` — `.strict()` refuses `content`, `role`,
`uid`, `prompt`, `messages` and `model` alongside a valid `projectId`; refuses a missing,
non-string, null, empty, 65-character, `..`, `a/b` and `bad!id` project id; accepts `proj-1` and a
64-character id; the refusal message is the project copy, not a regex complaint.

**Green:** `functions/src/llm/schema.ts` — `generateBodySchema`, `GenerateErrorCode`, and the three
SSE payload types, with `projectIdSchema` imported rather than restated.

## T4 — The system prompt and its breakpoint

**Commit:** `28970dc`

**Tests added:** L1 `functions/src/llm/prompt.spec.ts` — a non-empty array of `text` blocks; exactly
one `cache_control` breakpoint and it is on the last block; nothing matching
`/\d{4}-\d{2}-\d{2}|\d{10,}|\buid\b|projectId/i` in any block (AC-7); the value is identical on
every read; no HighLevel endpoint, no file-format instruction.

**Green:** `functions/src/llm/prompt.ts`.

**Deviation from the plan.** `@anthropic-ai/sdk@^0.117.1` is installed here rather than in T8: T4,
T5, T6 and T7 all need its types (`TextBlockParam`, `MessageParam`, `MessageStreamParams`,
`MessageStreamEvent`), so the plan's ordering could not compile. Only the install moved — the
client, the fake and the fixtures are still T8.

**R8 confirmed resolved against the installed package**, not recalled:
`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` types `OutputConfig.effort` as
`'low' | 'medium' | 'high' | 'xhigh' | 'max' | null`, and `MessageStreamParams =
ParseableMessageCreateParams`, which carries `output_config`. No cast is needed anywhere.

## T5 — The context builder

**Commit:** `d621edc`

**Tests added:** L1 `functions/src/llm/context.spec.ts` — order and roles preserved (AC-8); no `id`,
`createdAt`, `seq` or `truncated` on any element; one trailing assistant dropped, three consecutive
trailing assistants dropped, an assistant in the middle kept (AC-9); all-assistant and empty both
yield `[]` (AC-10's L1 half); the caller's array is not mutated.

**Green:** `functions/src/llm/context.ts`.

## T6 — The request parameters

**Commit:** `6dd6a88`

**Tests added:** L1 `functions/src/llm/params.spec.ts` — `model` exactly `claude-opus-5`,
`max_tokens` exactly `64000`, `output_config.effort` `'low'`, `system` the **same array reference**
as `SYSTEM_PROMPT`, **no `thinking` key**, the context passed through untouched, and the whole
parameter list pinned.

**Green:** `functions/src/llm/params.ts`.

**Deviation from the plan.** AC-6's source scan (`messages.create` appears nowhere; `messages.stream`
appears somewhere) is deferred to T8, where `client.ts` makes the second half true. Landing it here
would leave the suite red across two tasks for no gain.

**Also:** `MessageStreamParams` is re-exported from `@anthropic-ai/sdk/resources/messages/messages`,
not from the `resources/messages` index — the index omits it. Import path adjusted accordingly; no
cast anywhere.

## T7 — The stream mapper

**Commit:** `08e5945`

**Tests added:** L1 `functions/src/llm/stream.spec.ts`, 21 cases driven from hand-written SDK event
arrays — thinking and signature deltas produce no `token` (AC-11); `end_turn` → `truncated: false`;
`max_tokens` → `end` with `truncated: true` (AC-15); `refusal` → `error` code `refused` with empty
text; a throw after two deltas → two `token`s then one `upstream` error carrying their text
(AC-12); a throw before any delta and before `message_start`; the byte cap stops consumption, calls
`abort()` exactly once, ends `truncated`, and keeps the stored text equal to the concatenation of
the emitted tokens (AC-16); a multi-byte delta at the boundary is dropped whole, so no replacement
character is stored; a delta landing exactly on the cap is accepted; usage merged from both events;
and **exactly one terminal event, last**, over six different shapes.

**Green:** `functions/src/llm/stream.ts`.

**Deviation from the plan.** `LlmStream` is declared in `stream.ts` rather than `client.ts`. It is
the mapper's input type and the mapper is the only thing that consumes it, so it belongs where it is
used; `client.ts` imports it in T8. This also keeps T7 from having to create an untested `client.ts`
just to hold an interface.

## T8 — The client port, the fake, the fixtures and the secret script

**Commit:** `1c47f09`

**Tests added**

| Level | File | What |
|---|---|---|
| L1 | `functions/src/llm/fake.spec.ts` | `buildFakeStream` rejects when `FUNCTIONS_EMULATOR` is unset, and for `false`/`TRUE`/`1`/`''` — the gate is an exact match; each of the six markers selects the documented behaviour, asserted by consuming the stream through `mapStream`; an unmarked prompt replays `reply.json` and its recorded **thinking delta does not become a token**; the marker is read from the *last* user message only; `abort()` really stops production |
| L1 | `functions/src/llm/client.spec.ts` | The emulator path needs no key; a missing or blank key rejects with a message naming both `ANTHROPIC_API_KEY` and `functions:secrets:set`; the parameter is a `defineSecret` |
| L1 | `functions/src/llm/params.spec.ts` | AC-6's scan: the scanner is tested on synthetic source (direct call, spaced members, generic call, and four things it must **not** fire on), then run over `functions/src` — `messages.create` nowhere, `messages.stream` somewhere |
| L1 | `scripts/ensure-secret-local.spec.mjs` | Creates from the example when absent; **never** touches an existing file, empty ones included; throws when the committed example is missing |

**Green:** `client.ts` (secret, lazy `await import`, emulator switch), `fake.ts`, three fixtures
under `tests/fixtures/llm/`, `index.ts`, `scripts/ensure-secret-local.mjs`,
`functions/.secret.local.example`, `functions/.env.example`'s rewritten `ANTHROPIC_API_KEY` block,
and the four `package.json` scripts.

**Verified beyond the suite**, because a fixture path that only works under Vitest is invisible
until CI: `npm --prefix functions run build` then requiring `functions/lib/llm/fake.js` directly
replays 14 events, so the `__dirname`-anchored `../../../tests/fixtures/llm` resolves from `lib/`
as well as from `src/`. `node scripts/ensure-secret-local.mjs` creates the file, is a no-op on the
second run, and the file stays gitignored.

**Deviations from the plan.** The scan's needles are regexes anchored on the *call*
(`/\.\s*messages\s*\.\s*create\s*[(<]/`) over comment-stripped source, not plain substrings — the
substring version reported this repository's own documentation. `client.spec.ts` is new (the plan
listed no spec for `client.ts`); the emulator gate and the missing-key message are both testable
without a network, and leaving them untested would have made the key failure an opaque 401 in
production with nothing pointing at the binding.

## T9 — `POST /generate`, the boundary

**Commit:** `8bfcb70`

**Tests added**

| Level | File | What |
|---|---|---|
| L1 | `functions/src/lib/errors.spec.ts` | `sendHttpError` answers an `HttpError` with its own status and code, reduces anything else to a generic 500, and produces byte-identical calls to what `errorHandler` produces |
| L4 | `tests/integration/generate.spec.ts` | No `Authorization` → 401 (AC-20); a malformed one → 401; unverified → 403 (AC-21); alice posting bob's id → 404 with **bob's transcript byte-identical** (AC-22); soft-deleted, never-existed and unparseable → 404 (AC-23); eight malformed bodies → 400 `invalid_body` writing nothing (AC-24); an assistant-only transcript and an empty one → 400 `empty_context` (AC-10). **Every one of these also asserts the `content-type` is not `text/event-stream`.** Plus a smoke test: 200, event stream, tokens, exactly one `done`, and the `done` payload is an assistant message |
| — | `tests/integration/helpers.ts` | `GENERATE_URL` (the `generate` function, not `api`), `postGenerate`, `readSseFrames`, `framesOf` |

**Green:** `sendHttpError` extracted; `functions/src/generate.ts` rewritten.

### Amendment: `/generate` is its own Express app, not a hand-rolled wrapper

The plan specified `onRequest(opts, async (req, res) => { … })` composing `applyCors`,
`requireAppCheck`, `withVerifiedUser` and `sendHttpError` by hand. **That cannot compile.**
`onRequest`'s callback receives `firebase-functions`' own request/response types, which come from
its bundled `@types/express@5.0.6`; this package depends on `@types/express@4.17.25`. Passing that
response to any of the three helpers is `TS2379` — v5's `Response` is missing `sendfile`, which v4
declares as required. Four errors, at every composition point.

Three fixes were considered and two rejected:

- **A cast at the boundary** — forbidden by the code standards (`satisfies` over `as`), and it would
  be a cast between two genuinely different types rather than a narrowing.
- **An npm `overrides` entry forcing v4 types on `firebase-functions`** — attempted; npm kept the
  nested copy, and it would in any case be telling a library its own declared types are wrong.
- **Its own Express app**, taken. `onRequest` already accepts an `Express` application — that is
  exactly how `api` is mounted — and inside the app every helper composes unchanged, `asyncHandler`
  and `errorHandler` included. The function keeps `timeoutSeconds: 540`, `memory: '512MiB'` and its
  own secret binding, which is what the plan's rejection of "mount it on the `api` app" was actually
  about: the *function*, not the *app*. Mounted at `/` and `/generate`, the same both-prefixes note
  every router in this codebase carries.

`terminalErrorHandler` is the four-argument Express adapter that picks D9's channel: JSON before the
flush, an `error` frame after it.

### Amendment: the happy-path smoke test lands here, not in T10

The plan ended T9's implementation at `openStream`, before the flush. That would commit an endpoint
that answers every refusal correctly and **hangs** on success — holding a Cloud Run instance for its
full 540-second timeout. So T9 also carries one streaming assertion (200, event stream, tokens, one
`done` whose payload is an assistant message), and the `token`/`end` handling that satisfies it. The
detailed stream assertions — the persisted document, transcript order, the log line, the keep-alive
— stay in T10, and failure handling stays in T11.

## T10 — The stream itself

**Commit:** `c63ec26`

**Tests added**

| Level | File | What |
|---|---|---|
| L1 | `functions/src/lib/log.spec.ts` | `logGenerationEvent` writes one line, parseable as one JSON object, carrying the event and all eight fields; no field for content; a secret reaching it despite the type is still redacted; **a numeric value under a sensitive-looking name survives, a string under the same name does not** |
| L1 | `functions/src/generate.spec.ts` | `logGeneration` emits exactly one `console.info`, names `generation.complete`, carries the model, stop reason, `truncated`, `durationMs` and the four token counts, and **drops a `text` forced in at runtime** — asserted by pinning the emitted key list. `keepAliveMs` is 15,000 by default, honours the override under the emulator, **ignores it when not**, and falls back for `''`/`soon`/`0`/`-5` |
| L4 | `tests/integration/generate.spec.ts` | 200 with `text/event-stream; charset=utf-8`, tokens then exactly one `done` (AC-1); `cache-control` and `x-accel-buffering`; exactly one assistant document whose content equals the concatenated tokens, `seq: 1`, `truncated: false` (AC-2); the `done` frame's message equals that document in wire shape, five keys, no `seq`; no thinking text on the wire (AC-11 end to end); the transcript reads user-then-assistant with both `truncated: false` (AC-3); **a comment frame before the first token on `__slow`, and more than one** (AC-19); a full second two-request turn |

**Green:** `GenerationLogContext` and `logGenerationEvent` in `lib/log.ts`; `logGeneration`, the
keep-alive interval and the terminal log call in `generate.ts`.

### A real bug the tests caught

`redact`'s `SENSITIVE_KEY` matches `token` as a case-insensitive substring — deliberately, so
`refreshToken` and `newPassword` are caught without enumerating spellings. But
`inputTokens`, `outputTokens`, `cacheCreationInputTokens` and `cacheReadInputTokens` match it too,
so the first version of the generation line emitted `"[redacted]"` for **all four counts** — the only
numbers the line exists to carry (D25), and the ones D16's cache claim is verified with. Silently,
because a redacted field still looks deliberate.

Fixed by excluding on **type** rather than on name: every credential this codebase handles is a
string — access and refresh tokens, passwords, out-of-band codes, API keys, the sealed OAuth state —
so a number or boolean under a sensitive name is a count, an expiry or a flag. A name-based
exclusion list would need maintaining, and the next field somebody added would not be on it. Two L1
cases pin both directions.

## T11 — Failure and interruption

**Commit:** `f125282`

**Tests added**

| Level | File | What |
|---|---|---|
| L4 | `tests/integration/generate.spec.ts` | `__fail_midstream` → two `token`s then exactly one `error` code `upstream`, the partial persisted `truncated: true`, and the frame's `message` equal to it (AC-12); `__fail_upfront` → one `error`, `message: null`, nothing written (AC-13); `__refuse` → one `error` code `refused` with the user-facing copy, nothing written (AC-14); `__max_tokens` → `done` with `truncated: true` (AC-15); `__long` → `done`, stored under 800,000 bytes and over 400,000, byte-identical to the tokens the client received (AC-16); **R1 end to end** — a seeded trailing truncated assistant, and three of them, both stream normally |
| L1 | `functions/src/generate.spec.ts` | Given a `close` mid-stream: the stream is aborted, the partial is persisted `truncated: true`, and **no frame is written to the dead socket** (AC-17); given `close` before any token, nothing is persisted (AC-18); and a completed turn is **not** recorded as an abandonment |

**Green:** `res.on('close')` + `clientGone`, and `finishTurn` implementing the terminal table.

### Finding 1 — the disconnect signal is `res`, not `req`

The plan specified `req.on('close')`. By the time `handleGenerate` runs, `express.json()` has already
drained the request body, so `req` has finished and emitted its own `close` — attaching there
registers a handler for an event that has already fired, and the disconnect is never observed. `res`
emits `close` on both a finished response and a prematurely terminated connection, and
`res.writableEnded` is what tells the two apart.

### Finding 2 — the functions emulator does not propagate a client disconnect

**Measured, not assumed.** With `req.on('close')`, `req.on('aborted')`, `res.on('aborted')` and
`res.on('close')` all instrumented, aborting a real `fetch` two tokens into a `__slow` stream gives:

```
DIAG attach close listeners
PROBE chunk ": keep-alive"          tokens 0
PROBE chunk "event: token …"        tokens 1
PROBE chunk "event: token …"        tokens 2
PROBE aborting
{"event":"generation.complete","stopReason":"end_turn","truncated":false,"durationMs":1213,…}
DIAG res close, writableEnded= true destroyed= true
```

No `req` event, no `aborted` event, the generation running to completion, and `res close` arriving
only *after* the turn ended. The emulator terminates the client connection at its own proxy and
never signals the function runtime.

So AC-17 and AC-18 are driven at L1, where the signal can be delivered, and the two L4 cases are
**removed** rather than left passing for the wrong reason — with the measurement recorded in the
integration spec where they used to be. `it('persists the partial')` reads as proof either way, which
is precisely why an undeliverable test is worse than none.

The L1 cases were checked to discriminate: flipping the listener back to `req.on('close')` turns all
three red. The platform half — that Cloud Run delivers the event at all — is a Slice 13 hand-check,
beside R2's.

### Also

`streamGenerateUntil`, `waitFor` and `sleep` were written for the removed L4 cases and deleted with
them rather than left as dead helpers.

## T12 — The deployment surface

**Commit:** `9cdf6d2`

**Tests added:** L1 `functions/src/index.spec.ts` — `generate.__endpoint` binds `ANTHROPIC_API_KEY`
as a secret, `timeoutSeconds` is 540, `availableMemoryMb` is 512, and `api` keeps 60 s / 256 MiB /
no secrets. Plus a source scan: `generate.ts` names both guards, and the messages `POST` route still
carries `attested` and `withVerifiedUser`.

These assertions passed on arrival, because T9 set the options. **Mutation-checked instead**:
reverting the three to Slice 0's values (60 s, 256 MiB, no `secrets`) turns exactly those three
cases red. The spec states in prose what `__endpoint` does and does not prove — it carries nothing
about middleware, so the behavioural proof of the guards is T9's 401 and 403 over the wire.

**Green:** a comment in `index.ts` recording that the options live in `generate.ts`, beside the
`defineSecret` that declares the key.

## T13 — Rules, re-asserted

**Commit:** see below

**Tests changed:** L3 `tests/rules/firestore.spec.ts` — the `message()` payload gains `truncated`,
so it is byte-identical to what the two writers now store; two cases added — creating a **truncated
assistant** message (the shape a client would most want to forge) and flipping `truncated` on an
existing one; the cross-tenant injection case now uses the truncated shape too.

**Green:** none. **No rules change** (D35) — a rule that denies a document denies it whatever fields
it has. 28 cases, all `assertFails`, no `assertSucceeds` import.

## T14 — The client-side SSE parser

**Commit:** `7c6d558`

**Tests added:** L1 `frontend/src/lib/sse.spec.ts` — a known stream **split at every offset**, in two
chunks and in three, yields identical events (AC-28); one character at a time; incomplete frames
yield nothing; two frames in one chunk yield two; a comment yields nothing and an unknown name is
returned (AC-29); a frame whose data will not parse is dropped and **the frame after it still
parses**, asserted at every split too; newlines, multi-byte characters, multiple `data:` lines and a
missing space after the colon.

**Green:** `frontend/src/lib/sse.ts`.

## T15 — `authHeaders()` and the stream client

**Commit:** `960fc42`

**Tests added:** L1 `apiClient.spec.ts` — `authHeaders()` returns both headers, reads a fresh token
each time, rejects 401 when signed out, and is what `request` sends. L1 `generateApi.spec.ts` — the
request is a `POST` to `/generate` with a body of exactly `{"projectId":"proj-1"}`, both credentials,
a JSON content type and the signal (AC-30); tokens then `done` in order; an `error` event carrying
the persisted partial, and one carrying `null`; a frame split across chunks reassembles; unknown and
malformed events are skipped; **a non-ok response rejects with an `ApiError` carrying the server's
message and status and yields nothing** (AC-31); a 429 says to wait; a network failure maps to status
0; a body-less 200 rejects.

**Green:** `authHeaders()` exported and used by `request`; `frontend/src/lib/generateApi.ts`.

## T16 — The store

**Commit:** `f72ef8a`

**Tests added:** L1 `workspace.spec.ts` — `send()` issues the message `POST` then `POST /generate`
and no `GET` (AC-32); a failed write opens no stream, appends nothing, keeps the draft (AC-33);
tokens accumulate into `streamingText` **while `messages` is asserted unchanged between them**, then
`done` appends and clears (AC-34); `error` with a message appends the server's copy, `error` with
`null` appends nothing, both clear (AC-35); a *rejection* from `/generate` reaches the same error
state; `retryGeneration()` issues `POST /generate` and no message write (AC-36); `reset()` and
opening a second project both abort, and a frame delivered afterwards mutates nothing (AC-37);
`canSend` is false while generating.

**Green:** `generating`, `streamingText`, `generateError`, the store-held `AbortController`,
`runGeneration()`, and `send()` sequencing the two requests.

**Deviation from the plan.** `open()` aborts an in-flight generation **always**, not only when the
project id changes. `open()` re-reads the whole transcript, so a stream still appending into
`messages` is stale by construction — and one left running goes on spending money for a screen
nobody is looking at. Two Slice-4 store cases encoded the one-request contract and were updated.

## T17 — The chat panel

**Commit:** `11e020e`

**Tests added:** L2 `ChatPanel.spec.ts` — a `Generating…` badge and a `streaming-bubble` carrying
`streamingText` (AC-38); the placeholder is the last `<li>` of the transcript list; it wins over the
empty state; neither renders when no stream is open (AC-39); `truncated: true` renders
`message-interrupted` and `false` does not, and the marker says "interrupted" rather than showing a
bare icon (AC-40); `generate-error` shows the server's message with a `generate-retry` that calls
`retryGeneration` exactly once, and the transcript stays visible beside it (AC-41); growing
`streamingText` sets `scrollTop` to `scrollHeight` (AC-43). Plus AC-38's second clause as a **source
scan** over `frontend/src`, not only a render check.

**Green:** `ChatPanel.vue`.

## T18 — The composer

**Commit:** `603b127`

**Tests added:** L2 `MessageComposer.spec.ts` — with `generating` true the textarea and the button
are disabled and Enter issues nothing; with it false both work again (AC-42).

**Green:** `:disabled="workspace.atLimit || workspace.sending || workspace.generating"`.

## T19 — End to end

**Commit:** `e9dd26f`

**Tests added / changed:** L5 `tests/e2e/workspace.spec.ts` — four tests where Slice 4 had one.

1. **A failed generation, a Retry, and a reply that arrives progressively** (AC-44). The first
   `POST /generate` is intercepted and refused; the user bubble is on screen anyway (D3, F8.2), with
   a `generate-error` and a `generate-retry` and no `Generating…` badge. The interception is
   withdrawn and Retry clicked: the badge appears, the `streaming-bubble` is visible **holding part
   of the reply**, then the finished assistant bubble is longer than what the placeholder held —
   **which is R3's answer**, since a buffering dev proxy would take the placeholder from empty
   straight to replaced. Then reload, and back through the dashboard.
2. **An interrupted reply is preserved, marked, and offers a Retry** — `__fail_midstream`, a real
   mid-stream upstream failure. The partial bubble carries `message-interrupted`, the error carries
   a Retry, and re-entering through the dashboard (a fresh store) still shows the marked partial
   with no stale error.
3. **A second prompt in the same conversation also gets a reply** — see below.
4. **A refusal** — `__refuse` leaves the transcript at one message and explains itself.

### A real bug this stage found

`/generate` set `Connection: keep-alive` by hand, inherited from Slice 0. It is a **hop-by-hop**
header the HTTP layer owns. With it set, the first generation of a session succeeded and the **next
`POST /generate` on the reused socket came back as an empty 400** — so the second prompt of every
conversation failed in the running app, with nothing in the logs to say why. Every single-turn test
passed throughout, at all five levels.

Removing it lets Node close the streamed response's socket, and each generation gets a clean one.
"Two prompts in a row" is now a permanent e2e test, because one turn only proves the transport works
once and the first thing a real user does is send a second.

### Two amendments to the plan's e2e

- **The interruption movement does not navigate away.** The plan had the user click *Back to
  dashboard* mid-stream and expected the server to persist the partial. The functions emulator never
  propagates a client disconnect (T11's measurement), so the server would run to completion and
  persist a *complete* reply — the assertion would fail for a reason that has nothing to do with the
  product. `__fail_midstream` produces the same user-visible outcome by a failure mode that is
  reachable here.
- **The refusal is `route.fulfill`, not `route.abort`.** Aborting a request mid-flight leaves the
  functions emulator's pooled upstream socket dirty, and the *next test's* `POST /generate` comes
  back as an empty 400 — the same symptom as the bug above, from a different cause. A fulfilled
  refusal exercises the identical client path without poisoning the connection.

## T20 — Documentation

**Commit:** see below

**Tests added:** none — prose, as the plan says.

**Green:** `docs/IMPLEMENTATION_PLAN.md` §0's status table and full-suite figures, §4's Slice 5
entry (built, with D6/D15/D16 recorded as the decisions a later slice revisits and the Slice 13
deferrals named), §9's conformance rows for F3.1–3.4, F4.1–4.3, F6.2, F6.5 and F8.2 plus the
*streaming mandatory* NFR row; `docs/PRODUCT_SPEC.md` §7.1's `@anthropic-ai/sdk` row marked
shipped at the pinned `^0.117.1`, with the reason for the pin.

**This task was interrupted and resumed.** A previous build session was killed part-way through
T20; the orchestrator committed its work as `9891519`. That commit carried §0 and §4 but not §9,
and had not touched `PRODUCT_SPEC.md`. This session finished both, then re-ran the whole suite
from scratch rather than trusting the recorded figures — they matched exactly (see below).

**§8's LLM-provider row needed no edit.** It already read `✅ Settled` with the model, the stream
requirement, `max_tokens` and the `cache_control` breakpoint, from the plan stage. Recorded here so
its absence from the diff is not read as an omission.

**Nothing deferred out of the plan's T20.** The README's `ANTHROPIC_API_KEY` step is *by the plan*
a Slice 13 checklist item rather than a change here, and it is written into §4's deferral list.

## Final suite

Run in full on `slice/05-streaming-generation`, from a clean tree, after T20 (2026-08-17):

| Suite | Result | Baseline (`main` at `aaa91bb`) |
|---|---|---|
| `typecheck` | pass, 0 errors | pass |
| `lint` | pass, 0 warnings | pass |
| `test:unit` | **952** — 424 functions · 513 frontend · 15 scripts | 748 |
| `test:rules` | **28** | 26 |
| `test:integration` | **231** | 198 |
| `test:e2e` | **12** | 9 |

All six green. The slice added 204 unit cases (138 functions · 62 frontend · 4 scripts), 2 rules
cases, 33 integration cases and 3 e2e cases.

## Acceptance criteria — the test that proves each

Every AC has at least one passing test, and every AC number is grepped out of the spec file named
below, so this table is checkable rather than asserted.

| AC | Level | Test |
|---|---|---|
| AC-1 | L4 | `tests/integration/generate.spec.ts` — tokens then exactly one `done` |
| AC-2 | L4 | `tests/integration/generate.spec.ts` — one document, content = concatenated tokens, `seq: 1` |
| AC-3 | L4 · L1 | `tests/integration/generate.spec.ts` — transcript order · `frontend/src/lib/messagesApi.spec.ts` — `truncated` off the wire |
| AC-4 | L4 · L1 | `tests/integration/messages.spec.ts` — 201, one message, one document · `functions/src/messages/handlers.spec.ts` — `appendAssistantMessage`'s shape, `echoFor`/`messagePair` gone |
| AC-5 | L1 | `functions/src/generate.spec.ts` — `generation.complete`'s fields, and no content |
| AC-6 | L1 | `functions/src/llm/params.spec.ts` — model, `max_tokens`, effort, and the `messages.create` scan |
| AC-7 | L1 | `functions/src/llm/prompt.spec.ts` — one breakpoint, on the last block, nothing volatile |
| AC-8 | L1 | `functions/src/llm/context.spec.ts` — order and roles preserved, no extra keys |
| AC-9 | L1 | `functions/src/llm/context.spec.ts` — one and three trailing assistants dropped |
| AC-10 | L1 · L4 | `functions/src/llm/context.spec.ts` — both yield `[]` · `tests/integration/generate.spec.ts` — `400 empty_context` |
| AC-11 | L1 · L4 | `functions/src/llm/stream.spec.ts` — thinking deltas make no `token` · `tests/integration/generate.spec.ts` — no thinking text on the wire |
| AC-12 | L1 · L4 | `functions/src/llm/stream.spec.ts` — error carries text so far · `tests/integration/generate.spec.ts` — `__fail_midstream`, partial `truncated: true` |
| AC-13 | L4 | `tests/integration/generate.spec.ts` — `__fail_upfront`, `message: null`, nothing written |
| AC-14 | L4 | `tests/integration/generate.spec.ts` — `__refuse`, code `refused`, nothing written |
| AC-15 | L1 · L4 | `functions/src/llm/stream.spec.ts` · `tests/integration/generate.spec.ts` — `__max_tokens` → `done`, `truncated: true` |
| AC-16 | L1 · L4 | `functions/src/llm/stream.spec.ts` — cap, `abort()` once, valid UTF-8 · `tests/integration/generate.spec.ts` — `__long` under 800,000 bytes |
| AC-17 | **L1** | `functions/src/generate.spec.ts` — `close` mid-stream aborts, persists `truncated: true`, writes no frame |
| AC-18 | **L1** | `functions/src/generate.spec.ts` — `close` before any token persists nothing |
| AC-19 | L4 · L1 | `tests/integration/generate.spec.ts` — comment frames before the first token on `__slow` · `functions/src/lib/sse.spec.ts` — the frame's bytes (Slice 0's case, retained) |
| AC-20 | L4 | `tests/integration/generate.spec.ts` — 401, and not `text/event-stream` |
| AC-21 | L4 | `tests/integration/generate.spec.ts` — 403, as JSON |
| AC-22 | L4 | `tests/integration/generate.spec.ts` — alice→bob 404, bob's transcript byte-identical |
| AC-23 | L4 | `tests/integration/generate.spec.ts` — soft-deleted, never-existed, unparseable → 404 |
| AC-24 | L1 · L4 | `functions/src/llm/schema.spec.ts` — `.strict()` refusals · `tests/integration/generate.spec.ts` — eight bodies → 400, nothing written |
| AC-25 | L1 | `functions/src/index.spec.ts` — secret, 540 s, 512 MiB, and the guard source scan; behaviour is AC-20/21 |
| AC-26 | L3 | `tests/rules/firestore.spec.ts` — every operation denied, `truncated` shapes included |
| AC-27 | L3 | `tests/rules/firestore.spec.ts` — the `users`, `projects`, `server-only` and `unknown` describes, re-run unchanged |
| AC-28 | L1 | `frontend/src/lib/sse.spec.ts` — split at every offset, in two chunks and three |
| AC-29 | L1 | `frontend/src/lib/sse.spec.ts` — comment, unknown name, bad JSON without desync |
| AC-30 | L1 | `frontend/src/lib/generateApi.spec.ts` — method, path, exact body, both credentials · `frontend/src/lib/no-firestore.spec.ts` — the scan, unchanged |
| AC-31 | L1 | `frontend/src/lib/generateApi.spec.ts` — non-ok rejects with `ApiError` and yields nothing |
| AC-32 | L1 | `frontend/src/stores/workspace.spec.ts` — message `POST` then `/generate`, no `GET` |
| AC-33 | L1 | `frontend/src/stores/workspace.spec.ts` — failed write opens no stream, keeps the draft |
| AC-34 | L1 | `frontend/src/stores/workspace.spec.ts` — accumulation with `messages` unchanged, then `done` |
| AC-35 | L1 | `frontend/src/stores/workspace.spec.ts` — `error` with a message, and with `null` |
| AC-36 | L1 | `frontend/src/stores/workspace.spec.ts` — `retryGeneration()` writes no message |
| AC-37 | L1 | `frontend/src/stores/workspace.spec.ts` — `reset()` and reopening both abort; a late frame mutates nothing |
| AC-38 | L2 | `frontend/src/components/workspace/ChatPanel.spec.ts` — badge and `streaming-bubble`; `Echo mode` source scan |
| AC-39 | L2 | `frontend/src/components/workspace/ChatPanel.spec.ts` — no badge when no stream is open |
| AC-40 | L2 · L1 | `ChatPanel.spec.ts` — `message-interrupted` both ways · `messagesApi.spec.ts` — `truncated` carried through |
| AC-41 | L2 | `ChatPanel.spec.ts` — `generate-error` + `generate-retry` calling `retryGeneration` once |
| AC-42 | L2 | `MessageComposer.spec.ts` — disabled while generating, Enter issues nothing |
| AC-43 | L2 | `ChatPanel.spec.ts` — growing `streamingText` sets `scrollTop` to `scrollHeight` |
| AC-44 | L5 | `tests/e2e/workspace.spec.ts` — failed generation → Retry → progressive text → reload; interruption → marked partial; a second prompt; a refusal |

**One AC is proven at a different level than the PRD's matrix planned.** AC-17 and AC-18 are L1,
not L4, and the reason is measured and recorded under T11: the functions emulator terminates the
client connection at its own proxy and never signals the function runtime, so an L4 disconnect test
would pass for the wrong reason. The L1 cases were checked to discriminate — flipping the listener
back to the plan's `req.on('close')` turns all three red. The platform half, that Cloud Run delivers
the event at all, is a Slice 13 hand-check beside R2's.

**AC-19, AC-27 and AC-30's second clause are carried partly by tests this slice did not change** —
Slice 0's comment-frame case, the rules file's pre-existing denial describes, and
`no-firestore.spec.ts`. The plan marked all three unchanged, so they carry no `AC-` label in the
source; the mapping lives in this table instead of in a cosmetic edit to a green test.

## Deferred

- **The README's `ANTHROPIC_API_KEY` setup step** — Secret Manager for a deploy,
  `functions/.secret.local` for emulator runs. By the plan's T20 this is a Slice 13 checklist item,
  and it is recorded in `IMPLEMENTATION_PLAN.md` §4's Slice 5 deferral list.
- **R2's hand-check** — that a real generation survives the Hosting rewrite unbuffered from
  `asia-south1`, and that Cloud Run delivers the client disconnect. Neither is reachable from an
  emulator; both are Slice 13.
- **§9's rows for Slices 1–2 read stale** (`⏭ next` for work already merged). Pre-existing, outside
  this slice's scope, and left alone deliberately rather than swept into this branch.
