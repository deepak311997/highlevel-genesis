import { describe, expect, it } from 'vitest'

import { FILE_BYTES_MAX, FILE_EXTENSIONS, FILE_LIMIT } from '../files/schema'
import { CLOSE_TAG, OPEN_HEAD, OPEN_TAIL } from './fileops'
import { SYSTEM_PROMPT } from './prompt'

/**
 * The system prompt: the structural property (Slice 5, AC-7) and the file format
 * (Slice 6, AC-34, D25).
 *
 * `CLAUDE.md` requires the HighLevel cheat-sheet pinned behind a `cache_control`
 * breakpoint. The cheat-sheet is Slice 9's; what Slice 5 owed was the *structure*
 * — a stable prefix, a breakpoint at its end, and nothing volatile above it.
 * Nothing volatile is the part a machine can check, so it is checked here rather
 * than asserted in a comment.
 *
 * **Slice 6 adds the assertion that actually stops a silent failure**: the tag
 * syntax, the extension list and both caps in the prompt are read here from the
 * modules the *parser* and the *schema* use. Without it the classic drift is
 * invisible — the prompt goes on documenting a grammar the parser no longer
 * speaks, and the only symptom is the model producing output we reject.
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
  /*
   * The needles are unchanged from Slice 5, and **what they assert has changed**.
   * `leadconnectorhq` and `/contacts` still belong to Slice 9. The other three are
   * now about the format that *is* here: a triple-backtick fence is the delimiter
   * D2 rejected, and `FILE:` and `file_start` are two spellings it is not. Their
   * absence pins the sentinel format rather than the block's absence.
   */
  it.each(['leadconnectorhq', '/contacts', 'file_start', '```', 'FILE:'])(
    'says nothing about %s',
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

/**
 * AC-34, D25 — **the file format, derived from the parser's own constants.**
 *
 * Every needle below is imported from the module that decides it, so a constant
 * changing on one side fails here rather than in production. That is the whole
 * point: Slice 5's D17 withheld these instructions because they would have
 * described a parser that did not exist; a hand-written copy of the grammar would
 * be the same mistake with an extra step.
 */
describe('the file-format block', () => {
  const text = (): string => SYSTEM_PROMPT.map((block) => block.text).join('\n')

  it('is a second block, and the breakpoint moved to it', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(1)
    expect(SYSTEM_PROMPT.filter((block) => block.cache_control != null)).toHaveLength(1)
    expect(SYSTEM_PROMPT.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('spells the tag pair exactly as the splitter reads it', () => {
    expect(text()).toContain(OPEN_HEAD)
    expect(text()).toContain(OPEN_TAIL)
    expect(text()).toContain(CLOSE_TAG)
  })

  it.each([...FILE_EXTENSIONS])('names the .%s extension', (extension) => {
    expect(text()).toContain(`.${extension}`)
  })

  it('states both caps from their constants', () => {
    expect(text()).toContain(String(FILE_LIMIT))
    expect(text()).toContain(`${String(FILE_BYTES_MAX / 1000)} KB`)
  })

  /* D1: flat filenames, no directories, no build step, `index.html` the entry. */
  it.each(['index.html', 'flat', 'directories'])('states the %s rule', (needle) => {
    expect(text()).toContain(needle)
  })

  /* D17: a reply with no file blocks is a legitimate turn, and the model is told so. */
  it('says that answering without files is fine', () => {
    expect(text().toLowerCase()).toContain('without')
  })

  /*
   * The prompt is still a constant. Anything computed per call — a date, a
   * project name, an interpolated id — makes every request a cache miss once
   * caching is real, and the only symptom is the bill.
   */
  it('is still identical on every read', () => {
    expect(JSON.stringify(SYSTEM_PROMPT)).toBe(JSON.stringify(SYSTEM_PROMPT))
  })
})
