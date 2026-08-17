import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'

import type { Message } from '../messages/schema'
import { TRANSCRIPT_BUDGET } from './budget'
import { buildContext } from './context'

/**
 * The transcript as the model sees it — and the two hazards it exists to close.
 *
 * **A trailing assistant message is a prefill, and prefill is a 400 on
 * `claude-opus-5`** (Slice 5 D6, R1). It is not a theoretical shape: it is
 * exactly what Retry after an interruption produces (user → assistant-truncated
 * → Retry), and it is what every project still carrying Slice 4's echoes looks
 * like. Untreated, the failure lands on the recovery path — the one thing that
 * has to work when something has already gone wrong.
 *
 * **A *leading* assistant message is the same 400 from the other end** (Slice 9
 * D15, R3), and it is the one the budget trim manufactures: cutting from the
 * oldest end lands on an assistant turn roughly half the time. It appears only
 * on long conversations, so no fixture-sized transcript would ever reach it —
 * which is why the trimming cases below state their arithmetic in characters and
 * build the shape that lands on the boundary deliberately, rather than hoping a
 * realistic corpus wanders into it.
 *
 * So the drop is a loop with tests over one, three and all-of-them; an assistant
 * in the *middle* has its own case, because dropping those would throw away the
 * conversation the transcript is sent for; and the three steps' **order** has a
 * case of its own too, since running the trim before the trailing drop would
 * empty the context on the recovery path (AC-20).
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

/**
 * A turn of **exactly** `size` characters, still labelled with its index.
 *
 * The label is padded rather than appended, so the number written in a test is
 * the number the budget measures — an off-by-three between the two would move a
 * boundary and quietly turn a boundary case into an ordinary one.
 */
function sized(role: 'user' | 'assistant', index: number, size: number): Message {
  const label = `${role === 'user' ? 'u' : 'a'}${String(index)}:`
  return message(role, label.padEnd(size, 'x'), index)
}

/** `u a u a … ` of `count` turns, every one exactly `size` characters. */
function alternating(count: number, size: number): Message[] {
  return Array.from({ length: count }, (_unused, index) =>
    sized(index % 2 === 0 ? 'user' : 'assistant', index, size),
  )
}

/** Indexed reads that fail loudly rather than asserting against `undefined`. */
function contentOf(messages: readonly Message[], index: number): string {
  const found = messages[index]
  if (found === undefined) throw new Error(`no message at index ${String(index)}`)
  return found.content
}

/** What the budget measures: the sum of the kept turns' content lengths. */
function totalLength(context: readonly MessageParam[]): number {
  return context.reduce((total, element) => total + element.content.length, 0)
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

  /*
   * AC-18, D12, D13. Forty-one turns of exactly 3,800 characters — 155,800 in
   * all, against an 80,000-character budget. 3,800 is just under `CONTENT_MAX`,
   * so this is a realistic transcript rather than a synthetic one.
   *
   * The arithmetic is picked so the boundary is unambiguous *and* lands on a
   * user turn, which keeps this case about the budget alone: 21 × 3,800 = 79,800
   * fits and 22 × 3,800 = 83,600 does not, so the cut falls between turn 19 and
   * turn 20 — and turn 20 is even, hence a user turn, so the leading-assistant
   * drop has nothing to do here. AC-19 has its own shape for that.
   */
  it('keeps the newest turns, drops the oldest, and stays within the budget', () => {
    const messages = alternating(41, 3_800)

    const context = buildContext(messages)

    expect(context).toHaveLength(21)
    expect(context[0]?.content).toBe(contentOf(messages, 20))
    expect(context.at(-1)?.content).toBe(contentOf(messages, 40))
    expect(totalLength(context)).toBe(79_800)
    expect(totalLength(context)).toBeLessThanOrEqual(TRANSCRIPT_BUDGET)

    // The oldest are gone — the first turn, and the last one to fall outside.
    const kept = context.map((element) => element.content)
    expect(kept).not.toContain(contentOf(messages, 0))
    expect(kept).not.toContain(contentOf(messages, 19))
  })

  /*
   * AC-19, D15, R3. The shape is `u a a u a u` and the sizes are chosen so the
   * cut is arithmetic rather than luck: the five newest turns come to 50,000
   * characters, and turn 0 is 60,000 on its own, so the walk backwards reaches
   * 110,000 > 80,000 and stops. The boundary therefore falls between turn 0 and
   * turn 1 — and turn 1 is an assistant turn, which is exactly the first message
   * the Messages API refuses with `400 invalid_request_error`.
   *
   * Both leading assistants go, not just the first; turn 3 onward is a genuine
   * `user → assistant → user` conversation and survives whole.
   */
  it('drops the leading assistant turns the budget cut lands on', () => {
    const messages = [
      sized('user', 0, 60_000),
      sized('assistant', 1, 10_000),
      sized('assistant', 2, 10_000),
      sized('user', 3, 10_000),
      sized('assistant', 4, 10_000),
      sized('user', 5, 10_000),
    ]

    const context = buildContext(messages)

    expect(context[0]?.role).toBe('user')
    expect(context).toEqual([
      { role: 'user', content: contentOf(messages, 3) },
      { role: 'assistant', content: contentOf(messages, 4) },
      { role: 'user', content: contentOf(messages, 5) },
    ])
  })

  /*
   * AC-20, and the reason the three steps run in the order they do. The newest
   * turn here is a 200,000-character assistant message — an interrupted reply,
   * which is precisely what Retry re-opens the stream against.
   *
   * In this order the trailing assistant goes first, and the user turn behind it
   * is what D16's floor then protects, so the result is non-empty. Reversed, the
   * floor would protect the *assistant* turn (it is the newest), the
   * 1,000-character user turn behind it would not fit beside 200,000, and
   * dropping the trailing assistant afterwards would leave nothing — a permanent
   * `400 empty_context` on the recovery path.
   */
  it('drops a trailing assistant turn before trimming, so the result is non-empty', () => {
    const asked = sized('user', 0, 1_000)
    const interrupted = sized('assistant', 1, 200_000)

    const context = buildContext([asked, interrupted])

    expect(context).toEqual([{ role: 'user', content: asked.content }])
  })

  /*
   * AC-21, D16. The newest user turn is kept whatever the budget says, and it is
   * returned alone. The alternative is a project that answers `400 empty_context`
   * forever, because `handleGenerate` refuses an empty context before any LLM
   * call (Slice 5 D7).
   *
   * The 200,000-character *user* turn here is synthetic — `CONTENT_MAX` bounds a
   * user turn at 4,000 — so this case pins the guarantee at its extreme. The case
   * below it is the one that can actually happen.
   */
  it('keeps the newest user turn even when it alone exceeds the whole budget', () => {
    const oversized = sized('user', 2, 200_000)
    const messages = [sized('user', 0, 1_000), sized('assistant', 1, 1_000), oversized]

    const context = buildContext(messages)

    expect(context).toEqual([{ role: 'user', content: oversized.content }])
    expect(context.length).toBeGreaterThan(0)
  })

  /*
   * The reachable shape of the same guarantee, and the reason D16 is not a
   * theoretical guard.
   *
   * `CONTENT_MAX` bounds a user turn, but `storedMessageSchema` deliberately
   * carries no maximum on `content` (Slice 6 D11), so an **assistant** turn is
   * bounded only by `MAX_OUTPUT_BYTES` at 800,000. One long generation therefore
   * exceeds the whole 80,000-character transcript budget on its own, using only
   * values the routes can really store.
   *
   * What must happen next: the giant reply is dropped, the newest user turn
   * survives, and the result is neither empty nor led by an assistant message.
   */
  it('drops an over-budget assistant reply and still returns a usable context', () => {
    const asked = sized('user', 3, 500)
    const messages = [
      sized('user', 0, 1_000),
      sized('assistant', 1, 1_000),
      sized('assistant', 2, 150_000),
      asked,
    ]

    const context = buildContext(messages)

    expect(context).toEqual([{ role: 'user', content: asked.content }])
    expect(context[0]?.role).toBe('user')
  })

  /* Purity again, on the path that actually slices: trimming must copy, never
   * splice the caller's array in place. */
  it('leaves an over-budget transcript untouched', () => {
    const messages = alternating(41, 3_800)
    const before = JSON.stringify(messages)

    buildContext(messages)

    expect(JSON.stringify(messages)).toBe(before)
  })
})
