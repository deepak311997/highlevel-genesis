import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  LOOM_BEATS,
  LOOM_BUDGET_SECONDS,
  LOOM_DOC,
  loomProblems,
  loomShotList,
} from './check-deliverables.mjs'

/**
 * AC-17 and AC-18 — the two deliverable documents, held true by a test.
 *
 * These are the slice's only artefacts that no other check can reach. The README
 * has `check-readme.mjs`, the environment has `check-secrets.mjs`; the Loom shot
 * list and the release checklist are prose, and prose is exactly where a
 * requirement goes quiet. So the two mechanical claims they make get asserted:
 * the shot list covers the brief's nine beats, in order, inside five minutes;
 * and every checklist line says who closes it.
 *
 * Each check is asserted **twice** — once over a fixture that proves the check
 * can fail, and once over the real committed document that proves it passes
 * today. That is the PRD's own rule for this slice's checks (test matrix, final
 * paragraph): a fixture alone proves the regex works, and the real file alone
 * proves nothing about what happens when someone edits it.
 */

const readReal = (path) => readFileSync(path, 'utf8')

/** A shot-list document built from `[beat, length]` pairs. */
function loomFixture(rows) {
  const body = rows
    .map(([beat, length], index) => `| ${index + 1} | \`${beat}\` | ${length} | Screen | Say |`)
    .join('\n')

  return [
    '# Loom script',
    '',
    '## Before you record',
    '',
    '- Sandbox seeded.',
    '',
    '## Shot list',
    '',
    '| # | Beat | Length | On screen | What you say |',
    '| --- | --- | --- | --- | --- |',
    body,
    '',
  ].join('\n')
}

/** The pinned budget, as `loom-script.md` itself must spend it. */
const PINNED = [
  ['sign-up', '0:30'],
  ['connect-highlevel', '0:35'],
  ['create-project', '0:20'],
  ['prompt', '0:25'],
  ['stream', '0:45'],
  ['preview', '0:45'],
  ['edit-file', '0:25'],
  ['restore-snapshot', '0:30'],
  ['architecture-decision', '0:35'],
]

describe('loomShotList', () => {
  it('reads the beat slug and the m:ss length from each row', () => {
    expect(loomShotList(loomFixture([['sign-up', '0:30']]))).toEqual([
      { beat: 'sign-up', seconds: 30 },
    ])
  })

  it('reads minutes as well as seconds', () => {
    expect(loomShotList(loomFixture([['stream', '1:05']]))).toEqual([
      { beat: 'stream', seconds: 65 },
    ])
  })

  it('reads no rows when there is no Shot list section', () => {
    expect(loomShotList('# Loom script\n\nNo table here.\n')).toEqual([])
  })
})

describe('loomProblems — AC-17', () => {
  it('reports nothing for the real loom-script.md', () => {
    expect(loomProblems(readReal(LOOM_DOC))).toEqual([])
  })

  it('names a beat the shot list leaves out', () => {
    const problems = loomProblems(
      loomFixture(PINNED.filter(([beat]) => beat !== 'restore-snapshot')),
    )

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/restore-snapshot/)
  })

  it('says so when two beats are out of order', () => {
    const swapped = PINNED.map(([beat, length]) => {
      if (beat === 'stream') return ['preview', length]
      if (beat === 'preview') return ['stream', length]
      return [beat, length]
    })

    const problems = loomProblems(loomFixture(swapped))

    expect(problems.join('\n')).toMatch(/order/i)
    expect(problems.join('\n')).toMatch(/stream/)
    expect(problems.join('\n')).toMatch(/preview/)
  })

  it('reports the budget when the timings sum past five minutes', () => {
    const over = PINNED.map(([beat, length]) =>
      beat === 'architecture-decision' ? [beat, '0:55'] : [beat, length],
    )

    const problems = loomProblems(loomFixture(over))

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/5:10/)
    expect(problems[0]).toMatch(/5:00/)
  })

  it('names a beat that is not one of the nine', () => {
    const problems = loomProblems(loomFixture([...PINNED, ['outro', '0:05']]))

    expect(problems.join('\n')).toMatch(/outro/)
  })

  it('reports the missing table rather than passing an empty shot list', () => {
    const problems = loomProblems('# Loom script\n\nNo table here.\n')

    expect(problems.join('\n')).toMatch(/Shot list/)
  })
})

describe('the real loom-script.md', () => {
  it('spends the pinned budget on the nine beats, in order', () => {
    expect(loomShotList(readReal(LOOM_DOC))).toEqual(
      PINNED.map(([beat, length]) => {
        const [minutes, seconds] = length.split(':')
        return { beat, seconds: Number(minutes) * 60 + Number(seconds) }
      }),
    )
  })

  it('leaves ten seconds of headroom under the budget', () => {
    const total = loomShotList(readReal(LOOM_DOC)).reduce((sum, row) => sum + row.seconds, 0)

    expect(total).toBe(290)
    expect(total).toBeLessThan(LOOM_BUDGET_SECONDS)
  })

  it('is the brief golden path, in the brief order', () => {
    expect(LOOM_BEATS).toEqual([
      'sign-up',
      'connect-highlevel',
      'create-project',
      'prompt',
      'stream',
      'preview',
      'edit-file',
      'restore-snapshot',
      'architecture-decision',
    ])
  })
})
