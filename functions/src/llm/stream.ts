import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'

/**
 * The SDK's event stream, mapped to the three events this slice emits.
 *
 * Accumulation, the byte cap and the thinking-delta filter are the three places an
 * off-by-one hides, and all three are pure — owned here they are driven from a
 * hand-written event array with no emulator and no network. What is left for the
 * handler is framing, persistence and one log line.
 *
 * **Exactly one terminal event, always**: many `token`s, then one `end` or
 * `error`. The consumer writes a frame and persists a document on the terminal, so
 * two would write two assistant messages for one turn and none would leave a
 * stream that never ends.
 */

/**
 * The narrow port the mapper consumes. The SDK's `MessageStream` satisfies it
 * as-is, and so does the emulator fake, so the same code path runs in tests and in
 * production. `abort()` is here because the cap needs it — an orphaned generation
 * still bills.
 */
export interface LlmStream extends AsyncIterable<MessageStreamEvent> {
  abort: () => void
}

/**
 * The most text one reply may accumulate, in UTF-8 bytes.
 *
 * A Firestore document caps at 1,048,576, and `max_tokens: 64000` can in principle
 * produce more than fits. Without a cap the failure is the worst available: a
 * generation that succeeded, streamed perfectly, and then failed at the write.
 * Typical output is ~250 KB, so it only bites on pathological generations.
 */
export const MAX_OUTPUT_BYTES = 800_000

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export type LlmEvent =
  | { kind: 'token'; text: string }
  | {
      kind: 'end'
      text: string
      truncated: boolean
      stopReason: string | null
      model: string
      usage: LlmUsage
    }
  | {
      kind: 'error'
      text: string
      code: 'upstream' | 'refused'
      stopReason: string | null
      model: string
      usage: LlmUsage
    }

/** Everything the terminal event needs, accumulated as the stream runs. */
interface Accumulator {
  text: string
  bytes: number
  truncated: boolean
  stopReason: string | null
  model: string
  usage: LlmUsage
}

function emptyAccumulator(): Accumulator {
  return {
    text: '',
    bytes: 0,
    truncated: false,
    stopReason: null,
    // Unknown until `message_start` arrives. A stream that fails at the first
    // event never learns it, and the log line still has to be emittable.
    model: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  }
}

/**
 * Many `token`s, then exactly one terminal event.
 *
 * `message_start` records the model and input counts; `message_delta` the stop
 * reason and output count. Only a `text_delta` becomes a `token` — **thinking and
 * signature deltas are dropped**, because they are the model's internal reasoning
 * and forwarding them would put it in the chat bubble and into a parsed file.
 *
 * Iteration ending is the terminal: `refusal` is an `error`, `max_tokens` an `end`
 * with `truncated: true` — a real, useful, incomplete answer is not a failure —
 * and the iterator *throwing* is an `error` carrying the text produced so far, so
 * a mid-stream failure preserves the partial.
 */
export async function* mapStream(stream: LlmStream): AsyncGenerator<LlmEvent> {
  const acc = emptyAccumulator()

  try {
    for await (const event of stream) {
      if (event.type === 'message_start') {
        acc.model = event.message.model
        acc.usage.inputTokens = event.message.usage.input_tokens
        acc.usage.outputTokens = event.message.usage.output_tokens
        acc.usage.cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens ?? 0
        acc.usage.cacheReadInputTokens = event.message.usage.cache_read_input_tokens ?? 0
        continue
      }

      if (event.type === 'message_delta') {
        acc.stopReason = event.delta.stop_reason
        acc.usage.outputTokens = event.usage.output_tokens
        continue
      }

      if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue

      const { text } = event.delta
      const size = Buffer.byteLength(text, 'utf8')

      /*
       * **The cap is enforced whole-delta.** Slicing by bytes would split a
       * multi-byte character, and it would make the last frame the client saw
       * disagree with what was persisted. Dropping the whole delta keeps the
       * stored text valid UTF-8 and byte-identical to the frames received.
       */
      if (acc.bytes + size > MAX_OUTPUT_BYTES) {
        acc.truncated = true
        // An abandoned generation still bills, so the upstream stream is closed
        // rather than left to run unread.
        stream.abort()
        break
      }

      acc.text += text
      acc.bytes += size
      yield { kind: 'token', text }
    }
  } catch {
    /*
     * The reason is deliberately not surfaced: an upstream message can carry
     * request detail, and the client's answer is the same either way — what
     * arrived, an "interrupted" marker, and a Retry.
     */
    yield {
      kind: 'error',
      text: acc.text,
      code: 'upstream',
      stopReason: acc.stopReason,
      model: acc.model,
      usage: acc.usage,
    }
    return
  }

  /*
   * The stop reason is read **before** any content: a refusal is a 200 with no
   * content at all, so a handler reaching for `content[0]` first would break on
   * exactly the case it exists to report.
   */
  if (acc.stopReason === 'refusal') {
    yield {
      kind: 'error',
      text: acc.text,
      code: 'refused',
      stopReason: acc.stopReason,
      model: acc.model,
      usage: acc.usage,
    }
    return
  }

  yield {
    kind: 'end',
    text: acc.text,
    // The byte cap and `max_tokens` set the same flag: both are a reply that
    // stopped short, and the UI has one thing to render for either.
    truncated: acc.truncated || acc.stopReason === 'max_tokens',
    stopReason: acc.stopReason,
    model: acc.model,
    usage: acc.usage,
  }
}
