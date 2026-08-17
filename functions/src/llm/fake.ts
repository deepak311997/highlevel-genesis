import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { MessageParam, MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'

import { isEmulator } from '../lib/env'
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
 * | *(none)*           | `reply.json`, a few tokens a second |
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

/** Enough of `MessageStreamParams` for the marker to be found. */
interface FakeParams {
  messages: readonly MessageParam[]
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

interface Plan {
  events: MessageStreamEvent[]
  /** Throw once this many text deltas have been yielded. */
  throwAfter?: number
  firstDelayMs: number
  deltaDelayMs: number
}

function planFor(messages: readonly MessageParam[]): Plan {
  const marker = markerFor(messages)

  switch (marker) {
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

  const plan = planFor(params.messages)
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
