# Slice 05 — Streaming generation · Technical plan

**PRD:** `02-prd.md` (approved) · **Branch:** `slice/05-streaming-generation` · **Date:** 2026-08-17

## Approach

The boundary ships first and the UI last, as Slice 4 did, because the security-relevant and
hazard-bearing half (D6's prefill drop, D9's two error channels, D21's disconnect) has to be
reviewable before a component changes. A new `functions/src/llm/` module holds five pure
files — body schema, system prompt, transcript → context builder, request parameters, and the
SDK-event → `LlmEvent` mapper — each with an L1 test that needs no emulator and no network.
Only then does `functions/src/generate.ts` become a real endpoint: it composes those five with
`withVerifiedUser`, `requireAppCheck`, Slice 3's `readProject`, and Slice 0's SSE encoder.

Two seams make the slice testable. The first is a **narrow port**: `openStream(params)` returns
an `LlmStream` — an `AsyncIterable<MessageStreamEvent>` with an `abort()` — which the real SDK's
`MessageStream` satisfies as-is and which the emulator-only fake can implement from recorded
fixtures. The second is that **the mapper owns accumulation and the byte cap**, so `stream.spec.ts`
drives the whole of D22, D23 and AC-11 from a hand-written array of SDK events, and the handler is
left with framing, persistence and the log line.

On the frontend the same split: `lib/sse.ts` is a pure incremental frame parser (R4's whole
mitigation), `lib/generateApi.ts` is the credentialled `fetch` that feeds it, and
`stores/workspace.ts` holds `generating` / `streamingText` / `generateError` plus the
`AbortController` — in the store, not the component, for Slice 4 D17's reason.

Rejected: **mounting `/generate` on the `api` Express app** — it needs a 540-second timeout and
512 MiB, which the CRUD endpoints must not pay for, and D1 keeps Slice 0's proven rewrite.
Rejected: **letting the handler accumulate text** — the cap, the truncation flag and the
thinking-delta filter would then be untestable without an emulator, which is exactly where R4-class
bugs hide. Rejected: **`EventSource`** (D11) and **a second e2e spec** (D36), both settled in the PRD.

## Contradictions with the standing rules — none

`POST /generate` names an action, not a user; the project id travels in the `.strict()` body and is
ownership-checked against the token's uid. No route gains a `:uid` or a `me`. The frontend adds no
Firestore import — `frontend/src/lib/no-firestore.spec.ts` still scans the whole tree. Liveness
during a generation is an SSE stream, which the rule explicitly permits.

## File map

### Functions — the LLM module (new)

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/llm/schema.ts` | New | `generateBodySchema` (`.strict()`), the three SSE payload types, `GenerateErrorCode` |
| `functions/src/llm/schema.spec.ts` | New | L1 — AC-24's body refusals |
| `functions/src/llm/prompt.ts` | New | `SYSTEM_PROMPT` — one stable block, `cache_control` on the last |
| `functions/src/llm/prompt.spec.ts` | New | L1 — AC-7 |
| `functions/src/llm/context.ts` | New | `buildContext()` — wire messages → `MessageParam[]`, trailing assistants dropped |
| `functions/src/llm/context.spec.ts` | New | L1 — AC-8, AC-9, AC-10's L1 half |
| `functions/src/llm/params.ts` | New | `MODEL`, `MAX_TOKENS`, `EFFORT`, `buildParams()` |
| `functions/src/llm/params.spec.ts` | New | L1 — AC-6, including the `messages.create` source scan |
| `functions/src/llm/client.ts` | New | `ANTHROPIC_API_KEY` secret, `LlmStream`, `openStream()` — fake under the emulator |
| `functions/src/llm/stream.ts` | New | `MAX_OUTPUT_BYTES`, `LlmEvent`, `mapStream()` |
| `functions/src/llm/stream.spec.ts` | New | L1 — AC-11, AC-12's mapper half, AC-15, AC-16's L1 half |
| `functions/src/llm/fake.ts` | New | Emulator-only replay, gated on `FUNCTIONS_EMULATOR` (D20) |
| `functions/src/llm/fake.spec.ts` | New | L1 — the gate, and marker selection |
| `functions/src/llm/index.ts` | New | Re-exports, so `generate.ts` imports one path |

### Functions — the endpoint and its neighbours

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/generate.ts` | Edit (rewrite) | `onRequest` with secret/timeout/memory; `handleGenerate`; `logGeneration`; keep-alive; disconnect |
| `functions/src/generate.spec.ts` | New | L1 — AC-5's log line, and the guard source scan |
| `functions/src/index.ts` | Edit | Comment only — `generate`'s options move into `generate.ts` where the secret is declared |
| `functions/src/index.spec.ts` | Edit | L1 — AC-25's deployment surface: secret binding, timeout, memory |
| `functions/src/messages/schema.ts` | Edit | `truncated` on `storedMessageSchema` (defaulted) and on `Message`; `toMessage` carries it |
| `functions/src/messages/schema.spec.ts` | Edit | L1 — R7's Slice-4-shaped document parses to `truncated: false` |
| `functions/src/messages/handlers.ts` | Edit | `echoFor` / `messagePair` deleted; `readTranscript()` extracted; `appendAssistantMessage()` added; `handleCreateMessage` writes one document |
| `functions/src/messages/handlers.spec.ts` | Edit | L1 — echo cases removed; `appendAssistantMessage`'s document shape |
| `functions/src/lib/errors.ts` | Edit | `sendHttpError(err, res)` extracted; `errorHandler` delegates to it |
| `functions/src/lib/errors.spec.ts` | Edit | L1 — one case for the extracted function |
| `functions/src/lib/log.ts` | Edit | `GenerationLogContext` and `logGenerationEvent()` |
| `functions/src/lib/log.spec.ts` | Edit | L1 — the line is one JSON object and carries only the declared fields |
| `functions/src/lib/sse.ts` | Unchanged | Already exports what this slice needs |
| `functions/src/lib/sse.spec.ts` | Unchanged | AC-19's L1 half is the existing comment-frame case |
| `functions/package.json` | Edit | `@anthropic-ai/sdk` ^0.117.1 |
| `functions/.env.example` | Edit | `ANTHROPIC_API_KEY` comment: Secret Manager + `.secret.local` instructions |
| `functions/.secret.local.example` | New | The emulator placeholder, committed (`.secret.local` itself stays gitignored) |

### Frontend

| File | New/Edit | What changes |
|---|---|---|
| `frontend/src/lib/sse.ts` | New | `createSseParser()` — incremental, chunk-boundary safe (D33) |
| `frontend/src/lib/sse.spec.ts` | New | L1 — AC-28, AC-29 |
| `frontend/src/lib/apiClient.ts` | Edit | `authHeaders()` exported; `request` uses it (D32) |
| `frontend/src/lib/apiClient.spec.ts` | Edit | L1 — `authHeaders()` returns both headers |
| `frontend/src/lib/generateApi.ts` | New | `streamGeneration(projectId, signal)` — async generator of parsed events |
| `frontend/src/lib/generateApi.spec.ts` | New | L1 — AC-30, AC-31 |
| `frontend/src/lib/messagesApi.ts` | Edit | `truncated` on `Message`; `sendMessage` returns one `Message` |
| `frontend/src/lib/messagesApi.spec.ts` | Edit | L1 — `truncated` off the wire, one message back |
| `frontend/src/stores/workspace.ts` | Edit | `generating`, `streamingText`, `generateError`, abort controller, `send()`, `retryGeneration()` |
| `frontend/src/stores/workspace.spec.ts` | Edit | L1 — AC-32 … AC-37 |
| `frontend/src/components/workspace/ChatPanel.vue` | Edit | `Generating…` badge, streaming bubble, interrupted marker, error + Retry, scroll on tokens |
| `frontend/src/components/workspace/ChatPanel.spec.ts` | Edit | L2 — AC-38 … AC-41, AC-43 |
| `frontend/src/components/workspace/MessageComposer.vue` | Edit | Disabled while generating |
| `frontend/src/components/workspace/MessageComposer.spec.ts` | Edit | L2 — AC-42 |

### Tests, scripts and docs

| File | New/Edit | What changes |
|---|---|---|
| `tests/fixtures/llm/reply.json` | New | The happy event sequence, thinking delta included |
| `tests/fixtures/llm/refusal.json` | New | `stop_reason: 'refusal'` |
| `tests/fixtures/llm/max-tokens.json` | New | `stop_reason: 'max_tokens'` |
| `tests/integration/helpers.ts` | Edit | `GENERATE_URL`, `postGenerate()`, `readSseFrames()` |
| `tests/integration/generate.spec.ts` | New | L4 — the endpoint, both error channels, interruption |
| `tests/integration/messages.spec.ts` | Edit | L4 — `POST` returns one message; `truncated` on the wire |
| `tests/rules/firestore.spec.ts` | Edit | L3 — AC-26 payload gains `truncated`; AC-27 re-run |
| `tests/e2e/workspace.spec.ts` | Edit | L5 — AC-44 replaces the echo assertion (D36) |
| `scripts/ensure-secret-local.mjs` | New | Writes `functions/.secret.local` from the example if absent |
| `scripts/ensure-secret-local.spec.mjs` | New | L1 — creates when absent, never overwrites |
| `package.json` | Edit | Wire the script into `dev`/`emulators`/`test:integration`/`test:e2e`; add `GENERATE_TEST_KEEPALIVE_MS` |
| `docs/IMPLEMENTATION_PLAN.md` | Edit | §0 status, §4 Slice 5, §8 LLM row, §9 conformance rows |
| `docs/PRODUCT_SPEC.md` | Edit | §7.1 `@anthropic-ai/sdk` marked shipped |

## Interfaces, decided here so the build does not have to invent them

### `functions/src/llm/schema.ts`

```ts
/** `{ projectId }` and nothing else (D2). The prompt is the server's own record. */
export const generateBodySchema = z.object({ projectId: projectIdSchema }).strict()

export type GenerateErrorCode = 'upstream' | 'refused' | 'internal'

export interface TokenPayload { text: string }
export interface DonePayload { message: Message }
export interface ErrorPayload { error: string; code: GenerateErrorCode; message: Message | null }
```

`projectIdSchema` is imported from `../projects/schema` — the same regex the path routes use, so
`/generate` and `/api/projects/:projectId/*` cannot disagree about what an id is. `parseBody`
surfaces `issues[0].message`, so a malformed id answers `400 invalid_body` carrying
`That project could not be found.` — the code is what AC-24 pins, and the copy is deliberately the
project-shaped one.

### `functions/src/llm/prompt.ts`

```ts
/**
 * The stable prefix, and the whole of it (D17).
 *
 * The `cache_control` breakpoint is declared now and is a **no-op until Slice 9**:
 * `claude-opus-5`'s minimum cacheable prefix is 512 tokens and this is far shorter,
 * so `cache_creation_input_tokens` will be 0 and nothing will error (D16).
 */
export const SYSTEM_PROMPT: TextBlockParam[] = [
  { type: 'text', text: '…', cache_control: { type: 'ephemeral' } },
]
```

Content: what Genesis is, that it builds small web apps over a HighLevel CRM, and the response-style
constraints. **No HighLevel endpoints and no file-format instructions** — both would be wrong by the
slice that owns them.

### `functions/src/llm/context.ts`

```ts
/**
 * The transcript as the model sees it, oldest first.
 *
 * **Trailing assistant turns are dropped** (D6, R1). A trailing assistant message is a
 * prefill, and prefill is a 400 on `claude-opus-5` — the shape Retry after an
 * interruption produces every single time.
 */
export function buildContext(messages: readonly Message[]): MessageParam[]
```

One loop back from the end while the last element is `role: 'assistant'`, then map to
`{ role, content }`. No `id`, no `createdAt`, no `seq`, no `truncated`. Returns `[]` when nothing
survives, which is what the handler turns into `400 empty_context` (D7).

### `functions/src/llm/params.ts`

```ts
export const MODEL = 'claude-opus-5'
export const MAX_TOKENS = 64_000
export const EFFORT = 'low' as const

export function buildParams(context: MessageParam[]): MessageStreamParams {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { effort: EFFORT },
    messages: context,
  }
}
```

**No `thinking` field, and that is the decision** (D14): thinking is on by default on
`claude-opus-5`, and `{ type: 'disabled' }` carries the documented tag-leak failure mode this slice
cannot afford. `display` is omitted, so thinking blocks arrive with empty text and are dropped by
the mapper anyway.

> **R8 is resolved, not carried.** `@anthropic-ai/sdk@0.117.1` types `output_config.effort` as
> `'low' | 'medium' | 'high' | 'xhigh' | 'max'` and `MessageStreamParams` accepts `output_config`.
> No cast is needed anywhere in this slice. Pin `^0.117.1`; if a future minor drops a typing, the
> fix is a comment naming why, never an `as`.

### `functions/src/llm/client.ts`

```ts
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')

/** The narrow port. `MessageStream` satisfies it as-is; so does the fake. */
export interface LlmStream extends AsyncIterable<MessageStreamEvent> {
  abort: () => void
}

export async function openStream(params: MessageStreamParams): Promise<LlmStream>
```

Three things this deliberately does:

1. **The fake is chosen on `isEmulator()` and nothing else** (D20). A config flag would be a
   remotely-settable way to replace the model with a stub, which is `buildFakeHlRouter`'s exact
   argument one slice on.
2. **The SDK is loaded lazily**, with `await import('@anthropic-ai/sdk')` inside the client
   factory and `import type` everywhere else. `index.ts` re-exports `generate`, so every function
   in the codebase loads the same module graph — a static import would put ~2 MB of SDK on the
   `api` function's cold-start path for a dependency it never uses. This is why `openStream`
   returns a promise.
3. **The key is validated explicitly**, `getDb()`'s way: an empty `ANTHROPIC_API_KEY.value()`
   throws `Missing ANTHROPIC_API_KEY. Set it with \`firebase functions:secrets:set\` — see
   functions/.env.example.` The handler opens the stream **before** flushing headers, so this is a
   `500 internal` with the reason logged and not surfaced, exactly as the failure table says.

### `functions/src/llm/stream.ts`

```ts
/** A Firestore document caps at 1,048,576 bytes; this leaves room for the rest (D22). */
export const MAX_OUTPUT_BYTES = 800_000

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export type LlmEvent =
  | { kind: 'token'; text: string }
  | { kind: 'end'; text: string; truncated: boolean; stopReason: string | null; model: string; usage: LlmUsage }
  | { kind: 'error'; text: string; code: 'upstream' | 'refused'; stopReason: string | null; model: string; usage: LlmUsage }

/** Many `token`s, then **exactly one** terminal — `end` or `error`, never both, never neither. */
export async function* mapStream(stream: LlmStream): AsyncGenerator<LlmEvent>
```

Behaviour, in the order the events arrive:

- `message_start` → record `model`, `input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`.
- `content_block_delta` with `delta.type === 'text_delta'` → the cap check, then `yield { kind: 'token' }`.
- **every other delta is ignored**, `thinking_delta` and `signature_delta` included (AC-11).
- `message_delta` → record `delta.stop_reason` and `usage.output_tokens`.
- Iteration ends → `stop_reason === 'refusal'` gives `error` code `refused`;
  `stop_reason === 'max_tokens'` gives `end` with `truncated: true` (D23); anything else gives
  `end` with `truncated: false`.
- The iterator **throws** → `error` code `upstream`, carrying the text produced so far (AC-12).

> **The cap is enforced whole-delta.** A delta that would take the total past `MAX_OUTPUT_BYTES`
> (measured with `Buffer.byteLength(text, 'utf8')`) is **not appended and not emitted**; the mapper
> calls `stream.abort()` and yields `end` with `truncated: true`. Slicing the delta by bytes would
> split a multi-byte character and store a replacement character, and it would also make the last
> `token` frame the client saw disagree with what was persisted. Dropping the whole delta keeps the
> stored text ≤ the cap, valid UTF-8, and byte-identical to the concatenation of the frames the
> client received.

### `functions/src/llm/fake.ts` (D20)

Gated on `isEmulator()`; `buildFakeStream(params)` returns an `LlmStream` and throws if called
outside the emulator, so the gate cannot be bypassed by a stray import. Behaviour is selected by a
marker anywhere in the **last user message** of `params.messages`:

| Marker | Behaviour |
|---|---|
| `__fail_midstream` | Two text deltas, then the iterator throws |
| `__fail_upfront` | Throws before any delta |
| `__refuse` | `refusal.json` — `stop_reason: 'refusal'`, no content |
| `__max_tokens` | `max-tokens.json` |
| `__long` | `reply.json`'s text delta repeated until the accumulation crosses `MAX_OUTPUT_BYTES` |
| `__slow` | `reply.json` with a 600 ms delay before the first delta and 150 ms between the rest |
| *(none)* | `reply.json`, with a 40 ms delay per delta |

**Event shapes come from `tests/fixtures/llm/`; behaviour (delay, repetition, injected failure) is
applied on top.** A fixture holding 800 KB of literal text, or a fixture per timing variant, would
be a fixture nobody can read. The fixtures are the wire shape — which is the part worth recording —
and the loading is `readFileSync(path.resolve(__dirname, '../../../tests/fixtures/llm', name))`
inside the call, never at module scope: `functions/lib/` is what deploys, `tests/` is not, and a
module-scope read would fail `firebase deploy`'s module analysis for code that never runs there.

The default 40 ms per delta is not decoration — it is what makes AC-44's "text appears
progressively" a real assertion and what makes R3 (a buffering Vite dev proxy) show up as an e2e
failure rather than a mystery.

### `functions/src/messages/schema.ts` — the one field (D24, R7)

```ts
export const storedMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  seq: z.number().int().min(0),
  createdAt: firestoreTimestamp,
  /**
   * **Defaulted, not `.catch`ed**, and the difference is D27's rule holding.
   * Slice 4's documents do not have this field; a default on an *absent* field is
   * a migration, where a `.catch` on a *corrupt* one would be silently accepting
   * a document that is wrong about itself.
   */
  truncated: z.boolean().default(false),
})

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  truncated: boolean
}
```

`seq` still never crosses the wire.

### `functions/src/messages/handlers.ts`

```ts
/** The transcript, parsed and ordered — shared by the list route and by `/generate`. */
export async function readTranscript(uid: string, projectId: string): Promise<Message[]>

/** The assistant turn, written at the stream's terminal event. `seq` is 1 (D35). */
export async function appendAssistantMessage(
  uid: string,
  projectId: string,
  content: string,
  truncated: boolean,
): Promise<Message>
```

`handleListMessages` becomes `res.json({ messages: await readTranscript(uid, projectId) })` after
its 404 check, so the corrupt-document filtering `/generate` sees is byte-identical to the one the
browser sees — one definition of "what is in this transcript", not two.

`handleCreateMessage` loses the batch: one `collection.doc()`, one `set({ role: 'user', content,
seq: 0, createdAt, truncated: false })`, one re-read, `201 { messages: [message] }` (D4).
**The cap check stays `count + 2 > MESSAGE_LIMIT`** even though only one document is written now,
and that is deliberate: D4 records the 409 as unchanged because the *pair* still has to fit — the
reply this `POST` is about to make the user trigger needs room, and refusing at 199 is what stops a
transcript ending on a prompt with nowhere to put its answer. `echoFor` and `messagePair` are
deleted outright.

### `functions/src/generate.ts`

```ts
export const generate = onRequest(
  { timeoutSeconds: 540, memory: '512MiB', secrets: [ANTHROPIC_API_KEY], cors: false },
  async (req, res) => { /* cors → attest → verify → handleGenerate, all inside one try/catch */ },
)

/** Exported so the log line has an L1 test that needs no emulator. */
export function logGeneration(context: GenerationLogContext): void

export async function handleGenerate(req: Request, res: Response, uid: string): Promise<void>
```

The wrapper, in order:

1. `applyCors` (Slice 0's, unchanged) and the `res.writableEnded` early return.
2. `await requireAppCheck(req, res, () => undefined)` — it is already an async middleware that
   throws rather than calling `next` on failure, so a no-op `next` composes it without an Express app.
3. `await withVerifiedUser(handleGenerate)(req, res)`.
4. `catch (err) { sendHttpError(err, res) }` — but **only if the headers have not been flushed**.
   Once they have, the status line is spent (D9, R6), so a late throw writes an `error` frame and
   ends the response. The wrapper reads `res.headersSent` to choose.

`handleGenerate`, in order — everything cheap decided **before** the flush:

1. `const { projectId } = parseBody(generateBodySchema, req)` → 400 `invalid_body`, no Firestore read.
2. `if ((await readProject(uid, projectId)) === null) throw notFound()` → 404.
3. `const context = buildContext(await readTranscript(uid, projectId))`.
4. `if (context.length === 0) throw new HttpError(400, 'There is nothing to generate from yet. Send a message first.', 'empty_context')`.
5. `const stream = await openStream(buildParams(context))` — a missing key throws here, and it is
   still an ordinary 500.
6. Headers, `res.flushHeaders()`, one immediate `encodeSseComment()` so the client sees bytes at once.
7. The keep-alive interval, the `req.on('close')` handler, then the consume loop.
8. `finally { clearInterval(...) }`.

**Disconnect (D21, AC-17, AC-18).** `req.on('close')` sets `clientGone = true` when
`!res.writableEnded` — Node fires `close` on normal completion too, so the guard is what stops a
successful turn being recorded as an abandonment — and calls `stream.abort()`. The in-flight
`for await` then throws, the mapper yields `error` code `upstream`, and the terminal step sees
`clientGone` and **persists the partial without writing a frame**. `res.destroyed` is checked before
every write, as Slice 0 does.

**Terminal handling**, one place for both kinds:

| Mapper event | Persisted | Frame written |
|---|---|---|
| `end`, text non-empty | `truncated` from the event | `done` with the persisted message |
| `end`, text empty | nothing | `done` with… **cannot happen** — an `end` with no text and `end_turn` is a model that said nothing; treat it as `error` code `upstream`, message `null` |
| `error` `refused` | nothing (content is empty) | `error` `refused`, `message: null` |
| `error` `upstream`, text non-empty | `truncated: true` | `error` `upstream`, message = the partial |
| `error` `upstream`, text empty | nothing | `error` `upstream`, `message: null` |
| any of the above with `clientGone` | as above | **nothing** |

`logGeneration` is called once per turn, on every path, before the frame is written.

**Keep-alive (D28).** `setInterval(keepAliveMs())` writing `encodeSseComment()` when nothing has
been written since the last tick. `keepAliveMs()` follows `hl/config.ts`'s `emulatorOverride`
pattern exactly: `GENERATE_TEST_KEEPALIVE_MS` is honoured **only** under `FUNCTIONS_EMULATOR`, the
name appears in no `.env` file so a shell value survives, and the default is 15,000. The test
scripts set it to 250 so AC-19 is a two-second test rather than a twenty-second one.

### `functions/src/lib/errors.ts` and `log.ts`

```ts
/** The JSON envelope, extracted so a non-Express handler can answer with it too. */
export function sendHttpError(err: unknown, res: Response): void
```

`errorHandler` becomes a four-argument Express adapter that calls it. No behaviour change.

```ts
export interface GenerationLogContext {
  model: string
  stopReason: string | null
  truncated: boolean
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export function logGenerationEvent(event: string, context: GenerationLogContext): void
```

A second typed context rather than widening `AuthLogContext`: that interface's comment explains
that it is narrow **on purpose** — no free-form body — and a generation line that could carry an
arbitrary string would be one refactor away from carrying a prompt. Same `redact` pass, same single
`console.info(JSON.stringify(...))`.

### `frontend/src/lib/sse.ts` (D33, R4)

```ts
export interface SseEvent { event: string; data: unknown }

/**
 * An incremental parser. `push` takes whatever arrived and returns whatever
 * completed — usually nothing, sometimes several frames.
 *
 * `ReadableStream` chunks have nothing to do with frame boundaries, so
 * `event: to` / `ken\ndata: …` is a normal thing to receive.
 */
export function createSseParser(): { push: (chunk: string) => SseEvent[] }
```

Buffers on `\n\n`; within a frame, `event:` sets the name, `data:` lines are joined with `\n`, and a
line starting with `:` is a comment and yields nothing. **JSON is parsed here**, and a frame whose
`data` will not parse is dropped rather than thrown — a malformed frame must not desync the parser
(AC-29). Unknown event names are returned as-is; filtering is the caller's job, which is what lets
Slice 6 add `file_start` handling without touching this file.

### `frontend/src/lib/apiClient.ts` (D32)

```ts
/** The ID token and the App Check token — everything that authenticates a call. */
export async function authHeaders(): Promise<Record<string, string>>
```

`request` becomes `{ ...init.headers, ...(await authHeaders()) }`, which preserves the existing
"caller's headers go first, so they cannot unset the two that authenticate" ordering.

### `frontend/src/lib/generateApi.ts`

```ts
export type GenerateEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: string; code: string; message: Message | null }

export async function* streamGeneration(
  projectId: string,
  signal: AbortSignal,
): AsyncGenerator<GenerateEvent>
```

`POST` to `apiUrl('/generate')` with `Content-Type: application/json`, `authHeaders()`, a body of
exactly `{ projectId }`, and the signal. A non-ok response rejects with
`new ApiError(await messageForResponse(res), res.status)` **before yielding anything** (AC-31) —
which is what makes D9's two channels one code path on the client: a JSON refusal is a rejection, a
mid-stream failure is an `error` event.

The body is read with `res.body.getReader()` and a `TextDecoder` in `{ stream: true }` mode, so a
multi-byte character split across chunks survives. Narrowing from `SseEvent` to `GenerateEvent` is
hand-written type guards, not Zod: `frontend/` has no Zod dependency and `messagesApi.ts` already
establishes that the typed clients assert the wire shape. Adding a package for three payloads is not
the trade; unrecognised events are skipped.

### `frontend/src/stores/workspace.ts`

```ts
export interface WorkspaceStore {
  /* …everything Slice 4 had… */
  generating: Ref<boolean>
  streamingText: Ref<string>
  generateError: Ref<string | null>
  send: () => Promise<void>
  retryGeneration: () => Promise<void>
}
```

- `canSend` gains `&& !generating.value`.
- `let controller: AbortController | null`, and one `abortGeneration()` that aborts it and clears
  it. Called from `reset()` **and** from `open()` when the project id changes (AC-37).
- `send()`: the message `POST` first; on success append the returned message and clear the draft;
  **then** `await runGeneration()`. On a failed write nothing is appended, the draft is kept,
  `sendError` is set, and **no stream is opened** (AC-33).
- `retryGeneration()` is `runGeneration()` and nothing else — no message write (AC-36).
- `runGeneration()` sets `generating`, clears `generateError` and `streamingText`, creates the
  controller, and consumes the generator: `token` appends to `streamingText`; `done` pushes the
  message; `error` pushes `message` when it is not null and sets `generateError`. Every write past
  an `await` is guarded by the existing `current(gen)` check, and `finally` clears `streamingText`
  and `generating` — guarded too, so a late stream cannot re-enable the composer of a project the
  user has since left.
- **`streamingText` is a `ref<string>` re-assigned per token** (D31). The trap
  `typescript-vue.md` warns about is an array of objects pushed to thousands of times; the tokens
  become a `Message` exactly once, at the terminal event.

### `frontend/src/components/workspace/ChatPanel.vue`

- The header badge: `<Badge v-if="workspace.generating">Generating…</Badge>`. `Echo mode` is
  deleted (AC-38, AC-39). `Badge` is still used by `WorkspaceView`'s connection badge, so Slice 4's
  D19 still holds.
- Inside the transcript `<ul>`, after the bubbles: an `<li v-if="workspace.generating"
  data-testid="streaming-bubble" :key="'__streaming'">` rendering `workspace.streamingText`.
  Inside the list so the existing scroll machinery covers it.
- Each bubble gains `<span v-if="message.truncated" data-testid="message-interrupted">` (AC-40).
- Below the scroll area, above the composer: `<div v-if="workspace.generateError"
  data-testid="generate-error">` with the message and a `generate-retry` button calling
  `retryGeneration()` (AC-41).
- A second `watch(() => workspace.streamingText, scrollToBottom, { flush: 'post' })` (AC-43).
- The `v-else` branch currently owns the transcript; the streaming bubble and the generation error
  live there too. `chat-empty` cannot collide with a stream: the user message is appended before
  the stream opens, so `bubbles.length` is never 0 while `generating` is true.

## Task list

Ordered so each task leaves the whole suite green and nothing depends on a later one.

### T1 — `truncated` on the message schema → AC-24 (R7's half), enables everything

- **Red:** `functions/src/messages/schema.spec.ts` — a **Slice-4-shaped** document (no `truncated`
  key) parses and yields `truncated: false`; `truncated: true` round-trips; `truncated: 'yes'`
  fails the parse; `toMessage` puts `truncated` on the wire shape and still omits `seq`.
- **Green:** `truncated: z.boolean().default(false)` on `storedMessageSchema`, the field on
  `Message`, and `toMessage` carrying it.
- **Refactor:** the schema header — say why this is a default and not a `.catch`, in D27's voice.

### T2 — One document per `POST`, and the echo deleted → AC-4, and the frontend half of AC-3/AC-40

- **Red, L1:** `handlers.spec.ts` — the `echoFor` and `messagePair` describes are **deleted**;
  a new one asserts `appendAssistantMessage` writes `{ role: 'assistant', seq: 1, truncated }` and
  returns the wire shape. `messagesApi.spec.ts` — `sendMessage` resolves to one `Message`, and a
  response whose `messages` array is empty rejects; `listMessages` carries `truncated` through.
- **Red, L4:** `tests/integration/messages.spec.ts` — `POST` answers `201` with **exactly one**
  message, `role: 'user'`, and the collection holds **one** document; every response message
  carries `truncated: false`; the wire-shape key list becomes
  `['content', 'createdAt', 'id', 'role', 'truncated']`; the `ECHO` constant and the three
  echo-shaped assertions go.
- **Green:** `readTranscript` extracted; `appendAssistantMessage` added; `echoFor`/`messagePair`
  deleted; `handleCreateMessage` writes one document and answers `{ messages: [one] }`;
  `messagesApi.sendMessage` returns `Message`; `workspace.send()` appends one message.
- **Refactor:** update `handlers.ts`'s header, which currently promises the Slice 5 change in the
  future tense. Delete `ECHO` from the integration spec.

> **R9, handled here rather than left to fail.** Deleting the echo turns `tests/e2e/workspace.spec.ts`
> red. In **this** task the e2e's assertion becomes **one** bubble and no reply — which is the
> literal truth of the app between T2 and T9 — and T15 extends it to the streamed reply. A task
> that leaves a suite red so a later task can fix it is a task that cannot be reviewed on its own.

### T3 — The `/generate` body schema → AC-24's L1 half

- **Red:** `functions/src/llm/schema.spec.ts` — `.strict()` refuses each of `content`, `role`,
  `uid` alongside a valid `projectId`; refuses a missing `projectId`, a non-string one, `''`,
  65 characters, `..`, `a/b`, and `bad!id`; accepts a 64-character id and `proj-1`.
- **Green:** `functions/src/llm/schema.ts` as specified, importing `projectIdSchema`.
- **Refactor:** the module header — why the prompt is not in the body (D2).

### T4 — The system prompt and its breakpoint → AC-7

- **Red:** `functions/src/llm/prompt.spec.ts` — `SYSTEM_PROMPT` is a non-empty array of
  `type: 'text'` blocks; **the last block carries `cache_control: { type: 'ephemeral' }`** and no
  earlier block does; reading it twice gives deep-equal values (nothing is computed per call); no
  block's text matches `/\d{4}-\d{2}-\d{2}|\d{10,}|\buid\b|projectId/i`, which is "nothing volatile
  above the breakpoint" expressed as something a machine can check.
- **Green:** `functions/src/llm/prompt.ts`.
- **Refactor:** the D16 comment — the breakpoint is a **declared no-op until Slice 9**, because
  `claude-opus-5`'s minimum cacheable prefix is 512 tokens and nothing errors when a prefix is
  shorter. A reviewer must not read `cache_read_input_tokens: 0` as a bug.

### T5 — The context builder → AC-8, AC-9, AC-10's L1 half

- **Red:** `functions/src/llm/context.spec.ts` — three user and two assistant messages in
  chronological order map to five `{ role, content }` in the same order, with **no** `id`, `seq`,
  `createdAt` or `truncated` key on any element; a transcript ending in one assistant message drops
  it; a transcript ending in **three consecutive** assistant messages drops all three and leaves a
  `role: 'user'` last element; an assistant message in the *middle* is kept; an all-assistant
  transcript yields `[]`; an empty transcript yields `[]`.
- **Green:** `functions/src/llm/context.ts`.
- **Refactor:** the header carries R1 in full — a trailing assistant message *is* a prefill,
  prefill is a 400 on `claude-opus-5`, and this is the shape Retry after an interruption produces
  every time. The failure would land on the recovery path.

### T6 — The request parameters → AC-6

- **Red:** `functions/src/llm/params.spec.ts` — `buildParams([])` has `model` exactly
  `'claude-opus-5'`, `max_tokens` exactly `64000`, `output_config.effort` `'low'`, `system` the
  same reference as `SYSTEM_PROMPT` (nothing appended above the breakpoint), and **no `thinking`
  key at all**; the context array is passed through untouched. Plus a **source scan** over
  `functions/src` — `no-firestore.spec.ts`'s shape, self-skipping — asserting `messages.create`
  appears in no file and `messages.stream` appears in at least one.
- **Green:** `functions/src/llm/params.ts`.
- **Refactor:** the header records D13, D14 and D15 — why `stream` is a brief requirement rather
  than a preference, why `thinking` is absent, and that **Slice 9 re-tunes `effort`** against real
  HighLevel prompts, so that change reads as planned rather than as churn.

### T7 — The stream mapper → AC-11, AC-12's L1 half, AC-15, AC-16's L1 half

- **Red:** `functions/src/llm/stream.spec.ts`, driving `mapStream` from a hand-written
  `LlmStream` whose `abort()` is a spy. Cases:
  - a sequence with two `text_delta`s and one `thinking_delta` yields **two** `token` events, and
    the terminal `end` carries their concatenation (AC-11);
  - `stop_reason: 'end_turn'` → `end`, `truncated: false`;
  - `stop_reason: 'max_tokens'` → `end`, `truncated: true` (AC-15);
  - `stop_reason: 'refusal'` with no content → `error` code `refused`, `text: ''`;
  - an iterator that throws after two deltas → **two** `token`s then `error` code `upstream`
    carrying those two deltas' text (AC-12);
  - an iterator that throws before any delta → `error` `upstream`, `text: ''`;
  - deltas that cross `MAX_OUTPUT_BYTES` → consumption stops, `abort()` was called **once**, the
    terminal is `end` with `truncated: true`, and `Buffer.byteLength(text)` is `<= MAX_OUTPUT_BYTES`;
  - a multi-byte delta at the boundary is dropped whole, so the text round-trips through
    `Buffer.from(text).toString()` unchanged (no replacement character);
  - usage from `message_start` and `message_delta` is merged into one `LlmUsage`;
  - **every** case: exactly one terminal event, and it is the last thing yielded.
- **Green:** `functions/src/llm/stream.ts`.
- **Refactor:** the header — one terminal event always, and why the cap drops a whole delta.

### T8 — The client port, the fake, and the fixtures → enables T9

- **Red:** `functions/src/llm/fake.spec.ts` — `buildFakeStream` **throws** when
  `FUNCTIONS_EMULATOR` is unset (`hl/fake.spec.ts`'s gate case, one slice on); with it set, each
  marker selects the documented behaviour, asserted by consuming the stream and checking the
  event kinds rather than by reaching into internals; an unmarked prompt replays `reply.json`.
  `scripts/ensure-secret-local.spec.mjs` — writes the file from the example when absent, and
  **does not touch it** when it already exists.
- **Green:** `npm --prefix functions install @anthropic-ai/sdk@^0.117.1`;
  `functions/src/llm/client.ts` (secret, port, lazy import, emulator switch);
  `functions/src/llm/fake.ts`; the three fixtures; `functions/src/llm/index.ts`;
  `scripts/ensure-secret-local.mjs`; `functions/.secret.local.example`; the `package.json` script
  wiring (`dev`, `emulators`, `test:integration`, `test:e2e`) and
  `GENERATE_TEST_KEEPALIVE_MS=250` on the two test scripts.
- **Refactor:** `functions/.env.example`'s `ANTHROPIC_API_KEY` block — replace "Used from Slice 5"
  with the `firebase functions:secrets:set` and `.secret.local` instructions actually needed.

> **Why the ensure-script exists.** `functions/.secret.local` is gitignored, so a fresh clone does
> not have it. The functions emulator resolves a declared secret by reading that file and, failing
> that, calling Secret Manager — which on a demo project with no credentials logs
> `ERROR … Unable to access secret environment variables` on the first `/generate` invocation. It
> does not prompt and does not abort, so nothing breaks; but the definition of done says the
> emulator run is clean from a fresh clone, and a red ERROR line in every local demo is not clean.
> The placeholder is never used: under the emulator `openStream` takes the fake path and never
> constructs the SDK client.

### T9 — `POST /generate`, the boundary half → AC-10 (L4), AC-20, AC-21, AC-22, AC-23, AC-24 (L4)

Everything decided **before** `flushHeaders()` (D9, R6), and its tests, land before any byte is
streamed.

- **Red, L4:** `tests/integration/generate.spec.ts`, using new helpers in `tests/integration/helpers.ts`
  (`GENERATE_URL` pointing at the **`generate` function**, not `api`; `postGenerate`; `readSseFrames`).
  Every case asserts the response is **JSON, not an event stream** — `content-type` does not contain
  `text/event-stream` — which is the half of D9 a status-code assertion cannot see. Cases: no
  `Authorization` → 401 `unauthenticated`, nothing written; an unverified token → 403
  `email_unverified`, nothing written; alice posting bob's project id → 404 `not_found` and **bob's
  transcript byte-identical** (AC-22); a soft-deleted id and a never-existing id → 404, nothing
  written (AC-23); each of `content`/`role`/`uid` as an extra key, a missing `projectId`, a
  numeric one, a 65-character one and `bad!id` → 400 `invalid_body`, nothing written (AC-24); a
  project whose only message is an assistant one, and a project with no messages → 400
  `empty_context`, nothing written (AC-10).
- **Green:** `functions/src/lib/errors.ts`'s `sendHttpError`; `functions/src/generate.ts`'s
  `onRequest` wrapper and the pre-flush half of `handleGenerate`, ending at step 5.
- **Refactor:** the module header — the flush is the boundary, and everything cheap is decided
  before it deliberately.

### T10 — The stream itself → AC-1, AC-2, AC-3, AC-5, AC-19

- **Red, L1:** `functions/src/generate.spec.ts` — `logGeneration` emits **one** `console.info`
  line, parseable as JSON, whose `event` is `generation.complete` and which carries `model`,
  `stopReason` and the four token counts including `cacheReadInputTokens`; given an outcome whose
  text is a distinctive string, **that string does not appear anywhere in the emitted line**.
- **Red, L4:** `generate.spec.ts` — a verified attested caller with one user message gets `200`,
  `content-type: text/event-stream; charset=utf-8`, `cache-control: no-cache, no-transform`,
  `x-accel-buffering: no`; the frames are one or more `token`s followed by **exactly one** `done`
  (AC-1); exactly one new assistant message exists, its `content` equals the concatenation of the
  `token` texts, its stored `seq` is `1`, `truncated` is `false`, and the `done` frame's `message`
  deep-equals that document in wire shape (AC-2); a subsequent `GET` of the transcript returns the
  user message before the assistant one and both carry `truncated: false` (AC-3); with the
  `__slow` marker, **at least one comment frame arrives before the first `token`** (AC-19).
- **Green:** the post-flush half of `handleGenerate` — the keep-alive interval, the consume loop,
  `appendAssistantMessage`, the `done` frame, `logGeneration`.
- **Refactor:** the keep-alive comment naming D28 and why the interval is overridable **only**
  under the emulator.

### T11 — Failure and interruption → AC-12, AC-13, AC-14, AC-16 (L4), AC-17, AC-18

- **Red, L4:** `generate.spec.ts` —
  - `__fail_midstream`: two `token` frames then **exactly one** `error` frame with code `upstream`;
    one assistant message exists carrying those two tokens' text with `truncated: true`; the frame's
    `message` deep-equals it (AC-12);
  - `__fail_upfront`: one `error` frame, `message: null`, and **no** assistant message (AC-13);
  - `__refuse`: one `error` frame code `refused`, `message: null`, nothing written (AC-14);
  - `__long`: ends in `done`, the persisted message is `truncated: true`, and
    `Buffer.byteLength(content)` is `<= 800_000` (AC-16);
  - `__slow`, abort the client fetch after two `token` frames: poll Firestore until one assistant
    message appears, and assert it carries the two tokens' text with `truncated: true` (AC-17);
  - `__slow`, abort **before** the first token: wait past the point the stream would have
    completed, and assert the collection still holds only the user message (AC-18);
  - **R1 end to end:** post a user message, seed a truncated assistant message past the routes,
    `POST /generate`, and assert it streams normally — the trailing assistant was dropped and no
    prefill 400 occurred.
- **Green:** the `req.on('close')` handler, `clientGone`, and the terminal table above.
- **Refactor:** the terminal handler's comment — success and interruption are one code path
  because the client renders them the same way (D9).

> **AC-17's timing, and how not to write it flaky.** The assertion is about what the *server* does
> after the client has gone, so there is nothing to await on the client side. Poll
> `adminDb()` for the assistant document with a bounded retry (20 × 100 ms) rather than a fixed
> sleep, and for AC-18 wait a fixed interval **longer than `__slow`'s full run** before asserting
> the absence — an absence assertion that races is an absence assertion that passes for the wrong
> reason.

### T12 — The deployment surface → AC-25

- **Red:** `functions/src/index.spec.ts` — `deployed.generate.__endpoint.secretEnvironmentVariables`
  contains `{ key: 'ANTHROPIC_API_KEY' }`; `.timeoutSeconds` is `540`; `.availableMemoryMb` is
  `512`. Plus a **source scan**: `functions/src/generate.ts` references both `withVerifiedUser` and
  `requireAppCheck`, and `functions/src/messages/index.ts`'s `POST` route still carries `attested`
  and `withVerifiedUser`.
- **Green:** the options on the `generate` export; a comment in `index.ts` saying the options moved
  to `generate.ts`, where the secret is declared.
- **Refactor:** extend `index.spec.ts`'s header — why a structural assertion is the only kind that
  can see the deployment surface.

> **Honest about what the scan proves.** `__endpoint` carries the secret, the timeout and the
> memory, and nothing about middleware. A source scan is the same technique AC-6 and
> `no-firestore.spec.ts` already use, and the *behavioural* proof that the guards run is T9's
> 401 and 403 over the wire. Neither alone is enough; the plan says so rather than implying the
> structural test is stronger than it is.

### T13 — Rules, re-asserted → AC-26, AC-27

- **Red:** `tests/rules/firestore.spec.ts` — the `message()` payload gains `truncated: false`, and
  a second variant with `truncated: true` is added to the owner's `setDoc` case, so the denial is
  proven for the new field too. Every existing case in the file re-runs unchanged (AC-27). All
  `assertFails`; there is no `assertSucceeds` import in this file and there must not be one after.
- **Green:** **no rules change** (D35). `firestore.rules`'s messages block already denies
  everything, and rules say nothing about fields — this task exists because the definition of done
  requires the denial re-proven in the commit that changes the collection's shape.
- **Refactor:** none.

### T14 — The client-side SSE parser → AC-28, AC-29

- **Red:** `frontend/src/lib/sse.spec.ts`, driving the parser from a **chunk sequence** rather than
  a string. A helper splits a known byte stream at every offset from 1 to its length and asserts
  the parsed events are identical each time — which covers mid-`event:`, mid-`data:`, mid-JSON and
  mid-terminator without hand-picking the interesting offsets. Plus: a comment frame yields
  nothing; an unknown event name is returned and does not throw; a `data` line that is not valid
  JSON is dropped and **the frame after it still parses** (the desync case, which is the one that
  matters); a `data` payload containing an escaped `\n` survives; two frames in one chunk yield two
  events.
- **Green:** `frontend/src/lib/sse.ts`.
- **Refactor:** the header — R4 in full, and why splitting at every offset beats three hand-written
  splits.

### T15 — `authHeaders()` and the stream client → AC-30, AC-31

- **Red:** `frontend/src/lib/apiClient.spec.ts` — `authHeaders()` resolves to both
  `Authorization: Bearer …` and `X-Firebase-AppCheck`, and rejects with a 401 `ApiError` when there
  is no signed-in user. `frontend/src/lib/generateApi.spec.ts`, stubbing `fetch` — the request is a
  `POST` to `/generate` with a body of exactly `{"projectId":"proj-1"}`, `Content-Type:
  application/json`, and both auth headers; a 404 response rejects with an `ApiError` carrying the
  server's message and status **and yields no events**; a 200 whose body streams two `token` frames
  and a `done` yields three parsed events in order; an aborted signal ends the generator.
  `frontend/src/lib/no-firestore.spec.ts` is unchanged and must stay green (AC-30's second clause).
- **Green:** `authHeaders()` exported and used by `request`; `frontend/src/lib/generateApi.ts`.
- **Refactor:** the header — why a streaming call cannot use `request`, and why the credential
  minting is shared rather than repeated (D32).

### T16 — The store → AC-32 … AC-37

- **Red:** `frontend/src/stores/workspace.spec.ts`, extending Slice 4's `fetch`-stubbing pattern so
  the headers on the stream request are asserted against what would actually go on the wire. The
  stub returns a `Response` whose `body` is a `ReadableStream` the test can push frames into and
  close, which is what makes "tokens accumulate" observable. Cases:
  - `send()` issues `POST /api/projects/proj-1/messages` **then** `POST /generate`, in that order,
    and issues **no `GET`** of the transcript (AC-32);
  - a rejected message write opens no stream, appends nothing, keeps the draft, sets `sendError`
    (AC-33);
  - `token` events grow `streamingText` to their concatenation while `messages` is unchanged; on
    `done` the returned message is appended, `streamingText` is `''`, `generating` is false (AC-34);
  - `error` with a `message` appends it and sets `generateError`; `error` with `message: null`
    appends nothing and sets `generateError`; both clear `streamingText` and `generating` (AC-35);
  - `retryGeneration()` issues `POST /generate` and **no** message write (AC-36);
  - with a stream open, `reset()` aborts the request, and a frame delivered afterwards mutates
    nothing; opening a second project aborts the first's stream and leaves `messages`,
    `streamingText` and `generating` belonging to the second (AC-37);
  - `canSend` is false while `generating` is true.
- **Green:** the store changes above.
- **Refactor:** the store header — why `streamingText` is a re-assigned `ref<string>` and not an
  array of chunks (D31, and `typescript-vue.md`'s accumulation trap).

### T17 — The chat panel → AC-38, AC-39, AC-40, AC-41, AC-43

- **Red:** `frontend/src/components/workspace/ChatPanel.spec.ts`, extending the existing
  `reactive` mocked store with `generating`, `streamingText`, `generateError` and
  `retryGeneration`. Cases: `generating` true renders a badge reading `Generating…` and a
  `streaming-bubble` carrying `streamingText` (AC-38); the string `Echo mode` appears **nowhere**
  in the rendered output, and a source scan over `frontend/src` finds it in no file (AC-38's second
  clause); `generating` false renders no `Generating…` badge (AC-39); a message with
  `truncated: true` renders `message-interrupted` and one with `truncated: false` does not (AC-40);
  `generateError` renders the message and a `generate-retry` whose click calls `retryGeneration`
  **exactly once** (AC-41); with the viewport's `scrollHeight` stubbed, growing `streamingText`
  sets `scrollTop` to it after `flushPromises()` (AC-43).
- **Green:** `ChatPanel.vue` as specified.
- **Refactor:** the header — the badge and the echo went together, as Slice 4 said they would; the
  streaming bubble sits inside the list so one scroll mechanism covers both.

### T18 — The composer → AC-42

- **Red:** `MessageComposer.spec.ts` — with `generating` true the textarea and the button are
  `disabled` and pressing Enter calls `send` zero times; with it false and a non-empty draft, Enter
  calls `send` once. The existing at-limit, blank-draft, Shift+Enter and `sendError` cases stay.
- **Green:** `:disabled="workspace.atLimit || workspace.sending || workspace.generating"` on the
  textarea; the button already keys off `canSend`, which now includes `!generating`.
- **Refactor:** the header — a stream in flight is a third reason not to send, beside the cap and
  a send already going.

### T19 — End to end → AC-44

- **Red:** `tests/e2e/workspace.spec.ts` — the T2 placeholder assertion is replaced by the real
  one. One test, three movements:
  1. **The failed open and Retry.** `page.route('**/generate', route => route.abort())` before the
     first send. Type the prompt, Enter: the user bubble appears, no assistant message, a
     `generate-error` and a `generate-retry`. `page.unroute('**/generate')`, click Retry: a reply
     streams in — assert `streaming-bubble` is visible with **shorter** text at one point than the
     finished bubble's, which is the progressive assertion R3 depends on — then a second
     `message-bubble` with `data-role="assistant"`. Reload: both messages are still there.
  2. **Interruption and partial preservation.** Send a second prompt containing `__slow`;
     mid-stream, click **Back to dashboard**; re-open the project. The partial assistant reply is in
     the transcript with a visible `message-interrupted` marker.
  3. The `Generating…` badge is present during a stream and gone after it.
  The Shift+Enter and deleted-project tests are unchanged.
- **Green:** nothing new — every part exists by T18. A failure here is real.
- **Refactor:** none.

> **Why the interruption and the Retry are two different mechanisms.** They cannot be one. After an
> interrupted turn the transcript is `user, assistant(truncated)`, and D6 drops the trailing
> assistant — so a Retry sees **exactly the same context as the first attempt**, and a fake that
> failed on a marker in the last user message would fail identically forever. Retry is therefore
> driven by a transport failure Playwright can withdraw (`route.abort()` then `unroute`), and
> partial preservation by a real navigation away from a `__slow` stream. Both are real user paths;
> neither is a contrivance. The plan says this so the build session does not spend an hour
> discovering it.

### T20 — Documentation

- **Red:** none — prose.
- **Green:** `docs/IMPLEMENTATION_PLAN.md` §0's status table, §4's Slice 5 entry (marked shipped,
  with D6/D15/D16 recorded as the decisions a later slice revisits), §8's LLM-provider row, and
  §9's conformance rows for F3.1, F4.1–4.3, F6.2, F6.5 and F8.2; `docs/PRODUCT_SPEC.md` §7.1's
  `@anthropic-ai/sdk` row marked shipped with the pinned version. `README`: the
  `ANTHROPIC_API_KEY` / `.secret.local` setup step is a **new** step — note it in the plan's Slice
  13 checklist rather than rewriting the README here.
- **Refactor:** none.

## AC → task coverage

| AC | Task(s) | AC | Task(s) |
|---|---|---|---|
| AC-1 | T10 | AC-23 | T9 |
| AC-2 | T10 | AC-24 | T3, T9 |
| AC-3 | T2, T10 | AC-25 | T12 |
| AC-4 | T2 | AC-26 | T13 |
| AC-5 | T10 | AC-27 | T13 |
| AC-6 | T6 | AC-28 | T14 |
| AC-7 | T4 | AC-29 | T14 |
| AC-8 | T5 | AC-30 | T15 |
| AC-9 | T5 | AC-31 | T15 |
| AC-10 | T5, T9 | AC-32 | T16 |
| AC-11 | T7 | AC-33 | T16 |
| AC-12 | T7, T11 | AC-34 | T16 |
| AC-13 | T11 | AC-35 | T16 |
| AC-14 | T11 | AC-36 | T16 |
| AC-15 | T7 | AC-37 | T16 |
| AC-16 | T7, T11 | AC-38 | T17 |
| AC-17 | T11 | AC-39 | T17 |
| AC-18 | T11 | AC-40 | T1, T17 |
| AC-19 | T10 | AC-41 | T17 |
| AC-20 | T9 | AC-42 | T18 |
| AC-21 | T9 | AC-43 | T17 |
| AC-22 | T9 | AC-44 | T19 |

**Every acceptance criterion maps to at least one task.** Two carry a note:

- **AC-25** is split deliberately: the secret binding, timeout and memory are structural
  assertions on `__endpoint` (T12), the middleware is a source scan (T12), and the behaviour is
  T9's 401/403 over the wire. No single test proves the whole AC, and the plan does not pretend one
  does.
- **AC-30's second clause** — no `firebase/firestore` import under `frontend/src` — is carried by
  the **existing** `frontend/src/lib/no-firestore.spec.ts`, which needs no edit. It is listed under
  T15 because that is the task that would break it.

## Firestore rules changes

**None** (D35). `firestore.rules`'s existing block already denies every operation on
`users/{uid}/projects/{projectId}/messages/{messageId}` to every client, and a Firestore rule that
denies a document denies it whatever fields it has. The `truncated` field changes nothing a rule
can see.

What T13 does is re-**prove** it, because the definition of done requires a collection's denial
asserted in the commit that changes its shape:

| Case | Client | Operations |
|---|---|---|
| The owner, verified | `verified('alice')` | `getDoc`, `getDocs`, `setDoc` (with `truncated: false` **and** with `truncated: true`), `updateDoc`, `deleteDoc` |
| A different verified user | `verified('mallory')` | the same, on alice's path |
| Anonymous | `unauthenticatedContext()` | `getDoc`, `getDocs`, `setDoc` |
| AC-27 re-assertion | existing describes | `users/{uid}`, `users/{uid}/projects/{projectId}`, `hlConnections/{uid}`, `authThrottle/{key}` — unchanged, re-run |

The seeded payload is exactly what `appendAssistantMessage` and `handleCreateMessage` write, so the
denial is on the rule and not on the shape.

**Indexes:** unchanged. `transcriptQuery` still orders by `createdAt` then `seq`, and Slice 4's
composite index is still the one it needs.

## Dependencies

**One new package.** `@anthropic-ai/sdk@^0.117.1`, in `functions/` only — the exact package the
brief names, and the only way to satisfy `CLAUDE.md`'s `client.messages.stream()` requirement.
Pinned to `^0.117.1` because that release types `output_config.effort` and `MessageStreamParams`,
which is what makes R8 a non-issue rather than a casting exercise.

Nothing new on the frontend. The SSE parser is thirty lines of string handling, and the three
payload shapes are narrowed with hand-written type guards rather than by adding Zod to a package
that has never had it — `messagesApi.ts` already establishes that convention.

## Manual verification

```bash
npm run dev          # emulators + SPA against them, one command
```

1. Sign up, verify through the emulator link, create a project, open it.
2. The chat header shows **no** badge. There is no `Echo mode` anywhere.
3. Type `build a contact dashboard`, press **Enter**. The user bubble appears immediately; the
   header badge reads **Generating…**; text appears a few characters at a time in a placeholder
   bubble; the composer is disabled throughout. On completion the badge disappears and the reply is
   a normal bubble.
4. Reload. Both messages are still there, in order, from the server.
5. Open devtools → Network. There is one `POST /api/projects/<id>/messages` and one
   `POST /generate`; the second is `text/event-stream` and its response pane **grows** rather than
   arriving at once — this is R3's check, and a fully buffered response here means the Vite dev
   proxy is buffering.
6. Type `__slow build a dashboard`, Enter, and click **Back to dashboard** mid-reply. Re-open the
   project: the partial reply is there with an **interrupted** marker.
7. Type `__fail_midstream`, Enter. Two words arrive, then an error and a **Retry** button, and the
   partial is in the transcript marked interrupted.
8. Type `__refuse`, Enter. "Claude declined to answer that. Try rephrasing." and no assistant
   message is added.
9. Check the functions emulator log for one `generation.complete` line per turn, carrying the model,
   the stop reason and four token counts — and **no message text**.
10. Confirm the emulator log carries no `Unable to access secret environment variables` error;
    `functions/.secret.local` was created by the ensure-script on first run.

The real LLM is exercised only by pointing a build at a deployed function with a real key, which is
Slice 13's checklist item (R2). Nothing in the automated suite ever calls Anthropic.

## Estimate

| Task | Estimate |
|---|---|
| T1 — `truncated` on the schema | 30m |
| T2 — One document per POST, echo deleted | 1h |
| T3 — `/generate` body schema | 25m |
| T4 — System prompt and breakpoint | 40m |
| T5 — Context builder | 45m |
| T6 — Request parameters | 40m |
| T7 — Stream mapper | 1h 45m |
| T8 — Client port, fake, fixtures, secret script | 1h 45m |
| T9 — `/generate` boundary half | 1h 30m |
| T10 — The stream itself | 1h 45m |
| T11 — Failure and interruption | 2h |
| T12 — Deployment surface | 30m |
| T13 — Rules re-assertion | 30m |
| T14 — Client SSE parser | 1h |
| T15 — `authHeaders()` and stream client | 1h |
| T16 — The store | 1h 45m |
| T17 — Chat panel | 1h 15m |
| T18 — Composer | 25m |
| T19 — End to end | 1h 30m |
| T20 — Documentation | 30m |
| **Total** | **≈ 21h** |

Nothing exceeds half a day. **T11 is the one to watch** — it is the only task whose tests are
inherently timing-shaped, and the mitigation is written into the task: bounded polling for the
presence assertions, and a wait longer than the fake's full run for the absence one. **T8** is
second: it touches four `package.json` scripts, a new build script and a gitignored file, and a
mistake there is invisible until CI. **T10** and **T16** are large in test count rather than in
difficulty.

## Open risks carried from the PRD

**R1** (trailing assistant = prefill = 400) is answered three times: T5's L1 cases over one and
three trailing assistants, T11's L4 seed-and-retry, and T19's real interruption followed by a real
Retry. **R2** (a generation outlived by the path in front of it) cannot be tested from an emulator
and is a Slice 13 hand-check, as the PRD says; the three cheap levers — flush before the first
byte, keep-alives, `effort: 'low'` — are all in T9 and T10. **R3** (a buffering dev proxy) is
answered by T19's progressive-text assertion, which runs through that proxy, and by manual step 5.
**R4** (chunk-split frames) is answered by T14's split-at-every-offset case rather than by three
hand-picked splits. **R5** (spend) is bounded, not solved, and named. **R6** (two error channels) is
answered by T9 asserting JSON *and* a non-stream content type, and T11 asserting `error` frames on
a 200. **R7** (a new field on old documents) is T1's first case. **R8** is resolved — the pinned SDK
types both parameters, and no cast appears anywhere in this plan. **R9** (deleting the echo breaks
green tests) is handled inside T2 rather than deferred.

## Blocked

Nothing. Every file, symbol and pattern this plan names was read in the repository before it was
written, and the SDK's surface — `output_config.effort`, `MessageStream`'s `abort()` and async
iterator, `stop_details`, the `resources/messages` type subpath — was checked against
`@anthropic-ai/sdk@0.117.1` itself rather than recalled.
