import { describe, expect, it } from 'vitest'

import { FILE_BYTES_MAX, FILE_EXTENSIONS, FILE_LIMIT } from '../files/schema'
import { estimateTokens } from './budget'
import { CLOSE_TAG, OPEN_HEAD, OPEN_TAIL } from './fileops'
import { HL_KNOWLEDGE } from './hlKnowledge'
import { SYSTEM_PROMPT } from './prompt'

/**
 * The system prompt: the structural property (Slice 5, AC-7) and the file format
 * (Slice 6, AC-34, D25).
 *
 * `CLAUDE.md` requires the HighLevel cheat-sheet pinned behind a `cache_control`
 * breakpoint. Slice 5 owed the *structure* — a stable prefix, a breakpoint at its
 * end, and nothing volatile above it; **Slice 9 supplies the cheat-sheet itself**
 * and moves the breakpoint onto it, which is what turns that structure from a
 * declaration into a cache read (D18). Nothing volatile is the part a machine can
 * check, so it is checked here rather than asserted in a comment — and it now
 * scans three blocks rather than two.
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
   * The breakpoint sits on the **last** block of the stable prefix, which is the
   * last block there is — Slice 9 moved it down onto the cheat-sheet rather than
   * adding a second one. What this pins is that exactly one breakpoint exists and
   * that it is at the end: a breakpoint in the middle caches a prefix shorter
   * than the stable one, and nothing errors when it does.
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
   * The needle list changes shape in Slice 9, because two of Slice 5's needles
   * have become false in the way the plan intended. `leadconnectorhq` and
   * `/contacts` were placeholders for "the cheat-sheet is not here yet"; the
   * cheat-sheet is here now and names `/contacts/search` legitimately, so keeping
   * them would assert the opposite of AC-1.
   *
   * What replaces them is the assertion Slice 9 actually owes (AC-4, D4): the
   * model is taught **one function and no URL**. Not the HighLevel origin —
   * generated code cannot reach it, having neither CORS nor a token — and not the
   * proxy path either, because a `fetch('/api/hl/proxy/…')` from a `srcdoc`
   * iframe has an opaque origin and cannot carry an ID token (Slice 8 D16). Both
   * absences are re-checked on the cheat-sheet itself in `hlKnowledge.spec.ts`.
   *
   * The other three are unchanged and still about the file format: a
   * triple-backtick fence is the delimiter D2 rejected, and `FILE:` and
   * `file_start` are two spellings it is not.
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
 * Every needle below is imported from the module that decides it, so a constant
 * changing on one side fails here rather than in production. That is the whole
 * point: Slice 5's D17 withheld these instructions because they would have
 * described a parser that did not exist; a hand-written copy of the grammar would
 * be the same mistake with an extra step.
 */
describe('the file-format block', () => {
  const text = (): string => SYSTEM_PROMPT.map((block) => block.text).join('\n')

  /*
   * It is the second block, and Slice 9 took the breakpoint off it: the
   * breakpoint belongs at the end of the stable prefix, and the prefix now ends
   * with the cheat-sheet. Asserted as an absence rather than dropped, because a
   * *second* breakpoint here would be silently wrong — the API accepts it, and
   * the only symptom is a shorter cached prefix.
   */
  it('is the second block, and no longer carries the breakpoint', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(2)
    expect(SYSTEM_PROMPT[1]?.cache_control).toBeUndefined()
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

/**
 * Slice 9 — the cheat-sheet block, and the breakpoint that is finally real
 * (AC-4, AC-10, AC-11, AC-12, D18).
 *
 * What is asserted here is the *arrangement*: that the HighLevel knowledge is one
 * block, that it is the last of the stable prefix, that the single breakpoint is
 * on it, and that the prefix is now long enough for the model to cache at all.
 * What the block says is `hlKnowledge.spec.ts`'s business, checked there against
 * the tables it was rendered from.
 */
describe('the HighLevel cheat-sheet block', () => {
  const text = (): string => SYSTEM_PROMPT.map((block) => block.text).join('\n')

  /*
   * One block, not two, and not a fourth appended later. It keeps "the breakpoint
   * is the last element of the stable prefix" a one-line assertion rather than a
   * claim about how the blocks happen to be arranged, and it is the property
   * `params.ts` relies on when it appends volatile project state *after* the
   * prefix.
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
   * AC-4. One function and no URL: the model is taught `hl(`, and neither the
   * HighLevel origin nor the proxy path appears anywhere in the prefix. The
   * needle list above asserts the two absences; this states the presence they
   * exist to protect, so a cheat-sheet that dropped the convention entirely could
   * not pass by saying nothing.
   */
  it("teaches the hl(' convention", () => {
    expect(text()).toContain("hl('")
  })

  /*
   * AC-11, D18. `claude-opus-5` caches nothing below 512 tokens, and **no error
   * says so** — `cache_creation_input_tokens` and `cache_read_input_tokens`
   * simply both read `0`, which is exactly what Slice 5's breakpoint did. The
   * floor here is twice that minimum, because `estimateTokens` is four characters
   * per token rather than the tokenizer and the margin is what makes the estimate
   * safe to rely on.
   *
   * This is an estimate, not the confirmation. The confirmation is
   * `cacheReadInputTokens > 0` on the second generation of a session, which the
   * `generation.complete` log line already carries and which the definition of
   * done checks by hand against real credentials.
   */
  it('makes the stable prefix long enough for the model to cache', () => {
    expect(estimateTokens(text())).toBeGreaterThanOrEqual(1024)
  })

  /*
   * AC-10, extended to the new block by construction: the scan at the top of this
   * file runs over every block there is. Restated here because the cheat-sheet is
   * the block most likely to acquire a date — the allowlist's own `version` values
   * are `2021-`-shaped, and rendering them would have been the obvious thing to do.
   */
  it('carries nothing volatile, like every block above it', () => {
    expect(SYSTEM_PROMPT[2]?.text).not.toMatch(VOLATILE)
  })
})
