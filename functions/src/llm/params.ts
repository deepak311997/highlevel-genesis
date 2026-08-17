import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages'

import { buildProjectState } from './projectState'
import type { ProjectFile } from './projectState'
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
 * ## `system` is copied only when there is something volatile to append (D11)
 *
 * The project's own files go in as a second kind of `system` block, appended
 * **after** the `cache_control` breakpoint. Both halves of that sentence are
 * load-bearing.
 *
 * *After the breakpoint*, because render order is `tools` → `system` →
 * `messages` and a change anywhere in the cached prefix invalidates everything
 * following it. A block that changes whenever the project changes, placed one
 * element earlier, would turn every generation into a cache write — with no
 * error, no frame and the bill as the only symptom.
 *
 * *Only when there is something to append*, because a project holding no files
 * must send the `SYSTEM_PROMPT` array **itself**, by identity (AC-13). An
 * unconditional `[...SYSTEM_PROMPT]` would be harmless to the cache and would
 * quietly make that guarantee unassertable, which is how it would survive
 * review: the thing being protected is not the array but the habit of not
 * touching it.
 *
 * ## Effort is `high` — the re-tune Slice 5 D15 promised (D17)
 *
 * `low` was the right answer when this endpoint generated **prose**. It now
 * generates code against a fifteen-hundred-token HighLevel cheat-sheet, and
 * `high` is the documented minimum for intelligence-sensitive work as well as
 * the API's own default. So this is a change the earlier decision named in
 * advance, not churn.
 *
 * `xhigh` — which the docs name as the starting point for coding — was
 * considered and rejected. It lengthens the pause before the first token, and
 * the visible thing in this project's demo is *tokens appearing*; R2, the
 * Hosting-rewrite window, is still argued rather than measured. Choosing
 * properly between `high`, `xhigh` and `max` needs an effort sweep against real
 * generations, which needs credentials this session does not have — so the sweep
 * is a named manual check in the definition of done rather than a guess made
 * here.
 *
 * **This is only safe because D14 left thinking on.** `thinking: { type:
 * 'disabled' }` is rejected outright above effort `high` on `claude-opus-5`, so
 * the two decisions hold each other up: disabling thinking would now be an API
 * error rather than merely a bad idea. `max_tokens` stays 64,000, which the docs
 * call the floor for `high` and above.
 */

export const MODEL = 'claude-opus-5'
export const MAX_TOKENS = 64_000
export const EFFORT = 'high' as const

export function buildParams(
  context: MessageParam[],
  files: readonly ProjectFile[] = [],
): MessageStreamParams {
  const projectState = buildProjectState(files)

  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // The array itself when there is nothing volatile to add, so the cached
    // prefix is byte-identical on every request; a copy with the project state
    // appended *after* the breakpoint when there is (D11).
    system: projectState === null ? SYSTEM_PROMPT : [...SYSTEM_PROMPT, projectState],
    output_config: { effort: EFFORT },
    messages: context,
  }
}
