import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  CHECKLIST_DOC,
  LOOM_BEATS,
  LOOM_BUDGET_SECONDS,
  LOOM_DOC,
  OWNER_TAGS,
  checkboxLines,
  loomProblems,
  loomShotList,
  ownerProblems,
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

/**
 * Whole checklist items — the `- [ ]` line plus its continuation lines, up to
 * the next item or the next heading. The checker itself only ever reads the
 * checkbox line, so this lives here rather than in the module.
 */
function itemBlocks(text) {
  const blocks = []
  for (const line of text.split('\n')) {
    const [entry] = checkboxLines(line)
    if (entry !== undefined) {
      blocks.push({ ...entry, body: line })
      continue
    }
    const open = blocks.at(-1)
    if (open === undefined) continue
    if (line.startsWith('#') || line.startsWith('---'))
      blocks.push({ owners: [], line: '', body: '' })
    else open.body += `\n${line}`
  }
  return blocks.filter((block) => block.line !== '')
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

describe('checkboxLines', () => {
  it('reads unchecked and checked lines alike', () => {
    const lines = checkboxLines(
      ['- [ ] **(human)** Open the live URL.', '- [x] **(this PR)** Write the checklist.'].join(
        '\n',
      ),
    )

    expect(lines.map((entry) => entry.owners)).toEqual([['(human)'], ['(this PR)']])
  })

  it('ignores prose, list items and table rows that are not checkboxes', () => {
    const text = [
      'Every line carries one of (automated), (this PR) or (human).',
      '- A plain bullet (human) is not an item.',
      '| (automated) | a table cell |',
    ].join('\n')

    expect(checkboxLines(text)).toEqual([])
  })

  /*
   * The tag has to be on the `- [ ]` line itself.
   *
   * Items here run to several lines — a procedure, then an evidence slot — and a
   * tag on the third line of one item is invisible when the file is skimmed for
   * who owns what, which is the only reason the tag exists.
   */
  it('does not read an owner tag off a continuation line', () => {
    const lines = checkboxLines(
      ['- [ ] Open the live URL and sign in.', '      **(human)**'].join('\n'),
    )

    expect(lines).toHaveLength(1)
    expect(lines[0].owners).toEqual([])
  })
})

describe('ownerProblems — AC-18', () => {
  it('reports nothing for the real release-checklist.md', () => {
    expect(ownerProblems(readReal(CHECKLIST_DOC))).toEqual([])
  })

  it('names the line when an item has no owner tag', () => {
    const problems = ownerProblems(
      ['- [ ] **(human)** Open the live URL.', '- [ ] Paste the Loom URL into the email.'].join(
        '\n',
      ),
    )

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/Paste the Loom URL into the email/)
  })

  it('names the line when an item carries two owner tags', () => {
    const problems = ownerProblems('- [ ] **(this PR)** Write it, then **(human)** run it.')

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/Write it, then/)
    expect(problems[0]).toMatch(/\(this PR\)/)
    expect(problems[0]).toMatch(/\(human\)/)
  })

  it('names the line when the only tag is on a continuation line', () => {
    const problems = ownerProblems(['- [ ] Open the live URL.', '      **(human)**'].join('\n'))

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/Open the live URL/)
  })

  it('names the tags it will accept', () => {
    expect(OWNER_TAGS).toEqual(['(automated)', '(this PR)', '(human)'])
  })
})

describe('the real release-checklist.md', () => {
  const text = readReal(CHECKLIST_DOC)
  const linesFor = (owner) => checkboxLines(text).filter((line) => line.owners[0] === owner)

  /*
   * The counts are pinned so the ledger is visible in the test rather than only
   * in the document — D2's three owners, and how much each is carrying. Adding
   * an item is meant to be a deliberate edit here too.
   */
  it('carries D2s three owners: 2 automated, 6 this PR, 11 human', () => {
    expect(linesFor('(automated)')).toHaveLength(2)
    expect(linesFor('(this PR)')).toHaveLength(6)
    expect(linesFor('(human)')).toHaveLength(11)
  })

  /*
   * Per item, not per file. Counting `Evidence:` over the whole document would
   * also count the paragraph that explains the convention and any item another
   * owner chose to leave a slot on — a number that happens to match, rather than
   * the claim, which is that no human item is missing its slot.
   */
  it('gives every human item an evidence slot to fill in', () => {
    const withoutSlot = itemBlocks(text)
      .filter((block) => block.owners[0] === '(human)')
      .filter((block) => !block.body.includes('Evidence: _____'))
      .map((block) => block.line)

    expect(withoutSlot).toEqual([])
  })

  it('carries the two hand-checks section 9 owes this slice', () => {
    expect(text).toMatch(/F6\.5/)
    expect(text).toMatch(/F8\.2/)
  })

  it('names the deployed redirect URI the marketplace app has to register', () => {
    expect(text).toContain('https://hl-genesis-app.web.app/api/oauth/callback')
  })

  /*
   * D11, written down rather than remembered. The epoch-millisecond finding cost
   * a day once and is one sentence away from being over-generalised into
   * "HighLevel uses epoch ms everywhere".
   */
  it('says the epoch-millisecond finding is about the events query, not a create body', () => {
    expect(text).toMatch(/GET\s+`?\/calendars\/events`?/)
    expect(text).toMatch(/epoch/i)
  })
})
