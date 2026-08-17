import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'

import { PROJECT_FILE_BUDGET } from './budget'
import { CLOSE_TAG, OPEN_HEAD } from './fileops'
import { buildProjectState, PROJECT_FILE_CLOSE, PROJECT_FILE_OPEN } from './projectState'
import type { ProjectFile } from './projectState'

/**
 * The project-state block — AC-14 to AC-17, and the hazard the slice must not
 * ship.
 *
 * R2 names it exactly: **a truncated file would silently rewrite code the user
 * never touched.** Handed half a file, the model completes it from imagination
 * and writes the whole thing back, and the user's own work is gone with no error
 * anywhere. D14 makes that unrepresentable — files are whole or absent — so the
 * assertions here are mostly negatives: no fragment of an over-budget file
 * appears anywhere in the block (AC-17), and an omitted file is *named* rather
 * than merely missing (AC-15), because a model that cannot see `app.js` concludes
 * it does not exist and creates a second one under a different name.
 *
 * ## Why the contents are distinctive rather than `'x'.repeat(n)`
 *
 * Every synthetic file below is filled with a repeated marker unique to it. A
 * block built from `'x'.repeat(n)` makes `toContain` and `not.toContain` both
 * meaningless — every file is a substring of every larger one — and AC-17's
 * assertion in particular would pass against an implementation that truncated
 * happily.
 */

/** Content of exactly `length` characters, made of a marker unique to the file. */
function filler(marker: string, length: number): string {
  return `${marker}·`.repeat(Math.ceil(length / (marker.length + 1))).slice(0, length)
}

/**
 * The block, with the `null` case ruled out.
 *
 * Every case below except the empty-project one has already asserted that files
 * produce a block; unwrapping here keeps each of them a single assertion about
 * the text rather than a null check followed by one.
 */
function build(files: readonly ProjectFile[]): TextBlockParam {
  const block = buildProjectState(files)
  if (block === null) throw new Error('expected a project-state block, got null')
  return block
}

/**
 * A file whose own text closes a `<genesis:file>` block — D24's reason for the
 * delimiters being what they are. Byte for byte, into the prompt.
 */
const CLOSE_TAG_TRAP = ['function render() {', `  // ${CLOSE_TAG}`, '}', ''].join('\n')

const THREE: readonly ProjectFile[] = [
  { path: 'index.html', content: '<!doctype html>\n<h1>Contacts</h1>\n' },
  { path: 'app.js', content: CLOSE_TAG_TRAP },
  { path: 'styles.css', content: 'body { margin: 0 }\n' },
]

describe('buildProjectState', () => {
  /*
   * AC-13's other half. A project with no files appends no block at all, so the
   * request is byte-identical in shape to the one Slice 5 sent — and `params.ts`
   * can keep `system` the `SYSTEM_PROMPT` array *itself*, which is what keeps the
   * cached prefix alive.
   */
  it('returns null for a project holding no files', () => {
    expect(buildProjectState([])).toBeNull()
  })

  it('renders one text block', () => {
    expect(build(THREE).type).toBe('text')
  })

  /* AC-14. Both halves: the path, so the model can name the file in a reply, and
   * the content byte for byte, so it is modifying the code rather than guessing
   * at it. */
  it('carries every path and every content byte for byte', () => {
    const { text } = build(THREE)
    for (const file of THREE) {
      expect(text).toContain(file.path)
      expect(text).toContain(file.content)
    }
  })

  /*
   * D24. The content is the user's own — files reach Firestore only from this
   * user's generations and this user's `PUT` — so there is no cross-tenant path
   * and sanitising would corrupt the very code the model is being asked to
   * change. What the distinct delimiter buys is separate: a file that happens to
   * contain a closing tag must not read to the model as an example of how to
   * close a block it is writing.
   */
  it('passes a file that contains a genesis close tag through untouched', () => {
    expect(build(THREE).text).toContain(CLOSE_TAG_TRAP)
  })

  it('delimits files with something that is not the file-op tag pair', () => {
    expect(PROJECT_FILE_OPEN).not.toContain(OPEN_HEAD)
    expect(PROJECT_FILE_OPEN).not.toContain('genesis')
    expect(PROJECT_FILE_CLOSE).not.toBe(CLOSE_TAG)
    expect(PROJECT_FILE_CLOSE).not.toContain('genesis')
  })

  /*
   * The block is volatile — it changes whenever the project does — so it sits
   * *after* the breakpoint and carries none of its own (D11). A `cache_control`
   * here would write a cache entry per project state and read one back never.
   */
  it('carries no cache_control of its own', () => {
    const block = build(THREE)
    expect('cache_control' in block).toBe(false)
    expect(block.cache_control).toBeUndefined()
  })

  /* A builder that sorted its argument in place would reorder the caller's list
   * — here, the list `handleGenerate` may go on to use. */
  it('does not modify the caller’s array', () => {
    const files = [...THREE]
    const before = JSON.stringify(files)
    buildProjectState(files)
    expect(JSON.stringify(files)).toBe(before)
  })
})

/*
 * AC-16. `index.html` is the entry point (Slice 6 D1) — the one file whose
 * absence changes what the app *is* — so it is first whatever it weighs. The
 * rest ascend by size, which maximises the number of complete files that fit,
 * and ties break on path so the block is byte-identical for the same project on
 * every request.
 */
describe('the order files appear in', () => {
  const ORDERED: readonly ProjectFile[] = [
    { path: 'zebra.css', content: filler('zebra', 3_000) },
    { path: 'index.html', content: filler('index', 5_000) },
    { path: 'app.js', content: filler('app', 1_000) },
  ]

  const positionOf = (text: string, path: string): number =>
    text.indexOf(`${PROJECT_FILE_OPEN}${path} `)

  it('puts index.html first, then the rest by ascending size', () => {
    const { text } = build(ORDERED)
    expect(positionOf(text, 'index.html')).toBeGreaterThanOrEqual(0)
    expect(positionOf(text, 'index.html')).toBeLessThan(positionOf(text, 'app.js'))
    expect(positionOf(text, 'app.js')).toBeLessThan(positionOf(text, 'zebra.css'))
  })

  it('breaks a size tie on path, so the same project renders the same bytes', () => {
    const { text } = build([
      { path: 'b.js', content: filler('bee', 500) },
      { path: 'a.js', content: filler('ay', 500) },
    ])
    expect(positionOf(text, 'a.js')).toBeLessThan(positionOf(text, 'b.js'))
  })
})

/*
 * AC-15 and AC-17 — D14's budget, and the two properties that make it safe.
 */
describe('the file budget', () => {
  /**
   * One omitted file's manifest entry, as its own list item.
   *
   * The leading `- ` is what makes the assertion mean something: an *included*
   * file's opening delimiter also reads `<path> (<n> characters)`, so a bare
   * containment check would report every file as omitted.
   */
  const manifestEntry = (file: ProjectFile): string =>
    `- ${file.path} (${String(file.content.length)} characters)`

  /*
   * Four files summing to 180,000 characters against a 120,000-character budget,
   * with the sizes chosen so the first three land on the limit *exactly* — the
   * boundary is where an off-by-one lives, and `<=` versus `<` is the difference
   * between a file fitting and a file being dropped for no reason.
   */
  const OVER_BUDGET: readonly ProjectFile[] = [
    { path: 'a.js', content: filler('alpha', 30_000) },
    { path: 'b.js', content: filler('bravo', 40_000) },
    { path: 'c.js', content: filler('charlie', 50_000) },
    { path: 'd.js', content: filler('delta', 60_000) },
  ]

  it('includes whole files up to the budget and no more', () => {
    const { text } = build(OVER_BUDGET)
    const included = OVER_BUDGET.filter((file) => text.includes(file.content))
    expect(included.length).toBeGreaterThan(0)
    expect(included.reduce((total, file) => total + file.content.length, 0)).toBeLessThanOrEqual(
      PROJECT_FILE_BUDGET,
    )
  })

  /* The manifest line. Without it the model concludes the file does not exist
   * and creates a second one under a different name (D14). */
  it('names every omitted file with its size', () => {
    const { text } = build(OVER_BUDGET)
    const omitted = OVER_BUDGET.filter((file) => !text.includes(file.content))
    expect(omitted.length).toBeGreaterThan(0)
    for (const file of omitted) expect(text).toContain(manifestEntry(file))
  })

  /* No manifest when nothing was left out — an empty "these files were not
   * included" list invites the model to look for files that are all in front of
   * it. */
  it('lists nothing when every file fitted', () => {
    const { text } = build(THREE)
    for (const file of THREE) expect(text).not.toContain(manifestEntry(file))
  })

  /*
   * AC-17, asserted as a negative on a slice taken from the *middle* of the
   * file: a truncating implementation would keep the head, so asserting on the
   * head alone would let one through. 200 characters is long enough that its
   * appearance anywhere in the block could not be coincidence.
   */
  it('contributes no fragment at all of a file larger than the whole budget', () => {
    const huge: ProjectFile = { path: 'huge.js', content: filler('huge', PROJECT_FILE_BUDGET + 1) }
    const files: readonly ProjectFile[] = [{ path: 'app.js', content: filler('app', 100) }, huge]
    const { text } = build(files)

    const middle = huge.content.slice(PROJECT_FILE_BUDGET / 2, PROJECT_FILE_BUDGET / 2 + 200)
    expect(middle).toHaveLength(200)
    expect(text).not.toContain(middle)
    expect(text).toContain(manifestEntry(huge))
  })

  /*
   * Why the loop continues rather than stopping at the first file that does not
   * fit. Ascending size normally puts the oversized file last, so only
   * `index.html` — pinned first whatever it weighs — can starve the files behind
   * it, and that is exactly the shape of a project whose entry point grew.
   */
  it('keeps the small files behind an oversized index.html', () => {
    const small: readonly ProjectFile[] = [
      { path: 'app.js', content: filler('app', 200) },
      { path: 'styles.css', content: filler('styles', 300) },
    ]
    const huge: ProjectFile = {
      path: 'index.html',
      content: filler('entry', PROJECT_FILE_BUDGET + 1),
    }
    const { text } = build([huge, ...small])

    for (const file of small) expect(text).toContain(file.content)
    expect(text).not.toContain(huge.content.slice(0, 200))
    expect(text).toContain(manifestEntry(huge))
  })
})
