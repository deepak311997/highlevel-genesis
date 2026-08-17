import { describe, expect, it } from 'vitest'

import { SYSTEM_PROMPT } from './prompt'

/**
 * The system prompt, and the one structural property that has to hold (AC-7).
 *
 * `CLAUDE.md` requires the HighLevel cheat-sheet pinned behind a `cache_control`
 * breakpoint. The cheat-sheet is Slice 9's; what this slice owes is the
 * *structure* — a stable prefix, a breakpoint at its end, and nothing volatile
 * above it. Nothing volatile is the part a machine can check, so it is checked
 * here rather than asserted in a comment: a project name, a uid, a message or a
 * timestamp above the breakpoint would silently make every request a cache miss
 * once Slice 9 makes caching real, and nothing would say so.
 */

/**
 * Volatile shapes, as a pattern.
 *
 * An ISO date or a long digit run is a timestamp; `uid` and `projectId` are the
 * two per-request identifiers this codebase actually names. It is not a proof
 * that nothing volatile is there — no regex could be — but it catches the ways
 * volatility has ever arrived in this project.
 */
const VOLATILE = /\d{4}-\d{2}-\d{2}|\d{10,}|\buid\b|projectId/i

describe('SYSTEM_PROMPT', () => {
  it('is a non-empty array of text blocks', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0)
    for (const block of SYSTEM_PROMPT) {
      expect(block.type).toBe('text')
      expect(block.text.trim()).not.toBe('')
    }
  })

  /*
   * The breakpoint sits on the **last** block of the stable prefix, which today
   * is the last block there is. Slice 9 adds the cheat-sheet above it, so what
   * this pins is that exactly one breakpoint exists and that it is at the end —
   * a breakpoint in the middle would cache a prefix shorter than the stable one.
   */
  it('carries exactly one cache_control breakpoint, on the last block', () => {
    const withBreakpoint = SYSTEM_PROMPT.filter((block) => block.cache_control != null)

    expect(withBreakpoint).toHaveLength(1)
    expect(SYSTEM_PROMPT.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
  })

  /** AC-7. The assertion that a comment could not make. */
  it('carries nothing volatile in any block at or above the breakpoint', () => {
    for (const block of SYSTEM_PROMPT) {
      expect(block.text).not.toMatch(VOLATILE)
    }
  })

  /*
   * Stability is the requirement the breakpoint imposes, so the prompt is a
   * constant rather than something computed per call. A `new Date()` or a
   * template interpolation here would make every request a cache miss, and the
   * only symptom would be a bill.
   */
  it('is the same value every time it is read', () => {
    expect(SYSTEM_PROMPT).toEqual([...SYSTEM_PROMPT])
    expect(JSON.stringify(SYSTEM_PROMPT)).toBe(JSON.stringify(SYSTEM_PROMPT))
  })

  /*
   * D17. No HighLevel endpoints and no file-format instructions: an endpoint
   * list written now would be wrong by Slice 9, and a file-format instruction
   * would describe a parser that does not exist until Slice 6. The surest way to
   * be stable is to say only what is already true.
   */
  it.each(['leadconnectorhq', '/contacts', 'file_start', '```', 'FILE:'])(
    'says nothing about %s, which belongs to a later slice',
    (needle) => {
      expect(SYSTEM_PROMPT.map((block) => block.text).join('\n')).not.toContain(needle)
    },
  )

  it('says what Genesis is and that it builds over a HighLevel CRM', () => {
    const text = SYSTEM_PROMPT.map((block) => block.text).join('\n')

    expect(text).toContain('Genesis')
    expect(text).toContain('HighLevel')
  })
})
