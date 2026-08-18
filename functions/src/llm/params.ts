import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages'

import { buildProjectState } from './projectState'
import type { ProjectFile } from './projectState'
import { SYSTEM_PROMPT } from './prompt'

/**
 * What every generation asks for, in one place.
 *
 * `claude-opus-5`, `max_tokens: 64000` and `client.messages.stream()` are the
 * project's non-negotiables — **streaming is a requirement, not a preference**.
 * It is self-enforcing at this size anyway: 64,000 output tokens cannot be
 * delivered inside the SDK's non-streaming HTTP timeout. `params.spec.ts` scans
 * for `messages.create`, so the rule is a failing test rather than a review note.
 *
 * **No `thinking` field, and that is the decision.** Thinking is on by default on
 * `claude-opus-5`, so this is a choice either way. `thinking: { type: 'disabled' }`
 * carries a documented failure mode that is disqualifying here — the model can
 * leak `<thinking>` tags into its *visible* output, which is ugly in a chat bubble
 * and corruption once that text is parsed into files. The cost of leaving it on is
 * a pause before the first token.
 *
 * **`system` is copied only when there is something volatile to append.** The
 * project's files go in as a second `system` block, *after* the `cache_control`
 * breakpoint: a change anywhere in the cached prefix invalidates everything after
 * it, so a block one element earlier would turn every generation into a cache
 * write with the bill as the only symptom. And a project holding no files sends
 * the `SYSTEM_PROMPT` array *itself*, by identity — an unconditional spread would
 * be harmless to the cache and would quietly make that guarantee unassertable.
 *
 * **Effort is `high`**, the documented minimum for intelligence-sensitive work
 * and the API's own default; `low` was right when this endpoint generated prose
 * rather than code. `xhigh` lengthens the pause before the first token, and the
 * visible thing in the demo is tokens appearing — choosing properly between
 * `high`, `xhigh` and `max` needs a sweep against real generations.
 *
 * A constraint that sweep inherits: `thinking: { type: 'disabled' }` is accepted
 * at `high` or below and returns a 400 at `xhigh` and `max`. At the `high` set
 * here the two settings are still independent; raise the effort and they are not.
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
    // The array itself when there is nothing volatile to add, so the cached prefix
    // is byte-identical on every request.
    system: projectState === null ? SYSTEM_PROMPT : [...SYSTEM_PROMPT, projectState],
    output_config: { effort: EFFORT },
    messages: context,
  }
}
