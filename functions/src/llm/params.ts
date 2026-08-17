import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages'

import { SYSTEM_PROMPT } from './prompt'

/**
 * What every generation asks for, in one place.
 *
 * ## The two brief requirements
 *
 * `claude-opus-5` and `max_tokens: 64000` are `CLAUDE.md`'s non-negotiables, and
 * so is `client.messages.stream()` — **streaming is a requirement, not a
 * preference** (D13). `messages.create` is a brief violation. It is also
 * self-enforcing at this size: 64,000 output tokens cannot be delivered inside
 * the SDK's non-streaming HTTP timeout, so the same constraint arrives from the
 * other side. `params.spec.ts` scans `functions/src` for `messages.create` so the
 * rule is a failing test rather than a review note.
 *
 * ## No `thinking` field, and that is the decision (D14)
 *
 * Thinking is **on by default** on `claude-opus-5` — unlike Opus 4.8, where
 * omitting the field meant off — so this is a choice either way. The rejected
 * alternative is `thinking: { type: 'disabled' }`, which the API accepts at
 * effort `high` or below and which carries a documented Opus-5 failure mode that
 * is disqualifying here: with thinking off the model can leak `<thinking>` tags
 * into its **visible** output. Model-internal XML in a chat bubble is ugly today;
 * from Slice 6, when that same text is parsed into files, it is corruption.
 *
 * `display` is omitted too, so thinking blocks arrive with empty text — and the
 * mapper drops every non-text delta regardless (AC-11).
 *
 * The cost of leaving thinking on is a pause before the first token. `EFFORT`
 * shortens it and the `Generating…` badge makes it legible.
 *
 * ## Effort is `low` for this slice, and Slice 9 re-tunes it (D15)
 *
 * `low` on `claude-opus-5` is documented as unusually strong; it keeps thinking
 * short and keeps a whole turn well inside the window a Hosting rewrite is known
 * to tolerate (R2). The caveat, recorded so the change reads as planned rather
 * than as churn: **this slice generates prose, not code.** Slice 9 owns
 * generation quality and will re-tune this against real HighLevel prompts, where
 * `high` or `xhigh` is the documented starting point.
 */

export const MODEL = 'claude-opus-5'
export const MAX_TOKENS = 64_000
export const EFFORT = 'low' as const

export function buildParams(context: MessageParam[]): MessageStreamParams {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // The array itself, not a copy: nothing is appended per call, so the cached
    // prefix is byte-identical on every request.
    system: SYSTEM_PROMPT,
    output_config: { effort: EFFORT },
    messages: context,
  }
}
