import { describe, expect, it } from 'vitest'

import {
  compareFilePaths,
  fileKind,
  formatBytes,
  groupFileTree,
  mergeFileTree,
  utf8Bytes,
  type FileRow,
} from './files'
import type { FileMeta } from './filesApi'

/**
 * The tree's pure parts (AC-44's and AC-45's L1 halves, D24).
 *
 * The store is one store rather than two, and the size cost of that is paid down
 * by keeping the sort, the merge and the byte count here with their own tests —
 * so the component only has to reflect a decision, never make one.
 */

const meta = (path: string): FileMeta => ({
  path,
  size: 1,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
})

describe('compareFilePaths', () => {
  /** `index.html` first, and everything else alphabetical. */
  it('puts index.html first whatever the alphabet says', () => {
    expect(['styles.css', 'index.html', 'app.js'].sort(compareFilePaths)).toEqual([
      'index.html',
      'app.js',
      'styles.css',
    ])
  })

  it('sorts the rest alphabetically', () => {
    expect(['z.js', 'b.css', 'a.md'].sort(compareFilePaths)).toEqual(['a.md', 'b.css', 'z.js'])
  })

  it('is stable when index.html is absent', () => {
    expect(['b.js', 'a.js'].sort(compareFilePaths)).toEqual(['a.js', 'b.js'])
  })

  /* Only the exact entry point, not anything that merely starts with it. */
  it('does not privilege index.html.md', () => {
    expect(['index.html.md', 'a.js', 'index.html'].sort(compareFilePaths)).toEqual([
      'index.html',
      'a.js',
      'index.html.md',
    ])
  })
})

describe('mergeFileTree', () => {
  /** The union of what is stored and what is streaming, streaming ones marked. */
  it('returns the union, in the comparator’s order', () => {
    const rows = mergeFileTree([meta('styles.css'), meta('index.html')], { 'app.js': 'creating' })

    expect(rows.map((row) => row.path)).toEqual(['index.html', 'app.js', 'styles.css'])
  })

  it('marks the streaming paths and no others', () => {
    const rows = mergeFileTree([meta('index.html')], { 'app.js': 'creating' })

    expect(rows).toEqual<FileRow[]>([
      { path: 'index.html', state: 'idle' },
      { path: 'app.js', state: 'creating' },
    ])
  })

  it('shows a path that is both stored and streaming exactly once, marked', () => {
    const rows = mergeFileTree([meta('index.html'), meta('app.js')], { 'index.html': 'rewriting' })

    expect(rows).toEqual<FileRow[]>([
      { path: 'index.html', state: 'rewriting' },
      { path: 'app.js', state: 'idle' },
    ])
  })

  it('carries each of the three streaming states through', () => {
    const rows = mergeFileTree([], {
      'index.html': 'creating',
      'app.js': 'rewriting',
      'styles.css': 'editing',
    })

    expect(rows.map((row) => [row.path, row.state])).toEqual([
      ['index.html', 'creating'],
      ['app.js', 'rewriting'],
      ['styles.css', 'editing'],
    ])
  })

  it('handles both sides being empty', () => {
    expect(mergeFileTree([], {})).toEqual([])
  })

  it('handles a first generation, where nothing is stored yet', () => {
    expect(
      mergeFileTree([], { 'index.html': 'creating', 'app.js': 'creating' }),
    ).toEqual<FileRow[]>([
      { path: 'index.html', state: 'creating' },
      { path: 'app.js', state: 'creating' },
    ])
  })

  /* A path changed twice in one turn is still one row. */
  it('shows a path changed more than once as one row', () => {
    expect(mergeFileTree([], { 'app.js': 'editing' })).toHaveLength(1)
  })
})

describe('utf8Bytes', () => {
  /*
   * The cap is bytes, because a Firestore document limit is bytes — so a byte count is what the
   * editor has to show and what **Save** has to key off.
   */
  it('counts bytes and not characters', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('日本語だ')).toBe(12)
    expect(utf8Bytes('')).toBe(0)
  })

  it('counts an emoji as its four bytes', () => {
    expect(utf8Bytes('🙂')).toBe(4)
  })

  it('agrees with the server on a mixed string', () => {
    const text = 'const greeting = "こんにちは 🙂"\n'

    expect(utf8Bytes(text)).toBe(new TextEncoder().encode(text).length)
  })
})

describe('formatBytes', () => {
  /** Decimal KB, because that is already this codebase's unit. */
  it('counts bytes below a kilobyte in bytes', () => {
    expect(formatBytes(0)).toBe('0 bytes')
    expect(formatBytes(512)).toBe('512 bytes')
    expect(formatBytes(999)).toBe('999 bytes')
  })

  it('switches to decimal KB at a thousand', () => {
    expect(formatBytes(1000)).toBe('1 KB')
    expect(formatBytes(14_022)).toBe('14 KB')
    expect(formatBytes(100_000)).toBe('100 KB')
  })

  /**
   * The rounding floor. `Math.round(1400 / 1000)` is 1, but `Math.round(1499 / 1000)` is also 1
   * and `Math.round(1000 / 1000)` is 1 — the trap is the half that rounds *down* past it.
   */
  it('never rounds a file that exceeds a kilobyte down to zero', () => {
    expect(formatBytes(1000)).toBe('1 KB')
    expect(formatBytes(1200)).toBe('1 KB')
    expect(formatBytes(1499)).toBe('1 KB')
  })

  it('rounds to the nearest kilobyte above the floor', () => {
    expect(formatBytes(1500)).toBe('2 KB')
    expect(formatBytes(11_240)).toBe('11 KB')
  })
})

describe('fileKind', () => {
  /** The extension is the only thing a flat filename can be sorted *by*. */
  it('names the kind of every extension the server allows', () => {
    expect(fileKind('index.html')).toBe('markup')
    expect(fileKind('styles.css')).toBe('style')
    expect(fileKind('app.js')).toBe('script')
    expect(fileKind('data.json')).toBe('data')
    expect(fileKind('readme.md')).toBe('doc')
  })

  /*
   * Case is not part of an extension, and a path the allowlist never sees still
   * has to render — `other` is a row with a generic icon rather than a throw.
   */
  it('falls back to other for anything unmapped, and ignores case', () => {
    expect(fileKind('INDEX.HTML')).toBe('markup')
    expect(fileKind('app.ts')).toBe('other')
    expect(fileKind('noextension')).toBe('other')
  })
})

describe('groupFileTree', () => {
  const row = (path: string): FileRow => ({ path, state: 'idle' })

  /** The groups come out in a fixed order and the rows keep the tree's. */
  it('groups by kind in a fixed order, preserving the row order inside each', () => {
    const groups = groupFileTree([
      row('readme.md'),
      row('styles.css'),
      row('index.html'),
      row('app.js'),
      row('theme.css'),
    ])

    expect(groups.map((group) => group.kind)).toEqual(['markup', 'style', 'script', 'doc'])
    expect(groups.map((group) => group.label)).toEqual(['Markup', 'Styles', 'Scripts', 'Notes'])
    expect(groups[1]?.rows.map((entry) => entry.path)).toEqual(['styles.css', 'theme.css'])
  })

  /* An empty group is a header naming nothing — a project with no JSON should
     not be told it has a Data section. */
  it('omits the kinds this project has no files of', () => {
    expect(groupFileTree([row('index.html')]).map((group) => group.kind)).toEqual(['markup'])
    expect(groupFileTree([])).toEqual([])
  })

  /* Unmapped extensions land in one group at the end rather than vanishing. */
  it('collects anything unmapped into a final Other group', () => {
    const groups = groupFileTree([row('app.ts'), row('index.html')])

    expect(groups.map((group) => group.kind)).toEqual(['markup', 'other'])
    expect(groups[1]?.rows.map((entry) => entry.path)).toEqual(['app.ts'])
  })

  /* The marker has to survive the grouping, or a streaming file loses the one
     thing that says its bytes are not stored yet. */
  it('carries the streaming state through untouched', () => {
    const groups = groupFileTree([{ path: 'app.js', state: 'editing' }])

    expect(groups[0]?.rows[0]).toEqual({ path: 'app.js', state: 'editing' })
  })
})
