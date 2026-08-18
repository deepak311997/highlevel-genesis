/**
 * Server-Sent Events framing.
 *
 * The wire format is line-oriented, so a raw newline inside a payload would end
 * the frame early and corrupt the stream. Everything is JSON-encoded before it
 * is written, which escapes newlines to `\n` and keeps each frame on one line.
 */

export type SseEventName =
  // The prompt as stored, first frame of a turn that carried one.
  | 'user'
  | 'token'
  | 'file_start'
  | 'file_chunk'
  | 'file_end'
  // A located change: the range it lands in, its text, and its close.
  | 'edit_start'
  | 'edit_chunk'
  | 'edit_end'
  | 'done'
  | 'error'

/** Encode one SSE frame, terminator included. */
export function encodeSse(event: SseEventName, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A comment frame. Keeps proxies from closing an idle connection. */
export function encodeSseComment(text = 'keep-alive'): string {
  return `: ${text}\n\n`
}
