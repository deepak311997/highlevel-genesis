import { describe, expect, it } from 'vitest'

import type { Message } from '../messages/schema'
import { buildContext } from './context'

/**
 * The transcript as the model sees it — and the slice's one real hazard (D6, R1).
 *
 * **A trailing assistant message is a prefill, and prefill is a 400 on
 * `claude-opus-5`.** It is not a theoretical shape: it is exactly what Retry
 * after an interruption produces (user → assistant-truncated → Retry), and it is
 * what every project still carrying Slice 4's echoes looks like. Untreated, the
 * failure lands on the recovery path — the one thing that has to work when
 * something has already gone wrong.
 *
 * So the drop is a loop with tests over one, three and all-of-them, and an
 * assistant in the *middle* has its own case: dropping those would throw away
 * the conversation, which is the whole reason the transcript is sent at all.
 */

function message(role: 'user' | 'assistant', content: string, index: number): Message {
  return {
    id: `msg-${String(index)}`,
    role,
    content,
    createdAt: '2026-08-17T09:00:00.000Z',
    truncated: false,
  }
}

/** `u`/`a` per turn, numbered so order is visible in a failure. */
function transcript(shape: readonly ('u' | 'a')[]): Message[] {
  return shape.map((letter, index) =>
    message(letter === 'u' ? 'user' : 'assistant', `${letter}${String(index)}`, index),
  )
}

describe('buildContext', () => {
  /** AC-8. Order preserved, roles preserved, and nothing else carried. */
  it('maps a transcript to role and content, oldest first', () => {
    const context = buildContext(transcript(['u', 'a', 'u', 'a', 'u']))

    expect(context).toEqual([
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'u4' },
    ])
  })

  /*
   * AC-8's second clause, asserted key by key. `id`, `createdAt` and `truncated`
   * are ours and mean nothing to the API; `seq` never reaches this layer at all.
   * An extra key here is a 400 from the API rather than something it ignores.
   */
  it('carries no id, createdAt, seq or truncated on any element', () => {
    for (const element of buildContext(transcript(['u', 'a', 'u']))) {
      expect(Object.keys(element).sort()).toEqual(['content', 'role'])
    }
  })

  /** AC-9. One trailing assistant — the ordinary interrupted-turn shape. */
  it('drops a single trailing assistant turn', () => {
    const context = buildContext(transcript(['u', 'a']))

    expect(context).toEqual([{ role: 'user', content: 'u0' }])
  })

  /*
   * AC-9. Three in a row, which a Retry after two interruptions produces:
   * user → assistant(truncated) → assistant(truncated) → assistant(truncated).
   * Dropping only the last one would still send a prefill.
   */
  it('drops three consecutive trailing assistant turns, leaving a user turn last', () => {
    const context = buildContext(transcript(['u', 'u', 'a', 'a', 'a']))

    expect(context).toEqual([
      { role: 'user', content: 'u0' },
      { role: 'user', content: 'u1' },
    ])
    expect(context.at(-1)?.role).toBe('user')
  })

  /* The drop is about the *tail*. An assistant turn mid-conversation is the
   * conversation, and throwing it away is throwing away the context. */
  it('keeps an assistant turn in the middle', () => {
    expect(buildContext(transcript(['u', 'a', 'u'])).map((element) => element.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
  })

  /*
   * AC-10's L1 half. Both of these leave nothing to send, and the handler turns
   * an empty array into `400 empty_context` before any LLM call (D7). An
   * all-assistant transcript is reachable: a project carrying only Slice 4
   * echoes, or a Retry on one.
   */
  it('yields an empty context for a transcript of assistant turns only', () => {
    expect(buildContext(transcript(['a', 'a', 'a']))).toEqual([])
  })

  it('yields an empty context for an empty transcript', () => {
    expect(buildContext([])).toEqual([])
  })

  /* Purity: the caller's array is the store's, and mutating it would corrupt the
   * transcript that is about to be rendered. */
  it('leaves the transcript it was given untouched', () => {
    const messages = transcript(['u', 'a', 'a'])
    const before = JSON.stringify(messages)

    buildContext(messages)

    expect(JSON.stringify(messages)).toBe(before)
  })
})
