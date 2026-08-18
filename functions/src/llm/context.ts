import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

import type { Message } from '../messages/schema'
import { TRANSCRIPT_BUDGET } from './budget'

/**
 * Drop the trailing assistant turns — step one.
 *
 * First for a reason step three depends on: it is what leaves a **user** message
 * last. Reversing the two would let the floor below protect a trailing assistant
 * turn that this step then removes, and `user(small) → assistant(huge)` — the
 * exact shape Retry re-opens against — would come back empty and answer `400
 * empty_context` forever.
 */
function dropTrailingAssistants(messages: readonly Message[]): readonly Message[] {
  let end = messages.length
  while (end > 0 && messages[end - 1]?.role === 'assistant') end -= 1
  return messages.slice(0, end)
}

/**
 * Trim from the **oldest** end to `TRANSCRIPT_BUDGET` — step two.
 *
 * Characters, not tokens: an exact count needs a round trip and a charge on every
 * generation to decide what a conservative estimate already decides safely.
 *
 * **The newest surviving turn is kept whatever the budget says.** Without that
 * floor a project whose last message overflowed would trim to nothing and answer
 * `400 empty_context` on every attempt — unrecoverable, since the only way to fix
 * it would be to send another message. It runs in practice: a user turn is capped
 * at 4,000 characters but an assistant turn is bounded only by the 800,000-byte
 * output cap, so one long generation can exceed the whole budget.
 *
 * Whole turns only. A half-quoted turn would be a message the user never sent.
 */
function trimToBudget(messages: readonly Message[]): readonly Message[] {
  const newest = messages.length - 1
  let total = 0
  let start = messages.length

  for (let index = newest; index >= 0; index -= 1) {
    const length = messages[index]?.content.length ?? 0
    // The floor: the newest turn is taken before the budget is consulted.
    if (index < newest && total + length > TRANSCRIPT_BUDGET) break
    total += length
    start = index
  }

  return messages.slice(start)
}

/**
 * Drop the **leading** assistant turns — step three.
 *
 * The Messages API requires the first message to be `user`, and step two lands on
 * an assistant turn roughly half the time. Untreated that is a `400
 * invalid_request_error` reaching the user as "generation failed", and only on
 * conversations long enough to be trimmed — which no fixture-sized test reaches,
 * so it would ship.
 *
 * **This step cannot empty the result**: step one leaves a user message last, and
 * step two always keeps that message, so the loop stops there at the latest.
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
 * oldest end, leading-assistant drop — each a named function above. Everything
 * else the model is sent is a `system` block, including the project-state block,
 * which is a separate budget on purpose so a long conversation cannot evict the
 * code it exists to preserve.
 *
 * **A trailing assistant message is an assistant prefill, and prefill returns a
 * 400** — the request fails rather than streaming. It is not a rare shape: Retry
 * after an interruption produces it every single time, on the one path that is
 * supposed to work when something has already gone wrong. Sending it verbatim
 * surfaces as a generic "generation failed"; appending a synthetic "continue"
 * invents a message the user never wrote. An assistant turn in the *middle* is
 * kept — that is the conversation.
 *
 * **Pure**, and nothing but role and content: `id`, `createdAt` and `truncated`
 * are ours and an unknown key is a 400 rather than something the API ignores.
 *
 * Returns `[]` only for a transcript that was empty or all assistant turns, never
 * because of the budget — which the handler turns into `400 empty_context`.
 */
export function buildContext(messages: readonly Message[]): MessageParam[] {
  const kept = dropLeadingAssistants(trimToBudget(dropTrailingAssistants(messages)))

  return kept.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}
