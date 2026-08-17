import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  MessageParam,
  MessageStreamEvent,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages'

import { isEmulator } from '../lib/env'
import { PROJECT_FILE_OPEN } from './projectState'
import { MAX_OUTPUT_BYTES, type LlmStream } from './stream'

/**
 * A stand-in for the model, mounted only under the emulator.
 *
 * ## Why this exists
 *
 * Every automated test in this project stubs the LLM, and the integration and
 * e2e suites need to drive a *stream* — token by token, with a mid-stream
 * failure, a refusal, a truncation and a slow one. None of that can come from a
 * network call to Anthropic: it would cost money on every CI run, it would be
 * non-deterministic, and the failure cases could not be produced on demand.
 *
 * ## Why it is gated on FUNCTIONS_EMULATOR and nothing else (D20)
 *
 * Deployed, this is not a test double. It is an endpoint that charges nothing,
 * answers nothing, and looks exactly like the product — a user would never know.
 * `FUNCTIONS_EMULATOR` is the one signal an operator cannot set by hand and a
 * deploy cannot carry, which is `buildFakeHlRouter`'s argument one slice on: a
 * config flag here would be a remotely-settable way to replace the model.
 *
 * The gate is checked **inside this function**, not only where it is called, so a
 * stray import cannot reach around it.
 *
 * ## Behaviour is selected by a marker in the last user message
 *
 * Rather than a control API, the prompt says what should happen, so a test reads
 * as `prompt('__fail_midstream …')` and the intent is on the page:
 *
 * | Marker | Behaviour |
 * |---|---|
 * | `__fail_midstream` | Two text deltas, then the iterator throws |
 * | `__fail_upfront`   | Throws before any text delta |
 * | `__refuse`         | `refusal.json` — `stop_reason: 'refusal'`, no content |
 * | `__max_tokens`     | `max-tokens.json` |
 * | `__long`           | `reply.json`'s text repeated past `MAX_OUTPUT_BYTES` |
 * | `__slow`           | `reply.json`, with a long pause before the first token |
 * | `__no_files`       | `prose-only.json` — a legitimate reply with no blocks (D17) |
 * | `__bad_path`       | `bad-path.json` — a block naming `../secrets.js` |
 * | `__unterminated`   | `unterminated.json` — a block that never closes |
 * | `__dup_files`      | `duplicate-files.json` — one path written twice |
 * | `__context`        | One token: the system blocks, messages and paths it was sent |
 * | *(none)*           | `reply.json`, a few tokens a second |
 *
 * The four file-shaped failures are **fixtures rather than L1-only inputs**
 * because F8.1 is a user-facing requirement: an L1 test of `validateFileOps`
 * asserts intent, and what F8.1 needs is the assertion that no document exists.
 * Oversize and too-many-files stay at L1, because a fixture carrying
 * 100 KB × 21 is a fixture nobody can read.
 *
 * The **last** user message, deliberately: reading the whole conversation would
 * make one `__refuse` poison every later turn of that project, which is exactly
 * what a Retry test needs not to happen.
 *
 * ## Fixtures are the wire shape; behaviour is applied on top
 *
 * `tests/fixtures/llm/` holds recorded event sequences — the part worth
 * recording. Delay, repetition and injected failure are layered here, because a
 * fixture holding 800 KB of literal text, or one fixture per timing variant,
 * would be a fixture nobody can read.
 */

/**
 * Enough of `MessageStreamParams` for the marker to be found — and, since Slice
 * 9, for `__context` to describe what it was sent (D25).
 *
 * `system` is optional because that is how the SDK types it, not because a
 * caller may sensibly omit it: every real call carries the stable prefix. The
 * optionality is what keeps the existing tests, which pass `{ messages }` alone,
 * saying exactly what they mean.
 */
interface FakeParams {
  messages: readonly MessageParam[]
  system?: string | readonly TextBlockParam[] | undefined
}

/**
 * The default pause per token — not decoration.
 *
 * It is what makes AC-44's "text appears progressively" a real assertion, and
 * what makes R3 (a buffering Vite dev proxy) show up as an e2e failure rather
 * than a mystery. A fake that delivered its whole reply in one tick would let a
 * fully buffered stream pass every test.
 */
const DELTA_MS = 40

/** Long enough that a keep-alive comment has to arrive first (D28, AC-19). */
const SLOW_FIRST_MS = 600
const SLOW_DELTA_MS = 150

const MARKERS = [
  '__fail_midstream',
  '__fail_upfront',
  '__refuse',
  '__max_tokens',
  '__long',
  '__slow',
  '__no_files',
  '__bad_path',
  '__unterminated',
  '__dup_files',
  '__context',
] as const

type Marker = (typeof MARKERS)[number]

/**
 * Read from `tests/fixtures/llm/`, **inside the call and never at module scope.**
 *
 * `functions/lib/` is what deploys and `tests/` is not, so a module-scope read
 * would fail `firebase deploy`'s module analysis for code that never runs there.
 * The relative path is the same from `src/llm` under Vitest and from `lib/llm`
 * in a build, which is why it is anchored on `__dirname` rather than the cwd.
 */
function loadEvents(name: string): MessageStreamEvent[] {
  const path = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'llm', name)
  return JSON.parse(readFileSync(path, 'utf8')) as MessageStreamEvent[]
}

function isTextDelta(event: MessageStreamEvent): boolean {
  return event.type === 'content_block_delta' && event.delta.type === 'text_delta'
}

function textOf(event: MessageStreamEvent): string {
  return event.type === 'content_block_delta' && event.delta.type === 'text_delta'
    ? event.delta.text
    : ''
}

function lastUserText(messages: readonly MessageParam[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    // Only string content is ever produced by `buildContext`; a block array
    // would mean something upstream changed, and returning '' selects the
    // ordinary reply rather than guessing.
    return typeof message.content === 'string' ? message.content : ''
  }
  return ''
}

function markerFor(messages: readonly MessageParam[]): Marker | undefined {
  const prompt = lastUserText(messages)
  return MARKERS.find((marker) => prompt.includes(marker))
}

/**
 * `reply.json`'s text, repeated past the cap.
 *
 * Chunked at roughly 64 KB rather than replayed delta by delta, so this is a
 * dozen events rather than tens of thousands — the cap is about volume, and a
 * test that spends a minute proving it is a test nobody runs.
 */
function longEvents(): MessageStreamEvent[] {
  const base = loadEvents('reply.json')
  const unit = textOf(base.find(isTextDelta) ?? ({} as MessageStreamEvent)) || 'lorem ipsum '
  const chunk = unit.repeat(Math.ceil(64_000 / unit.length))
  const count = Math.ceil(MAX_OUTPUT_BYTES / Buffer.byteLength(chunk, 'utf8')) + 2

  const deltas: MessageStreamEvent[] = Array.from({ length: count }, () => ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: chunk },
  }))

  const start = base.filter((event) => event.type === 'message_start')
  const finish = base.filter(
    (event) => event.type === 'message_delta' || event.type === 'message_stop',
  )

  return [...start, ...deltas, ...finish]
}

/**
 * The paths named by a project-state block, in the order it lists them.
 *
 * Read with {@link PROJECT_FILE_OPEN}, the builder's **own exported delimiter**,
 * so the reader and the writer cannot drift (D25). A literal `'===== FILE '`
 * here would be a second definition of the format, and the first one to change
 * would go unnoticed — which is exactly the failure this marker exists to catch
 * elsewhere.
 *
 * The manifest of omitted files renders as `- path (n characters)` and so does
 * not match: what is reported is what the model was actually **shown**, which is
 * the question AC-27 asks.
 */
function pathsIn(block: string): string[] {
  return block
    .split('\n')
    .filter((line) => line.startsWith(PROJECT_FILE_OPEN))
    .map((line) => line.slice(PROJECT_FILE_OPEN.length).split(' (')[0] ?? '')
    .filter((path) => path !== '')
}

/**
 * `__context` — a report of the request, as one text delta (D25).
 *
 * Built programmatically rather than from a fixture, like {@link longEvents},
 * because the answer depends on the input: a recorded sequence could only ever
 * describe a request somebody typed out by hand, which is the opposite of what
 * this is for.
 *
 * The report is deliberately **counts and paths, never content**. A fake that
 * echoed the blocks back would put the whole project's code through the SSE
 * stream and into every test's failure output, and it would make this marker a
 * way to read a prompt rather than a way to check a wiring.
 */
function contextEvents(params: FakeParams): MessageStreamEvent[] {
  const blocks = typeof params.system === 'string' ? [] : (params.system ?? [])
  const report = {
    systemBlocks: typeof params.system === 'string' ? 1 : blocks.length,
    messages: params.messages.length,
    // The project state is the last block when it is present at all; when it is
    // not, there is nothing to read and the answer is honestly empty.
    paths: pathsIn(blocks.at(-1)?.text ?? ''),
  }

  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_01FakeContextReport',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: JSON.stringify(report) },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ] as MessageStreamEvent[]
}

interface Plan {
  events: MessageStreamEvent[]
  /** Throw once this many text deltas have been yielded. */
  throwAfter?: number
  firstDelayMs: number
  deltaDelayMs: number
}

function planFor(params: FakeParams): Plan {
  const marker = markerFor(params.messages)

  switch (marker) {
    case '__context':
      return { events: contextEvents(params), firstDelayMs: 0, deltaDelayMs: 0 }
    case '__refuse':
      return { events: loadEvents('refusal.json'), firstDelayMs: 0, deltaDelayMs: 0 }
    case '__max_tokens':
      return {
        events: loadEvents('max-tokens.json'),
        firstDelayMs: DELTA_MS,
        deltaDelayMs: DELTA_MS,
      }
    case '__long':
      return { events: longEvents(), firstDelayMs: 0, deltaDelayMs: 0 }
    case '__slow':
      return {
        events: loadEvents('reply.json'),
        firstDelayMs: SLOW_FIRST_MS,
        deltaDelayMs: SLOW_DELTA_MS,
      }
    case '__fail_midstream':
      return {
        events: loadEvents('reply.json'),
        throwAfter: 2,
        firstDelayMs: DELTA_MS,
        deltaDelayMs: DELTA_MS,
      }
    case '__no_files':
      return {
        events: loadEvents('prose-only.json'),
        firstDelayMs: DELTA_MS,
        deltaDelayMs: DELTA_MS,
      }
    case '__bad_path':
      return { events: loadEvents('bad-path.json'), firstDelayMs: DELTA_MS, deltaDelayMs: DELTA_MS }
    case '__unterminated':
      return {
        events: loadEvents('unterminated.json'),
        firstDelayMs: DELTA_MS,
        deltaDelayMs: DELTA_MS,
      }
    case '__dup_files':
      return {
        events: loadEvents('duplicate-files.json'),
        firstDelayMs: DELTA_MS,
        deltaDelayMs: DELTA_MS,
      }
    case '__fail_upfront':
      return { events: loadEvents('reply.json'), throwAfter: 0, firstDelayMs: 0, deltaDelayMs: 0 }
    default:
      return { events: loadEvents('reply.json'), firstDelayMs: DELTA_MS, deltaDelayMs: DELTA_MS }
  }
}

const sleep = (ms: number): Promise<void> =>
  ms === 0 ? Promise.resolve() : new Promise((done) => setTimeout(done, ms))

/** What the injected failures throw. Shaped like an upstream error, not ours. */
class FakeUpstreamError extends Error {
  constructor() {
    super('The fake model failed mid-stream, on request.')
    this.name = 'FakeUpstreamError'
  }
}

/**
 * An `LlmStream` the mapper cannot tell apart from the SDK's.
 *
 * `abort()` really stops production, because two things depend on it: the byte
 * cap and the client-disconnect handler. A fake that ignored it would make both
 * of them look like they worked.
 */
export function buildFakeStream(params: FakeParams): Promise<LlmStream> {
  if (!isEmulator()) {
    return Promise.reject(
      new Error(
        'The fake LLM is emulator-only and must never be reachable in a deployed build. ' +
          'It is gated on FUNCTIONS_EMULATOR alone (D20).',
      ),
    )
  }

  const plan = planFor(params)
  let aborted = false

  return Promise.resolve({
    abort(): void {
      aborted = true
    },

    async *[Symbol.asyncIterator](): AsyncGenerator<MessageStreamEvent> {
      let delivered = 0

      for (const event of plan.events) {
        if (isTextDelta(event)) {
          if (plan.throwAfter !== undefined && delivered === plan.throwAfter) {
            throw new FakeUpstreamError()
          }
          await sleep(delivered === 0 ? plan.firstDelayMs : plan.deltaDelayMs)
          if (aborted) return
          delivered += 1
        }

        yield event

        /*
         * Checked *after* the yield rather than at the top of the loop, and both
         * halves matter. `abort()` is called by the consumer while this
         * generator is suspended at the yield above, so this is the first point
         * that can observe it — and a check before the first suspension would be
         * reading a value nothing has had the chance to change.
         */
        if (aborted) return
      }

      // A plan that asked to fail after more deltas than the fixture has still
      // fails, rather than quietly succeeding.
      if (plan.throwAfter !== undefined && delivered <= plan.throwAfter) {
        throw new FakeUpstreamError()
      }
    },
  })
}
