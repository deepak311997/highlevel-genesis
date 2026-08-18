import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { HL_ROUTES, type HlRoute } from './routes'

/**
 * The README's allowlist table, checked against `HL_ROUTES` (AC-9, PRD D6).
 *
 * `routes.ts` opens by saying the table has **three** consumers: the proxy
 * matches against it, Slice 9 renders it into the system prompt's cheat-sheet,
 * and Slice 13's README renders it once more for a human reader. Two of those
 * three are code and cannot drift. The third is a hand-rendered markdown table,
 * and without this file it is not a third consumer at all — it is a copy, true
 * on the day it was typed and quietly wrong after the first allowlist change.
 * This spec is what makes it real: add a route, change a `Version`, widen a
 * scope, or drop the send row's flag, and `functions`' unit suite goes red until
 * the README says the same thing.
 *
 * The comparison is a **set keyed on `METHOD path`** with equal row counts
 * asserted, so a row the README invents fails just as loudly as one it forgets.
 */

const README = join(__dirname, '../../../README.md')

const ALLOWLIST_HEADING = '### HighLevel API allowlist'

/** One parsed row of the README's rendering. `notes` is kept raw — it is prose. */
interface ReadmeRow {
  method: string
  path: string
  version: string
  scope: string
  notes: string
}

/**
 * A discriminated union rather than `ReadmeRow[] | null`: a README this cannot
 * parse is a failure with a reason, not an empty table that silently agrees
 * with an empty `HL_ROUTES`.
 */
type TableParse = { kind: 'parsed'; rows: ReadmeRow[] } | { kind: 'failed'; reason: string }

/** Cells of a markdown row, without the leading and trailing pipes. */
function cellsOf(line: string): string[] {
  const trimmed = line.trim()
  const withoutLeading = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const inner = withoutLeading.endsWith('|') ? withoutLeading.slice(0, -1) : withoutLeading
  return inner.split('|').map((cell) => cell.trim())
}

function isSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

/** Markdown emphasis stripped, so `` `POST` `` and `POST` compare equal. */
function unquote(cell: string): string {
  return cell.replace(/[`*]/g, '').trim()
}

/** The first markdown table under `### HighLevel API allowlist`. */
function parseAllowlistTable(readmeText: string): TableParse {
  const lines = readmeText.split('\n')
  const headingAt = lines.findIndex((line) => line.trim() === ALLOWLIST_HEADING)
  if (headingAt === -1) {
    return { kind: 'failed', reason: `README has no \`${ALLOWLIST_HEADING}\` heading` }
  }

  const after = lines.slice(headingAt + 1)
  const tableAt = after.findIndex((line) => line.trimStart().startsWith('|'))
  if (tableAt === -1) {
    return { kind: 'failed', reason: `no markdown table under \`${ALLOWLIST_HEADING}\`` }
  }

  const tableLines: string[] = []
  for (const line of after.slice(tableAt)) {
    if (!line.trimStart().startsWith('|')) break
    tableLines.push(line)
  }

  const headerLine = tableLines[0]
  if (headerLine === undefined) {
    return { kind: 'failed', reason: `no markdown table under \`${ALLOWLIST_HEADING}\`` }
  }
  const header = cellsOf(headerLine).map(unquote)

  const columns = {
    method: 'Method',
    path: 'Path',
    version: 'Version',
    scope: 'Scope',
    notes: 'Notes',
  }
  const indexes: Record<keyof typeof columns, number> = {
    method: header.indexOf(columns.method),
    path: header.indexOf(columns.path),
    version: header.indexOf(columns.version),
    scope: header.indexOf(columns.scope),
    notes: header.indexOf(columns.notes),
  }
  for (const [name, index] of Object.entries(indexes)) {
    if (index === -1) {
      return { kind: 'failed', reason: `the allowlist table has no ${name} column` }
    }
  }
  const width = Math.max(...Object.values(indexes)) + 1

  const rows: ReadmeRow[] = []
  for (const [offset, line] of tableLines.slice(1).entries()) {
    const cells = cellsOf(line)
    if (isSeparator(cells)) continue
    if (cells.length < width) {
      return {
        kind: 'failed',
        reason: `allowlist row ${offset + 1} has ${cells.length} cells, expected ${width}`,
      }
    }
    rows.push({
      method: unquote(cells[indexes.method] ?? ''),
      path: unquote(cells[indexes.path] ?? ''),
      version: unquote(cells[indexes.version] ?? ''),
      scope: unquote(cells[indexes.scope] ?? ''),
      notes: cells[indexes.notes] ?? '',
    })
  }

  return { kind: 'parsed', rows }
}

function keyOfRoute(route: HlRoute): string {
  return `${route.method} ${route.pattern}`
}

/**
 * Every way the README's rendering and `table` disagree, in human-readable
 * lines. Empty means they say the same thing.
 */
export function compareAllowlist(readmeText: string, table: readonly HlRoute[]): string[] {
  const parsed = parseAllowlistTable(readmeText)
  if (parsed.kind === 'failed') return [parsed.reason]

  const differences: string[] = []
  const { rows } = parsed

  // Counted as well as keyed, so a row the README invents is a difference even
  // when every route in the table is present and correct.
  if (rows.length !== table.length) {
    differences.push(`row count: README has ${rows.length} rows, HL_ROUTES has ${table.length}`)
  }

  const byKey = new Map<string, ReadmeRow>()
  for (const row of rows) {
    const key = `${row.method} ${row.path}`
    if (byKey.has(key)) differences.push(`the README renders ${key} twice`)
    byKey.set(key, row)
  }

  for (const route of table) {
    const key = keyOfRoute(route)
    const row = byKey.get(key)
    if (row === undefined) {
      differences.push(`missing from the README: ${key}`)
      continue
    }
    if (row.version !== route.version) {
      differences.push(
        `${key}: README says version ${row.version}, HL_ROUTES says ${route.version}`,
      )
    }
    if (row.scope !== route.scope) {
      differences.push(`${key}: README says scope ${row.scope}, HL_ROUTES says ${route.scope}`)
    }
  }

  const allowed = new Set(table.map(keyOfRoute))
  for (const key of byKey.keys()) {
    if (!allowed.has(key)) differences.push(`not in HL_ROUTES: ${key}`)
  }

  // The word *disabled* in a Notes cell is a claim about the flag, so the two
  // sets are compared both ways: an unflagged row the README calls disabled is
  // as wrong as a flagged row it presents as ordinary.
  const disabledInReadme = new Set(
    [...byKey.entries()].filter(([, row]) => /disabled/i.test(row.notes)).map(([key]) => key),
  )
  const flagged = new Set(table.filter((route) => route.flag !== undefined).map(keyOfRoute))
  for (const key of disabledInReadme) {
    if (!flagged.has(key)) {
      differences.push(`README marks ${key} disabled, but HL_ROUTES gives it no flag`)
    }
  }
  for (const key of flagged) {
    if (!disabledInReadme.has(key)) {
      differences.push(`HL_ROUTES flags ${key}, but the README does not mark it disabled`)
    }
  }

  return differences
}

/**
 * A local copy of the table with one route added — the drift AC-9 names
 * explicitly ("adding a route without touching the README fails it"). Mutating
 * a copy rather than `HL_ROUTES` is the point: the real table stays the thing
 * the README is measured against.
 */
function withExtraRoute(table: readonly HlRoute[]): HlRoute[] {
  return [
    ...table,
    {
      method: 'POST',
      pattern: '/contacts/upsert',
      version: '2021-07-28',
      scope: 'contacts.write',
      locationIn: 'body',
    },
  ]
}

/** The same table with one row's `version` moved to the other pinned date. */
function withDriftedVersion(table: readonly HlRoute[], pattern: string): HlRoute[] {
  return table.map((route): HlRoute =>
    route.pattern === pattern ? { ...route, version: '2021-07-28' } : route,
  )
}

/** The same table with one row's scope widened. */
function withDriftedScope(table: readonly HlRoute[], pattern: string): HlRoute[] {
  return table.map((route): HlRoute =>
    route.pattern === pattern ? { ...route, scope: 'contacts.write' } : route,
  )
}

/** The same table with a `flag` added to a row the README presents as ordinary. */
function withExtraFlag(table: readonly HlRoute[], pattern: string): HlRoute[] {
  return table.map((route): HlRoute =>
    route.pattern === pattern ? { ...route, flag: 'HL_ALLOW_MESSAGE_SEND' } : route,
  )
}

/** The same table with every `flag` dropped — nothing is disabled any more. */
function withoutFlags(table: readonly HlRoute[]): HlRoute[] {
  return table.map((route): HlRoute => ({
    method: route.method,
    pattern: route.pattern,
    version: route.version,
    scope: route.scope,
    locationIn: route.locationIn,
  }))
}

/** The README's own table line for a path, so a fixture edits the real text. */
function rowLineFor(readmeText: string, path: string): string {
  const line = readmeText
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith('|') && candidate.includes(`\`${path}\``))
  if (line === undefined) throw new Error(`the README has no allowlist row for ${path}`)
  return line
}

function withoutReadmeRow(readmeText: string, path: string): string {
  const line = rowLineFor(readmeText, path)
  return readmeText
    .split('\n')
    .filter((candidate) => candidate !== line)
    .join('\n')
}

function withDuplicateReadmeRow(readmeText: string, path: string): string {
  const line = rowLineFor(readmeText, path)
  return readmeText
    .split('\n')
    .flatMap((candidate) => (candidate === line ? [candidate, candidate] : [candidate]))
    .join('\n')
}

function withExtraReadmeRow(readmeText: string, path: string, invented: string): string {
  const line = rowLineFor(readmeText, path)
  const extra = line.replace(`\`${path}\``, `\`${invented}\``)
  return readmeText
    .split('\n')
    .flatMap((candidate) => (candidate === line ? [candidate, extra] : [candidate]))
    .join('\n')
}

describe('compareAllowlist', () => {
  const readme = readFileSync(README, 'utf8')

  it('finds no difference between the README and HL_ROUTES', () => {
    expect(compareAllowlist(readme, HL_ROUTES)).toEqual([])
  })

  it('reports a route added to the table but not to the README', () => {
    const differences = compareAllowlist(readme, withExtraRoute(HL_ROUTES))

    expect(differences).toContainEqual(expect.stringContaining('POST /contacts/upsert'))
    expect(differences).toContainEqual(
      expect.stringContaining(`README has ${HL_ROUTES.length} rows`),
    )
  })

  it('reports a row whose Version drifts from the table', () => {
    const differences = compareAllowlist(readme, withDriftedVersion(HL_ROUTES, '/calendars/events'))

    expect(differences).toContainEqual(
      expect.stringContaining('GET /calendars/events: README says version 2021-04-15'),
    )
  })

  it('reports a row whose scope drifts from the table', () => {
    const differences = compareAllowlist(readme, withDriftedScope(HL_ROUTES, '/contacts/search'))

    expect(differences).toContainEqual(
      expect.stringContaining('POST /contacts/search: README says scope contacts.readonly'),
    )
  })

  it('reports the send row losing its flag while the README still calls it disabled', () => {
    const differences = compareAllowlist(readme, withoutFlags(HL_ROUTES))

    expect(differences).toContainEqual(
      expect.stringContaining('README marks POST /conversations/messages disabled'),
    )
  })

  it('reports a row the table flags that the README presents as ordinary', () => {
    const differences = compareAllowlist(readme, withExtraFlag(HL_ROUTES, '/contacts/'))

    expect(differences).toContainEqual(
      expect.stringContaining('HL_ROUTES flags POST /contacts/, but the README does not mark it'),
    )
  })

  it('reports a route the README renders twice', () => {
    const differences = compareAllowlist(
      withDuplicateReadmeRow(readme, '/calendars/events'),
      HL_ROUTES,
    )

    expect(differences).toContainEqual(
      expect.stringContaining('the README renders GET /calendars/events twice'),
    )
    expect(differences).toContainEqual(expect.stringContaining('README has 14 rows'))
  })

  it('reports a route the README forgot to render', () => {
    const differences = compareAllowlist(
      withoutReadmeRow(readme, '/calendars/:calendarId'),
      HL_ROUTES,
    )

    expect(differences).toContainEqual(
      expect.stringContaining('missing from the README: GET /calendars/:calendarId'),
    )
    expect(differences).toContainEqual(expect.stringContaining('README has 12 rows'))
  })

  it('reports a route the README invented', () => {
    const differences = compareAllowlist(
      withExtraReadmeRow(readme, '/calendars/events', '/calendars/nope'),
      HL_ROUTES,
    )

    expect(differences).toContainEqual(
      expect.stringContaining('not in HL_ROUTES: GET /calendars/nope'),
    )
    expect(differences).toContainEqual(expect.stringContaining('README has 14 rows'))
  })

  /*
   * The sentence above the table is prose, so `compareAllowlist` cannot see it.
   * Add a fourteenth route and the table is forced to grow — but "forwards only
   * these thirteen routes" stays, and the Loom's ninth beat says "thirteen"
   * out loud. The count is a claim about `HL_ROUTES`, so it is checked against
   * `HL_ROUTES`.
   */
  it('agrees with the prose count above the table, and with the Loom script', () => {
    const words = [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
      'eleven',
      'twelve',
      'thirteen',
      'fourteen',
      'fifteen',
    ]
    const spelled = words[HL_ROUTES.length]
    expect(spelled).toBeDefined()

    // Whitespace collapsed: the sentence wraps mid-phrase in the file.
    const prose = readme.replace(/\s+/g, ' ')
    expect(prose).toContain(`only these ${String(spelled)} routes`)

    const loom = readFileSync(
      join(__dirname, '../../../docs/slices/13-deliverables/loom-script.md'),
      'utf8',
    )
    expect(loom.toLowerCase()).toContain(`${String(spelled)} routes`)
  })

  it('fails loudly when the README has no allowlist section at all', () => {
    expect(compareAllowlist('# Genesis\n\nNo table here.\n', HL_ROUTES)).toEqual([
      'README has no `### HighLevel API allowlist` heading',
    ])
  })
})
