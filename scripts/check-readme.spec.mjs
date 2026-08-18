import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  BULLET_CAPS,
  README,
  REQUIRED_SECTIONS,
  orderedItemCount,
  sectionBody,
  sectionProblems,
  sectionsOf,
} from './check-readme.mjs'

/**
 * AC-3 … AC-8 and AC-10 — the README, held true by a test.
 *
 * The README is the one artefact this assignment is graded on directly, and it
 * is the one artefact nothing else in the repository reads. That is how the file
 * on `main` came to name two scripts that do not exist, a root `npm run` script
 * that does not exist, live URLs that were "not deployed yet" months after they
 * answered `200`, and an architecture decision the project had already reversed.
 * Every one of those is a mechanical claim, and a mechanical claim can be
 * checked.
 *
 * Each check is asserted **twice** — once over a fixture that proves the check
 * can fail, and once over the real committed README that proves it passes today.
 * That is the PRD's own rule for this slice (test matrix, final paragraph): the
 * fixture alone proves the regex works, and the real file alone proves nothing
 * about what happens when someone edits it. Where a fixture stands in for a line
 * the README used to carry, it carries that line verbatim.
 */

const readme = readFileSync(README, 'utf8')

/** A README-shaped document: every required section, with the given bodies. */
function readmeFixture(bodies = {}) {
  return REQUIRED_SECTIONS.map((heading) => `## ${heading}\n\n${bodies[heading] ?? 'Prose.\n'}`)
    .join('\n')
    .concat('\n')
}

/** `n` top-level numbered items, as a section body. */
const numbered = (n) =>
  Array.from({ length: n }, (_, index) => `${String(index + 1)}. Item ${String(index + 1)}.`).join(
    '\n',
  )

describe('sectionsOf', () => {
  it('returns the `## ` headings in document order, ignoring deeper levels', () => {
    const text = ['# Title', '', '## First', '', '### Not a section', '', '## Second', ''].join(
      '\n',
    )

    expect(sectionsOf(text)).toEqual(['First', 'Second'])
  })
})

describe('sectionBody', () => {
  it('runs from the heading to the next `## `, keeping `###` subsections', () => {
    const text = ['## First', 'a', '', '### Sub', 'b', '', '## Second', 'c', ''].join('\n')

    expect(sectionBody(text, 'First')).toContain('### Sub')
    expect(sectionBody(text, 'First')).not.toContain('c')
    expect(sectionBody(text, 'Absent')).toBe('')
  })
})

describe('orderedItemCount', () => {
  it('counts only top-level `1. ` lines, not indented or continuation ones', () => {
    const body = ['1. One', '   1. Nested', '   continued', '2. Two', 'prose 3. not an item'].join(
      '\n',
    )

    expect(orderedItemCount(body)).toBe(2)
  })
})

describe('required sections — AC-5', () => {
  it('the real README carries all seven brief-named sections', () => {
    expect(sectionsOf(readme)).toEqual(expect.arrayContaining([...REQUIRED_SECTIONS]))
  })

  it('names the section a README is missing', () => {
    const fixture = readmeFixture().replace('## Deployment\n\nProse.\n', '')

    expect(sectionProblems(fixture)).toEqual(['missing section: ## Deployment'])
  })
})

describe('bullet caps — AC-6', () => {
  it('the real README stays inside both caps', () => {
    for (const [heading, cap] of Object.entries(BULLET_CAPS)) {
      expect(orderedItemCount(sectionBody(readme, heading))).toBeLessThanOrEqual(cap)
    }

    expect(sectionProblems(readme)).toEqual([])
  })

  it('names the section and the count when an eleventh decision is added', () => {
    const fixture = readmeFixture({ 'Architecture decisions': numbered(11) })

    expect(sectionProblems(fixture)).toEqual([
      'Architecture decisions: 11 numbered items, cap is 10',
    ])
  })

  it('names the section and the count when a sixth improvement is added', () => {
    const fixture = readmeFixture({ 'What I would improve': numbered(6) })

    expect(sectionProblems(fixture)).toEqual(['What I would improve: 6 numbered items, cap is 5'])
  })
})
