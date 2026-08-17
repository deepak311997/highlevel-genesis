import { describe, expect, it } from 'vitest'

import { compareFilePaths, mergeFileTree, utf8Bytes, type FileRow } from './files'
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
