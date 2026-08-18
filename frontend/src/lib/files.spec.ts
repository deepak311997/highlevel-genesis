import { describe, expect, it } from 'vitest'

import { compareFilePaths, formatBytes, mergeFileTree, utf8Bytes, type FileRow } from './files'
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
  /**
   * `index.html` first, and everything else alphabetical.
   *
   * The entry point is the file a user opens to understand the app (D1), so it is
   * the row the eye should land on. Alphabetical after it, because any other
   * order — creation time, size — makes a list that reorders itself between
   * generations for reasons nobody can see.
   */
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
  /**
   * The union of what is stored and what is streaming, streaming ones marked.
   *
   * A path that is streaming *and* stored appears once (D8's visible consequence
   * runs the other way: an invalid path shows while it streams and is gone at the
   * refetch, and this is what stops a rewrite from showing twice in between).
   */
  it('returns the union, in the comparator’s order', () => {
    const rows = mergeFileTree([meta('styles.css'), meta('index.html')], ['app.js'])

    expect(rows.map((row) => row.path)).toEqual(['index.html', 'app.js', 'styles.css'])
  })

  it('marks the streaming paths and no others', () => {
    const rows = mergeFileTree([meta('index.html')], ['app.js'])

    expect(rows).toEqual<FileRow[]>([
      { path: 'index.html', writing: false },
      { path: 'app.js', writing: true },
    ])
  })

  it('shows a path that is both stored and streaming exactly once, marked', () => {
    const rows = mergeFileTree([meta('index.html'), meta('app.js')], ['index.html'])

    expect(rows).toEqual<FileRow[]>([
      { path: 'index.html', writing: true },
      { path: 'app.js', writing: false },
    ])
  })

  it('handles both sides being empty', () => {
    expect(mergeFileTree([], [])).toEqual([])
  })

  it('handles a first generation, where nothing is stored yet', () => {
    expect(mergeFileTree([], ['index.html', 'app.js'])).toEqual<FileRow[]>([
      { path: 'index.html', writing: true },
      { path: 'app.js', writing: true },
    ])
  })

  /* A path streamed twice in one turn is still one row. */
  it('deduplicates repeated streaming paths', () => {
    expect(mergeFileTree([], ['app.js', 'app.js'])).toHaveLength(1)
  })
})

describe('utf8Bytes', () => {
  /*
   * The cap is bytes, because a Firestore document limit is bytes — so a byte
   * count is what the editor has to show and what **Save** has to key off. A
   * `.length` here would let a file of 60,000 three-byte characters look like it
   * fitted and be refused by the server at 180,000.
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
  /**
   * Decimal KB, because that is already this codebase's unit (P7).
   *
   * `fileErrorCopy` on the server renders the cap as `FILE_BYTES_MAX / 1000` —
   * "100 KB" for 100,000 bytes. A binary KiB here would make a file the editor
   * calls "98 KB" be refused by a server that calls the same limit "100 KB",
   * and the user would have no way to tell which of the two numbers was lying.
   */
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
   * The rounding floor. `Math.round(1400 / 1000)` is 1, but
   * `Math.round(1499 / 1000)` is also 1 and `Math.round(1000 / 1000)` is 1 —
   * the trap is the half that rounds *down* past it. A file over a kilobyte
   * must never be described as "0 KB", which is what a bare `Math.round` says
   * for anything under 500 bytes and what a naive `< 1024` boundary would say
   * for 1000–1023.
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
