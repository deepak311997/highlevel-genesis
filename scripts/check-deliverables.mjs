#!/usr/bin/env node
/**
 * Assert the two deliverable documents still say what they promise.
 *
 * `loom-script.md` and `release-checklist.md` are the slice's only artefacts a
 * reviewer reads that no other check can reach — the README has
 * `check-readme.mjs`, the environment has `check-secrets.mjs`. Both of these are
 * prose, and prose is exactly where a requirement goes quiet: a beat dropped
 * from a shot list looks like an edit, and a checklist item with no owner looks
 * like an item.
 *
 * So the two mechanical claims they make are held by a test rather than by
 * memory:
 *
 *   - the shot list covers the brief's nine golden-path beats, in the brief's
 *     order, and its per-beat timings fit inside five minutes (AC-17);
 *   - every checkbox line in the checklist carries exactly one owner tag, so
 *     nothing can be added without saying who closes it (AC-18).
 *
 * Everything here is a pure function over text, so `check-deliverables.spec.mjs`
 * can assert twice: once over a fixture that proves the check can fail, and once
 * over the real committed document that proves it passes today.
 *
 *   node scripts/check-deliverables.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Repo root, resolved from this file so the checks work from any cwd. */
export const ROOT = join(import.meta.dirname, '..')

export const LOOM_DOC = join(ROOT, 'docs/slices/13-deliverables/loom-script.md')
export const CHECKLIST_DOC = join(ROOT, 'docs/slices/13-deliverables/release-checklist.md')

/**
 * The brief's golden path, in the brief's order.
 *
 * Nine, not ten. `docs/IMPLEMENTATION_PLAN.md` §4 quotes the brief's own
 * sentence — "sign up → connect HighLevel → create project → prompt → watch the
 * stream → real HL data in preview → edit a file → restore a snapshot → one
 * architecture decision" — and that list is nine steps. The PRD's user flow
 * counts *verify* as a tenth because a reviewer walking the product does verify;
 * the recording narrates that inside `sign-up` rather than spending a beat on
 * waiting for an email.
 */
export const LOOM_BEATS = [
  'sign-up',
  'connect-highlevel',
  'create-project',
  'prompt',
  'stream',
  'preview',
  'edit-file',
  'restore-snapshot',
  'architecture-decision',
]

/** Five minutes. The brief's cap, and the reason the shot list has a Length column. */
export const LOOM_BUDGET_SECONDS = 300

const SHOT_LIST_HEADING = '## Shot list'

/** `m:ss` → seconds, or `null` when the cell is not a duration. */
function parseLength(cell) {
  const match = /^(\d+):([0-5]\d)$/.exec(cell.trim())
  if (match === null) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** Seconds → `m:ss`, so a problem message speaks the document's own units. */
function formatSeconds(total) {
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total - minutes * 60).padStart(2, '0')}`
}

/**
 * Rows of the first markdown table under `## Shot list`.
 *
 * The **Beat** cell is an inline-code slug and **Length** is `m:ss`; the two
 * prose columns are the recorder's, not the checker's, so they are read past.
 * Parsing by column *content* rather than by column index is deliberate — the
 * shape that matters is "a slug and a duration on the same row", and a doc that
 * grows a column should not fail a check about beats.
 */
export function loomShotList(text) {
  const heading = text.indexOf(SHOT_LIST_HEADING)
  if (heading === -1) return []

  const rows = []
  for (const line of text.slice(heading + SHOT_LIST_HEADING.length).split('\n')) {
    // The next `## ` ends the section: a later table is a different subject.
    if (line.startsWith('## ')) break
    if (!line.trim().startsWith('|')) {
      // Blank lines and prose sit between the heading and the table; only a run
      // of table lines *after* the first row ends it.
      if (rows.length > 0 && line.trim() !== '') break
      continue
    }

    const cells = line.split('|').slice(1, -1)
    const beat = cells.map((cell) => /^\s*`([a-z0-9-]+)`\s*$/.exec(cell)).find((m) => m !== null)
    if (beat === null || beat === undefined) continue

    const seconds = cells.map(parseLength).find((value) => value !== null)
    if (seconds === undefined) continue

    rows.push({ beat: beat[1], seconds })
  }

  return rows
}

/**
 * Human-readable problems with a shot list: wrong beat, wrong order, missing,
 * over budget. Empty means the document is conformant.
 *
 * Reports *every* problem rather than the first, because the recorder fixes the
 * document once and a checker that names one problem per run is a checker run
 * four times.
 */
export function loomProblems(text) {
  const rows = loomShotList(text)
  if (rows.length === 0) {
    return [`No shot list found — expected a markdown table under \`${SHOT_LIST_HEADING}\`.`]
  }

  const problems = []
  const named = rows.map((row) => row.beat)

  for (const beat of LOOM_BEATS) {
    if (!named.includes(beat)) problems.push(`Missing beat: \`${beat}\` is in the brief's path.`)
  }
  for (const beat of named) {
    if (!LOOM_BEATS.includes(beat))
      problems.push(`Unknown beat: \`${beat}\` is not one of the nine.`)
  }

  /*
   * Order is checked over the beats that are actually present, so a missing beat
   * is reported once as missing rather than a second time as every later beat
   * being in the wrong place.
   */
  const present = named.filter((beat) => LOOM_BEATS.includes(beat))
  const expected = LOOM_BEATS.filter((beat) => present.includes(beat))
  for (const [index, beat] of present.entries()) {
    if (beat !== expected[index]) {
      problems.push(
        `Wrong order: beat ${index + 1} is \`${beat}\`, expected \`${expected[index]}\`.`,
      )
    }
  }

  const total = rows.reduce((sum, row) => sum + row.seconds, 0)
  if (total > LOOM_BUDGET_SECONDS) {
    problems.push(
      `Over budget: the timings sum to ${formatSeconds(total)}, ` +
        `and the brief's cap is ${formatSeconds(LOOM_BUDGET_SECONDS)}.`,
    )
  }

  return problems
}

/**
 * The three owners D2 names, and the only tags a checklist item may carry.
 *
 * An item with no owner is the failure mode this whole document exists to
 * prevent: the release checklist is a hand-off to a session that is not this
 * one, and "someone will do this" is what a checklist is supposed to replace.
 */
export const OWNER_TAGS = ['(automated)', '(this PR)', '(human)']

const CHECKBOX = /^\s*[-*] \[[ xX]\]/
const OWNER_PATTERN = new RegExp(
  OWNER_TAGS.map((tag) => tag.replace(/[()]/g, (char) => `\\${char}`)).join('|'),
  'g',
)

/**
 * Every `- [ ]` / `- [x]` line, with the owner tags it carries, in the order
 * they appear on it.
 *
 * **Only the checkbox line is read, never its continuation lines.** Items here
 * run to several lines — a procedure, then an evidence slot — and a tag on the
 * third line of an item is invisible to anyone skimming the file for who owns
 * what, which is the only thing the tag is for. Repeats are kept rather than
 * deduped, so `(human) … (human)` is a problem too.
 */
export function checkboxLines(text) {
  return text
    .split('\n')
    .filter((line) => CHECKBOX.test(line))
    .map((line) => ({
      line: line.trim(),
      owners: [...line.matchAll(OWNER_PATTERN)].map((m) => m[0]),
    }))
}

/** Lines carrying other than exactly one owner tag. Empty means conformant. */
export function ownerProblems(text) {
  return checkboxLines(text).flatMap(({ line, owners }) => {
    if (owners.length === 1) return []
    if (owners.length === 0) {
      return [`No owner tag — expected one of ${OWNER_TAGS.join(', ')} — on: ${line}`]
    }
    return [`${String(owners.length)} owner tags (${owners.join(', ')}) on: ${line}`]
  })
}

// Guarded so importing this module from the spec does not run the checks.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const checks = [
    { file: 'loom-script.md', problems: loomProblems(readFileSync(LOOM_DOC, 'utf8')) },
    { file: 'release-checklist.md', problems: ownerProblems(readFileSync(CHECKLIST_DOC, 'utf8')) },
  ]

  const failed = checks.filter((check) => check.problems.length > 0)
  if (failed.length > 0) {
    for (const { file, problems } of failed) {
      console.error(`${file}:`)
      for (const problem of problems) console.error(`  ${problem}`)
    }
    process.exit(1)
  }

  const items = checkboxLines(readFileSync(CHECKLIST_DOC, 'utf8')).length
  console.log(`loom-script.md — ${String(LOOM_BEATS.length)} beats in order, inside the budget.`)
  console.log(`release-checklist.md — ${String(items)} items, each with exactly one owner.`)
}
