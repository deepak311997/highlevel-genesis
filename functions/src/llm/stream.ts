import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'

/**
 * The SDK's event stream, mapped to the three events this slice emits.
 *
 * ## Why the mapping lives here rather than in the handler
 *
 * Accumulation, the byte cap and the thinking-delta filter are the three places
 * an off-by-one or a dropped branch hides, and every one of them is pure. Owned
 * here, they are driven from a hand-written event array with no emulator and no
 * network; owned by the handler, they would only be reachable through an
 * emulator-backed test — which is exactly where such bugs survive. What is left
 * for the handler is framing, persistence and one log line.
 *
 * ## Exactly one terminal event, always
 *
 * Many `token`s, then **one** `end` or `error` — never both, never neither. The
 * consumer writes a frame and persists a document on the terminal, so two would
 * write two assistant messages for one turn and none would leave a stream that
 * never ends. `stream.spec.ts` asserts it on every shape rather than once.
 */

/**
 * The narrow port the mapper consumes.
 *
 * The SDK's `MessageStream` satisfies it as-is, and so does the emulator-only
 * fake — which is the whole point: this file has no idea which one it has, so
 * the same code path runs in tests and in production.
 *
 * `abort()` is here because the cap needs it. An orphaned generation still bills.
 */
export interface LlmStream extends AsyncIterable<MessageStreamEvent> {
  abort: () => void
}

/**
 * The most text one reply may accumulate, in UTF-8 bytes (D22).
 *
 * A Firestore document caps at 1,048,576 bytes, and `max_tokens: 64000` can in
 * principle produce more text than fits. This leaves room for the rest of the
 * document and for the overhead a write carries.
 *
 * Without a cap the failure mode is the worst one available: a generation that
 * succeeded completely, streamed perfectly, and then failed at the write —
 * losing everything the user just watched arrive. The cap converts that into a
 * truncated-but-saved reply. Typical output is ~250 KB, so it only bites on
 * pathological generations.
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
 * In the order the SDK produces them:
 *
 * - `message_start` records the model and the input-side token counts.
 * - `content_block_delta` with `text_delta` is the only delta that becomes a
 *   `token`. **Thinking and signature deltas are dropped** (AC-11, D14): they are
 *   the model's internal reasoning, and forwarding them would put it in the chat
 *   bubble — and, from Slice 6, into a parsed file.
 * - `message_delta` records the stop reason and the output token count.
 * - Iteration ending is the terminal: `refusal` is an `error`, `max_tokens` is an
 *   `end` with `truncated: true` (D23 — a real, useful, incomplete answer is not
 *   a failure), anything else is an ordinary `end`.
 * - The iterator **throwing** is an `error` carrying the text produced so far
 *   (AC-12), so a mid-stream failure preserves the partial rather than losing it.
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
       * **The cap is enforced whole-delta.** A delta that would take the total
       * past the cap is neither appended nor emitted, and consumption stops.
       *
       * Slicing the delta by bytes would split a multi-byte character and store a
       * replacement character, and it would also make the last `token` frame the
       * client saw disagree with what was persisted. Dropping the whole delta
       * keeps the stored text ≤ the cap, valid UTF-8, and byte-identical to the
       * concatenation of the frames the client received.
       */
      if (acc.bytes + size > MAX_OUTPUT_BYTES) {
        acc.truncated = true
        // An abandoned generation still bills, so the upstream stream is closed
        // rather than left to run to completion unread.
        stream.abort()
        break
      }

      acc.text += text
      acc.bytes += size
      yield { kind: 'token', text }
    }
  } catch {
    /*
     * The reason is deliberately not surfaced. An upstream error message can
     * carry request detail, and the client's answer is the same either way: what
     * arrived, an "interrupted" marker, and a Retry. The handler logs the shape.
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
   * D18. The stop reason is read **before** any content: a refusal is a 200 with
   * no content at all, so a terminal handler that reached for `content[0]` first
   * would break on exactly the case it exists to report.
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
    // D22 and D23 set the same flag: the byte cap and `max_tokens` are both a
    // reply that stopped short, and the UI has one thing to render for either.
    truncated: acc.truncated || acc.stopReason === 'max_tokens',
    stopReason: acc.stopReason,
    model: acc.model,
    usage: acc.usage,
  }
}
