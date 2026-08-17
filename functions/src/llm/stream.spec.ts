import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it, vi } from 'vitest'

import { mapStream, MAX_OUTPUT_BYTES, type LlmEvent, type LlmStream } from './stream'

/**
 * The SDK's events, mapped to the three this slice emits — and **exactly one
 * terminal event, always.**
 *
 * The mapper owns accumulation, the byte cap and the thinking-delta filter, so
 * every one of them is driven from a hand-written event array with no emulator
 * and no network. That placement is the point: those three are precisely where
 * an R4-class bug hides, and if the handler owned them they would only be
 * reachable through an emulator-backed test.
 *
 * "Exactly one terminal, and it is last" is asserted on *every* case rather than
 * once, because the consumer writes a frame and persists a document on it. Two
 * terminals would write two assistant messages for one turn; none would leave a
 * stream that never ends.
 */

/** A `content_block_delta` carrying text. */
function text(value: string): MessageStreamEvent {
  return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } }
}

/** A thinking delta — the one AC-11 says must never become a `token`. */
function thinking(value: string): MessageStreamEvent {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: value },
  }
}

function signature(value: string): MessageStreamEvent {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: value },
  }
}

function messageStart(model = 'claude-opus-5'): MessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      context_management: null,
      container: null,
      stop_details: null,
      usage: {
        input_tokens: 120,
        output_tokens: 1,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 11,
        cache_creation: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
      },
    },
  } as unknown as MessageStreamEvent
}

function messageDelta(stopReason: string | null, outputTokens = 42): MessageStreamEvent {
  return {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
      container: null,
      stop_details: null,
    },
    usage: {
      input_tokens: null,
      output_tokens: outputTokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens_details: null,
    },
  } as unknown as MessageStreamEvent
}

const MESSAGE_STOP = { type: 'message_stop' } as MessageStreamEvent

/**
 * A stand-in for the SDK's `MessageStream`, with a spied `abort()`.
 *
 * `throwAfter` injects the failure the SDK produces when the connection drops
 * mid-stream: the async iterator itself throws, part-way through.
 */
function fakeStream(
  events: readonly MessageStreamEvent[],
  throwAfter?: number,
): LlmStream & { abort: ReturnType<typeof vi.fn> } {
  const abort = vi.fn()
  return {
    abort,
    async *[Symbol.asyncIterator]() {
      for (const [index, event] of events.entries()) {
        if (throwAfter !== undefined && index === throwAfter) {
          throw new Error('upstream exploded')
        }
        yield await Promise.resolve(event)
      }
      if (throwAfter !== undefined && throwAfter >= events.length) {
        throw new Error('upstream exploded')
      }
    },
  }
}

async function collect(stream: LlmStream): Promise<LlmEvent[]> {
  const out: LlmEvent[] = []
  for await (const event of mapStream(stream)) out.push(event)
  return out
}

/** The two events that may end a stream, and the only ones carrying usage. */
type Terminal = Exclude<LlmEvent, { kind: 'token' }>

/** Every case asserts this: many tokens, then exactly one terminal, last. */
function expectOneTerminal(events: LlmEvent[]): Terminal {
  const terminals = events.filter((event): event is Terminal => event.kind !== 'token')

  expect(terminals).toHaveLength(1)
  expect(events.at(-1)).toBe(terminals[0])
  // Destructured and checked rather than asserted with `as`: under
  // noUncheckedIndexedAccess the index read is `Terminal | undefined`, and a cast
  // would hide the one case worth a clear failure — no terminal at all.
  const [terminal] = terminals
  if (terminal === undefined) throw new Error('no terminal event was yielded')
  return terminal
}

const tokens = (events: LlmEvent[]): string[] =>
  events.filter((event) => event.kind === 'token').map((event) => event.text)

describe('mapStream — the happy path', () => {
  /** AC-11. Thinking and signature deltas produce no `token` at all. */
  it('forwards text deltas and drops every other delta', async () => {
    const events = await collect(
      fakeStream([
        messageStart(),
        thinking('let me consider the schema'),
        text('Here is '),
        signature('abc123'),
        text('a contact dashboard'),
        messageDelta('end_turn'),
        MESSAGE_STOP,
      ]),
    )

    expect(tokens(events)).toEqual(['Here is ', 'a contact dashboard'])
    const terminal = expectOneTerminal(events)
    expect(terminal.kind).toBe('end')
    expect(terminal.text).toBe('Here is a contact dashboard')
  })

  it('ends with truncated false on end_turn', async () => {
    const events = await collect(
      fakeStream([messageStart(), text('done'), messageDelta('end_turn'), MESSAGE_STOP]),
    )

    const terminal = expectOneTerminal(events)
    expect(terminal).toMatchObject({ kind: 'end', truncated: false, stopReason: 'end_turn' })
  })

  /** Usage is merged from both events that carry it (AC-5's inputs). */
  it('merges usage from message_start and message_delta', async () => {
    const events = await collect(
      fakeStream([messageStart(), text('hi'), messageDelta('end_turn', 99), MESSAGE_STOP]),
    )

    expect(expectOneTerminal(events).usage).toEqual({
      inputTokens: 120,
      outputTokens: 99,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 11,
    })
  })

  it('reports the model the API actually answered with', async () => {
    const events = await collect(
      fakeStream([messageStart('claude-opus-5'), text('hi'), messageDelta('end_turn')]),
    )

    expect(expectOneTerminal(events).model).toBe('claude-opus-5')
  })
})

describe('mapStream — the model stopped for a reason', () => {
  /*
   * AC-15, D23. `max_tokens` is a real, useful, incomplete answer — calling it an
   * error would offer a Retry for something that did not fail and would hide the
   * text that did arrive.
   */
  it('ends with truncated true on max_tokens, not an error', async () => {
    const events = await collect(
      fakeStream([messageStart(), text('a long answer'), messageDelta('max_tokens'), MESSAGE_STOP]),
    )

    expect(expectOneTerminal(events)).toMatchObject({
      kind: 'end',
      truncated: true,
      text: 'a long answer',
    })
  })

  /*
   * D18. A refusal is HTTP 200 with `stop_reason: 'refusal'` and no content, so
   * reading `content[0]` unconditionally would break on it — the stop reason is
   * read first, always.
   */
  it('reports a refusal as an error with no text', async () => {
    const events = await collect(
      fakeStream([messageStart(), messageDelta('refusal'), MESSAGE_STOP]),
    )

    expect(tokens(events)).toEqual([])
    expect(expectOneTerminal(events)).toMatchObject({ kind: 'error', code: 'refused', text: '' })
  })

  /* An unrecognised stop reason is not a failure: text arrived, and the client
   * renders it. Failing closed here would discard a complete answer. */
  it('ends normally on a stop reason it does not know', async () => {
    const events = await collect(
      fakeStream([messageStart(), text('hi'), messageDelta('pause_turn'), MESSAGE_STOP]),
    )

    expect(expectOneTerminal(events)).toMatchObject({ kind: 'end', truncated: false })
  })
})

describe('mapStream — the iterator throws', () => {
  /** AC-12. The text produced so far is carried on the error, not discarded. */
  it('yields the tokens it saw, then one upstream error carrying their text', async () => {
    const events = await collect(
      fakeStream(
        [messageStart(), text('Here is '), text('a contact'), messageDelta('end_turn')],
        3,
      ),
    )

    expect(tokens(events)).toEqual(['Here is ', 'a contact'])
    expect(expectOneTerminal(events)).toMatchObject({
      kind: 'error',
      code: 'upstream',
      text: 'Here is a contact',
    })
  })

  /** AC-13's mapper half: nothing produced, so there is nothing to persist. */
  it('yields one upstream error with empty text when it throws before any delta', async () => {
    const events = await collect(fakeStream([messageStart(), text('never seen')], 1))

    expect(tokens(events)).toEqual([])
    expect(expectOneTerminal(events)).toMatchObject({ kind: 'error', code: 'upstream', text: '' })
  })

  /* A stream that failed at the very first event has no `message_start`, so the
   * model is unknown — and the log line still has to be emittable. */
  it('survives a throw before message_start', async () => {
    const events = await collect(fakeStream([], 0))

    expect(expectOneTerminal(events)).toMatchObject({ kind: 'error', code: 'upstream', text: '' })
  })
})

describe('mapStream — the byte cap', () => {
  /*
   * D22, AC-16. A Firestore document caps at 1,048,576 bytes and `max_tokens:
   * 64000` can in principle produce more text than fits. Without the cap the
   * failure mode is the worst one available: a generation that succeeded
   * completely, streamed perfectly, and then failed at the write — losing
   * everything the user just watched arrive.
   */
  it('stops consuming, aborts the stream once, and ends truncated', async () => {
    const chunk = 'a'.repeat(100_000)
    const stream = fakeStream([
      messageStart(),
      ...Array.from({ length: 12 }, () => text(chunk)),
      messageDelta('end_turn'),
      MESSAGE_STOP,
    ])

    const events = await collect(stream)

    const terminal = expectOneTerminal(events)
    expect(terminal).toMatchObject({ kind: 'end', truncated: true })
    expect(stream.abort).toHaveBeenCalledTimes(1)
    expect(Buffer.byteLength(terminal.text, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
  })

  /* What the client saw and what is stored have to be the same bytes: the
   * terminal text is exactly the concatenation of the `token` frames. */
  it('leaves the stored text equal to the concatenation of the tokens emitted', async () => {
    const chunk = 'b'.repeat(300_000)
    const events = await collect(
      fakeStream([messageStart(), text(chunk), text(chunk), text(chunk), messageDelta('end_turn')]),
    )

    expect(expectOneTerminal(events).text).toBe(tokens(events).join(''))
  })

  /*
   * **The cap is enforced whole-delta**, and this is why. Slicing by bytes would
   * split a multi-byte character and store a replacement character; dropping the
   * whole delta keeps the text valid UTF-8 and byte-identical to what the client
   * received.
   */
  it('drops a multi-byte delta whole rather than splitting a character', async () => {
    // Three bytes per character, so a byte-slice at the boundary lands mid-character.
    const filler = 'a'.repeat(MAX_OUTPUT_BYTES - 10)
    const multiByte = '日本語テキスト'
    const events = await collect(
      fakeStream([messageStart(), text(filler), text(multiByte), messageDelta('end_turn')]),
    )

    const terminal = expectOneTerminal(events)
    expect(terminal.text).toBe(filler)
    expect(terminal.text).not.toContain('�')
    expect(Buffer.from(terminal.text, 'utf8').toString('utf8')).toBe(terminal.text)
  })

  /* A delta that lands exactly on the cap fits, so it is emitted. */
  it('accepts a delta that lands exactly on the cap', async () => {
    const exact = 'a'.repeat(MAX_OUTPUT_BYTES)
    const events = await collect(
      fakeStream([messageStart(), text(exact), messageDelta('end_turn'), MESSAGE_STOP]),
    )

    expect(expectOneTerminal(events)).toMatchObject({ kind: 'end', truncated: false })
    expect(tokens(events)).toEqual([exact])
  })

  it('never aborts a stream that stayed under the cap', async () => {
    const stream = fakeStream([messageStart(), text('short'), messageDelta('end_turn')])

    await collect(stream)

    expect(stream.abort).not.toHaveBeenCalled()
  })
})

describe('mapStream — the invariant', () => {
  /*
   * Restated as its own case over every shape, because it is what the consumer
   * depends on: it writes one frame and persists at most one document per
   * terminal. Two terminals is two assistant messages for one turn.
   */
  it.each([
    [
      'a complete turn',
      [messageStart(), text('hi'), messageDelta('end_turn'), MESSAGE_STOP],
      undefined,
    ],
    ['a refusal', [messageStart(), messageDelta('refusal')], undefined],
    ['a truncation', [messageStart(), text('hi'), messageDelta('max_tokens')], undefined],
    ['a mid-stream failure', [messageStart(), text('hi')], 2],
    ['an immediate failure', [], 0],
    ['a stream with no events at all', [], undefined],
  ] as const)('yields exactly one terminal event for %s, last', async (_label, events, throwAt) => {
    const collected = await collect(fakeStream(events, throwAt))

    expectOneTerminal(collected)
  })
})
