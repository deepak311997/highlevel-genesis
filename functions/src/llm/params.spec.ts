import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'

import { buildParams, EFFORT, MAX_TOKENS, MODEL } from './params'
import { SYSTEM_PROMPT } from './prompt'

/**
 * The request parameters — AC-6, and three decisions that are easy to undo by
 * accident.
 *
 * The model id and `max_tokens` are `CLAUDE.md`'s non-negotiables, pinned to
 * exact values rather than "starts with claude" so a downgrade is a failing test
 * and not a quieter bill.
 *
 * **There is no `thinking` key, and that is the decision** (D14). Thinking is on
 * by default on `claude-opus-5`, so omitting the field is a choice either way;
 * `{ type: 'disabled' }` carries a documented Opus-5 failure mode this slice
 * cannot afford — with thinking off the model can leak `<thinking>` tags into its
 * *visible* output, which is ugly in a chat bubble today and corruption from
 * Slice 6, when that same text is parsed into files. A key appearing here later
 * should be a deliberate change with this case rewritten, not a silent one.
 */

const CONTEXT: MessageParam[] = [{ role: 'user', content: 'build a contact dashboard' }]

describe('buildParams', () => {
  /** `CLAUDE.md`'s non-negotiable, pinned exactly. */
  it('asks for claude-opus-5', () => {
    expect(MODEL).toBe('claude-opus-5')
    expect(buildParams([]).model).toBe('claude-opus-5')
  })

  /*
   * 64,000, which also *requires* streaming to avoid the SDK's HTTP timeout —
   * the same constraint the brief states from the other side.
   */
  it('asks for 64,000 output tokens', () => {
    expect(MAX_TOKENS).toBe(64_000)
    expect(buildParams([]).max_tokens).toBe(64_000)
  })

  /*
   * D15. `low` for this slice: it keeps thinking short, so D14's pause before
   * the first token stays small, and it keeps a whole turn well inside the
   * window a Hosting rewrite is known to tolerate (R2). **Slice 9 re-tunes this**
   * against real HighLevel prompts, where `high` or `xhigh` is the documented
   * starting point — recorded so that change reads as planned rather than churn.
   */
  it('asks for effort low', () => {
    expect(EFFORT).toBe('low')
    expect(buildParams([]).output_config?.effort).toBe('low')
  })

  /*
   * The *same array*, not a copy and not a copy with something appended. Anything
   * added above the breakpoint per call would make every request a cache miss
   * once Slice 9 makes caching real, and nothing would report it.
   */
  it('sends the system prompt itself, with nothing appended', () => {
    expect(buildParams([]).system).toBe(SYSTEM_PROMPT)
  })

  /** D14. Absence is the assertion. */
  it('carries no thinking key at all', () => {
    expect(Object.keys(buildParams([]))).not.toContain('thinking')
    expect('thinking' in buildParams([])).toBe(false)
  })

  it('passes the context through untouched', () => {
    expect(buildParams(CONTEXT).messages).toBe(CONTEXT)
  })

  /* Nothing else. A parameter that arrived by accident is a parameter nobody
   * decided, and this endpoint spends money. */
  it('sends exactly the five parameters that were decided', () => {
    expect(Object.keys(buildParams([])).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
    ])
  })
})
