import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

import type { Message } from '../messages/schema'
import { TRANSCRIPT_BUDGET } from './budget'

/**
 * Drop the trailing assistant turns — step one, and Slice 5 D6 unchanged.
 *
 * Kept first for a reason step two depends on: it is what leaves a **user**
 * message last, which is the whole of why step three cannot empty the result.
 * Reversing the two would let D16's floor protect a trailing assistant turn that
 * step one then removes, and a transcript of `user(small) → assistant(huge)` —
 * the exact shape Retry after an interruption re-opens the stream against —
 * would come back empty and answer `400 empty_context` forever.
 */
function dropTrailingAssistants(messages: readonly Message[]): readonly Message[] {
  let end = messages.length
  while (end > 0 && messages[end - 1]?.role === 'assistant') end -= 1
  return messages.slice(0, end)
}

/**
 * Trim from the **oldest** end to `TRANSCRIPT_BUDGET` — step two (D12, D15, D16).
 *
 * Walk backwards from the newest turn accumulating `content.length` and stop at
 * the first turn that would take the running total past the budget. Characters,
 * not tokens: an exact count needs `messages.count_tokens`, a round trip and a
 * charge on every generation, to decide something a conservative estimate
 * already decides safely (`budget.ts`).
 *
 * **The newest surviving turn is kept whatever the budget says** (D16). Without
 * that floor, a project whose last message overflowed the budget would trim to
 * nothing and answer `400 empty_context` (Slice 5 D7) on every attempt — an
 * unrecoverable project, since the only way to fix it would be to send another
 * message. `CONTENT_MAX` caps one stored message at 4,000 characters against an
 * 80,000-character budget, so it cannot arise today; the guarantee costs one
 * comparison and the alternative is unbounded.
 *
 * Whole turns only. A half-quoted turn would be a message the user never sent.
 */
function trimToBudget(messages: readonly Message[]): readonly Message[] {
  const newest = messages.length - 1
  let total = 0
  let start = messages.length

  for (let index = newest; index >= 0; index -= 1) {
    const length = messages[index]?.content.length ?? 0
    // D16's floor: the newest turn is taken before the budget is consulted.
    if (index < newest && total + length > TRANSCRIPT_BUDGET) break
    total += length
    start = index
  }

  return messages.slice(start)
}

/**
 * Drop the **leading** assistant turns — step three (D15, R3).
 *
 * The Messages API requires the first message to be `user`, and step two lands
 * on an assistant turn roughly half the time: the transcript alternates, so the
 * cut falls on either role with about equal probability. Untreated that is a
 * `400 invalid_request_error` reaching the user as "generation failed", and only
 * on conversations long enough to be trimmed — which no fixture-sized test would
 * ever reach, so it would ship.
 *
 * **This step cannot empty the result**, and that is the argument that AC-19 and
 * AC-21 do not contradict each other: step one leaves a user message last (or
 * leaves nothing at all), and step two always keeps that last message, so
 * whenever the array is non-empty its final element has role `user` — and the
 * loop below stops there at the latest.
 */
function dropLeadingAssistants(messages: readonly Message[]): readonly Message[] {
  let start = 0
  while (start < messages.length && messages[start]?.role === 'assistant') start += 1
  return messages.slice(start)
}

/**
 * The transcript as the model sees it, oldest first.
 *
 * Three steps, in this order — trailing-assistant drop, budget trim from the
 * oldest end, leading-assistant drop — each a named function above with the
 * reason it exists and the reason it sits where it does. Everything the model is
 * sent besides this is a `system` block: the stable prefix (Slice 9 T3/T4) and,
 * when the project holds files, the project-state block (`projectState.ts`),
 * which is a separate budget on purpose (D12) so a long conversation can never
 * evict the code F3.2 exists to preserve.
 *
 * **Pure.** The array it is given is the store's, and the same array is about to
 * be rendered in the chat panel, so every step slices rather than splices.
 *
 * ## Trailing assistant turns are dropped, and that is the slice's one hazard
 *
 * Slice 5 D6, R1. **A trailing assistant message is an assistant prefill, and prefill
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
 * Returns `[]` when nothing survives — only ever for a transcript that was empty
 * or all assistant turns, never because of the budget (D16) — which the handler
 * turns into `400 empty_context` before any LLM call (Slice 5 D7).
 */
export function buildContext(messages: readonly Message[]): MessageParam[] {
  const kept = dropLeadingAssistants(trimToBudget(dropTrailingAssistants(messages)))

  return kept.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}
