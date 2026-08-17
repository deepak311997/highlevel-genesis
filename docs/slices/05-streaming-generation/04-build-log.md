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
