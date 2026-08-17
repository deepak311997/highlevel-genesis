/**
 * Server-Sent Events, from the reading side — an **incremental** parser (D33).
 *
 * ## Why this is its own module with its own tests
 *
 * `ReadableStream` chunks have nothing to do with frame boundaries. Receiving
 * `event: to` and then `ken\ndata: …` is ordinary, and a parser that treats each
 * chunk as a complete unit drops or corrupts those frames — while passing every
 * test whose fixtures happen to be whole frames, which is every test written by
 * hand. That is R4, and it is the second-classic SSE bug after the raw-newline
 * one `functions/src/lib/sse.ts` already guards from the writing side.
 *
 * It is pure string handling, so it is pure string handling with a unit test
 * that splits at every offset, rather than something discovered in an e2e run.
 *
 * ## What it does not do
 *
 * It does not know what a `token` is. Unknown event names are returned as-is and
 * filtering is the caller's job, which is what lets Slice 6 add `file_start`
 * handling without touching this file.
 */

export interface SseEvent {
  event: string
  data: unknown
}

/** Frames are separated by a blank line — two newlines, always. */
const FRAME_SEPARATOR = '\n\n'

/** `event: token` and `event:token` are both valid; the space is optional. */
function valueOf(line: string, field: string): string | null {
  if (!line.startsWith(`${field}:`)) return null
  const raw = line.slice(field.length + 1)
  return raw.startsWith(' ') ? raw.slice(1) : raw
}

/**
 * One frame's text to an event, or `null` for anything that carries no event.
 *
 * A frame whose `data` will not parse is **dropped rather than thrown**, and
 * that is the decision (AC-29). Losing one malformed frame costs a token; a
 * throw would abandon the read, and a parser that lost its place would cost the
 * rest of the stream — including the terminal event the store is waiting on to
 * clear `generating`.
 */
function toEvent(block: string): SseEvent | null {
  const lines = block.split('\n')

  // A comment frame — the keep-alive. It exists to hold the connection open and
  // says nothing.
  if (lines.some((line) => line.startsWith(':'))) return null

  let event: string | null = null
  const data: string[] = []

  for (const line of lines) {
    const name = valueOf(line, 'event')
    if (name !== null) {
      event = name
      continue
    }
    const payload = valueOf(line, 'data')
    if (payload !== null) data.push(payload)
  }

  if (data.length === 0) return null

  try {
    // Several `data:` lines in one frame join with a newline, per the spec.
    return {
      // `message` is the spec's default name. Nothing this server writes uses
      // it, so seeing one means `data:` arrived without an `event:` — which the
      // caller should be able to notice rather than have coerced away.
      event: event ?? 'message',
      data: JSON.parse(data.join('\n')),
    }
  } catch {
    return null
  }
}

/**
 * An incremental parser.
 *
 * `push` takes whatever arrived and returns whatever completed — usually
 * nothing, sometimes several frames. Everything after the last frame separator
 * is held until the rest of it turns up.
 */
export function createSseParser(): { push: (chunk: string) => SseEvent[] } {
  let buffer = ''

  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk

      const blocks = buffer.split(FRAME_SEPARATOR)
      // The last element is whatever has not been terminated yet — possibly the
      // empty string, when the chunk ended exactly on a separator.
      buffer = blocks.pop() ?? ''

      return blocks
        .filter((block) => block.trim() !== '')
        .map(toEvent)
        .filter((event): event is SseEvent => event !== null)
    },
  }
}
