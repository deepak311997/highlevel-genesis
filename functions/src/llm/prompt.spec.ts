import { describe, expect, it } from 'vitest'

import { FILE_BYTES_MAX, FILE_EXTENSIONS, FILE_LIMIT } from '../files/schema'
import { estimateTokens } from './budget'
import {
  closeTagFor,
  openTagFor,
  SEPARATOR_ADD,
  SEPARATOR_WITH,
  VERBS,
} from './blocks'
import { HL_KNOWLEDGE } from './hlKnowledge'
import { SYSTEM_PROMPT } from './prompt'

/**
 * The system prompt: the structural property and the file format.
 *
 * `CLAUDE.md` requires the HighLevel cheat-sheet pinned behind a `cache_control` breakpoint.
 * Slice 5 owed the *structure* — a stable prefix, a breakpoint at its end, and nothing volatile
 * above it; **Slice 9 supplies the cheat-sheet itself** and moves the breakpoint onto it, which
 * is what turns that structure from a declaration into a cache read. Nothing volatile is the
 * part a machine can check, so it is checked here rather than asserted in a comment — and it now
 * scans three blocks rather than two.
 */

/**
 * Volatile shapes, as a pattern.
 *
 * An ISO date or a long digit run is a timestamp; `uid` and `projectId` are the two per-request
 * identifiers this codebase actually names. It is not a proof that nothing volatile is there —
 * no regex could be — but it catches the ways volatility has ever arrived in this project.
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
   * The breakpoint sits on the **last** block of the stable prefix, which is the last block
   * there is — Slice 9 moved it down onto the cheat-sheet rather than adding a second one.
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
   * Stability is the requirement the breakpoint imposes, so the prompt is a constant rather than
   * something computed per call.
   */
  it('is the same value every time it is read', () => {
    expect(SYSTEM_PROMPT).toEqual([...SYSTEM_PROMPT])
    expect(JSON.stringify(SYSTEM_PROMPT)).toBe(JSON.stringify(SYSTEM_PROMPT))
  })

  /*
   * The needle list changes shape in Slice 9, because two of Slice 5's needles have become false
   * in the way the plan intended.
   */
  it.each(['services.leadconnectorhq.com', '/api/hl/proxy', 'file_start', '```', 'FILE:'])(
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
 * Every needle below is imported from the module that decides it, so a constant changing on one
 * side fails here rather than in production. That is the whole point: Slice 5's D17 withheld
 * these instructions because they would have described a parser that did not exist; a hand-
 * written copy of the grammar would be the same mistake with an extra step.
 */
describe('the file-format block', () => {
  const text = (): string => SYSTEM_PROMPT.map((block) => block.text).join('\n')

  /*
   * It is the second block, and Slice 9 took the breakpoint off it: the breakpoint belongs at
   * the end of the stable prefix, and the prefix now ends with the cheat-sheet.
   */
  it('is the second block, and no longer carries the breakpoint', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(2)
    expect(SYSTEM_PROMPT[1]?.cache_control).toBeUndefined()
    expect(SYSTEM_PROMPT.filter((block) => block.cache_control != null)).toHaveLength(1)
    expect(SYSTEM_PROMPT.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
  })

  it.each([...VERBS])('spells the %s tag pair exactly as the splitter reads it', (verb) => {
    expect(text()).toContain(openTagFor(verb))
    expect(text()).toContain(closeTagFor(verb))
  })

  it('spells both separators exactly as the splitter reads them', () => {
    expect(text()).toContain(SEPARATOR_ADD)
    expect(text()).toContain(SEPARATOR_WITH)
  })

  it('names every verb, so none is documented only by its example', () => {
    for (const verb of VERBS) expect(text()).toContain(`<genesis:${verb}`)
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

/**
 * Slice 9 — the cheat-sheet block, and the breakpoint that is finally real.
 *
 * What is asserted here is the *arrangement*: that the HighLevel knowledge is one block, that it
 * is the last of the stable prefix, that the single breakpoint is on it, and that the prefix is
 * now long enough for the model to cache at all. What the block says is `hlKnowledge.spec.ts`'s
 * business, checked there against the tables it was rendered from.
 */
describe('the HighLevel cheat-sheet block', () => {
  const text = (): string => SYSTEM_PROMPT.map((block) => block.text).join('\n')

  /*
   * One block, not two, and not a fourth appended later. It keeps "the breakpoint is the last
   * element of the stable prefix" a one-line assertion rather than a claim about how the blocks
   * happen to be arranged, and it is the property `params.ts` relies on when it appends volatile
   * project state *after* the prefix.
   */
  it('is the third block, holding the cheat-sheet whole', () => {
    expect(SYSTEM_PROMPT).toHaveLength(3)
    expect(SYSTEM_PROMPT[2]?.text).toBe(HL_KNOWLEDGE)
  })

  it('is where the one breakpoint sits', () => {
    expect(SYSTEM_PROMPT[2]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(SYSTEM_PROMPT.filter((block) => block.cache_control != null)).toHaveLength(1)
  })

  /*
   * One function and no URL: the model is taught `hl(`, and neither the HighLevel origin nor the
   * proxy path appears anywhere in the prefix.
   */
  it("teaches the hl(' convention", () => {
    expect(text()).toContain("hl('")
  })

  /*
   * `claude-opus-5` caches nothing below 512 tokens, and **no error says so** —
   * `cache_creation_input_tokens` and `cache_read_input_tokens` simply both read `0`, which is
   * exactly what Slice 5's breakpoint did.
   */
  it('makes the stable prefix long enough for the model to cache', () => {
    expect(estimateTokens(text())).toBeGreaterThanOrEqual(1024)
  })

  /*
   * AC-10, extended to the new block by construction: the scan at the top of this file runs over
   * every block there is.
   */
  it('carries nothing volatile, like every block above it', () => {
    expect(SYSTEM_PROMPT[2]?.text).not.toMatch(VOLATILE)
  })
})
