import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

import type { Message } from '../messages/schema'

/**
 * The transcript as the model sees it, oldest first.
 *
 * The whole context this slice sends (D5): the project's stored transcript, hard
 * capped at 200 messages by the collection itself. Project files do not exist
 * until Slice 6 and the HighLevel cheat-sheet is Slice 9's; token-budget
 * truncation is Slice 9's too, and the 200-message cap is what makes deferring it
 * safe rather than optimistic.
 *
 * ## Trailing assistant turns are dropped, and that is the slice's one hazard
 *
 * D6, R1. **A trailing assistant message is an assistant prefill, and prefill
 * returns a 400 on `claude-opus-5`** — the request fails with
 * `invalid_request_error` rather than streaming. It is not a rare shape:
 *
 * - Retry after an interruption produces it every single time. The transcript is
 *   `user → assistant(truncated)`, and Retry re-opens the stream against exactly
 *   that. So the failure would land on the recovery path — the one thing that is
 *   supposed to work when something has already gone wrong.
 * - Every project still carrying Slice 4's echoes ends on an assistant turn.
 *
 * Two alternatives were rejected. Sending the transcript verbatim and letting the
 * API complain surfaces as a generic "generation failed" with the cause
 * invisible. Appending a synthetic "continue" user turn invents a message the
 * user never wrote, into a transcript whose whole value is being a true record.
 *
 * An assistant turn in the *middle* is kept: that is the conversation.
 *
 * ## Nothing but role and content
 *
 * `id`, `createdAt` and `truncated` are ours and mean nothing to the API — an
 * unknown key is a 400 rather than something it ignores — and `seq` never
 * reaches this layer at all.
 *
 * Returns `[]` when nothing survives, which the handler turns into
 * `400 empty_context` before any LLM call (D7).
 */
export function buildContext(messages: readonly Message[]): MessageParam[] {
  let end = messages.length
  while (end > 0 && messages[end - 1]?.role === 'assistant') end -= 1

  return messages.slice(0, end).map((message) => ({
    role: message.role,
    content: message.content,
  }))
}
