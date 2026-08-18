import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import type { StoredFile } from '../files/schema'
import { SNAPSHOT_LIMIT } from './schema'
import {
  filesEqual,
  mergeSnapshotFiles,
  planSnapshotPrune,
  planSnapshotSeq,
  type SnapshotHead,
} from './plan'

/**
 * AC-1 – AC-4 — the whole of the slice's arithmetic, with no Firestore anywhere near it.
 *
 * These four functions are where the slice's two most expensive mistakes live (R1 and the
 * prune's off-by-one), and both of them are invisible in a route: snapshotting the turn's
 * *writes* instead of the project's resulting set passes every test that generates exactly once,
 * and a prune that is one out leaves the collection at 21 forever. So they are pure, and they
 * are asserted here before anything reads a document.
 */

const file = (path: string, content: string): { path: string; content: string; size: number } => ({
  path,
  content,
  size: Buffer.byteLength(content, 'utf8'),
})

/**
 * The same file as a **stored document**, which is what the merge's first argument really is.
 *
 * The two timestamps are the point of the helper existing beside `file`: the merge never reads
 * them, and the copy it produces deliberately does not carry them (the snapshot's own
 * `createdAt` is the one time that means anything about a copy). Passing the real input type is
 * what proves that rather than assuming it.
 */
const storedFile = (path: string, content: string): StoredFile => ({
  ...file(path, content),
  createdAt: Timestamp.fromMillis(1_700_000_000_000),
  updatedAt: Timestamp.fromMillis(1_700_000_100_000),
})

const heads = (...seqs: number[]): SnapshotHead[] =>
  seqs.map((seq) => ({ id: `snap-${String(seq)}`, seq }))

/** AC-1. The copy is of the project's **resulting** set, not of the turn's writes. */
describe('mergeSnapshotFiles', () => {
  it('takes the write for a path the project already holds, and its size with it', () => {
    const merged = mergeSnapshotFiles(
      [storedFile('a.js', 'old'), storedFile('index.html', '<p>one</p>')],
      [file('index.html', '<p>two, which is longer</p>')],
    )

    const rewritten = merged.find((entry) => entry.path === 'index.html')
    expect(rewritten?.content).toBe('<p>two, which is longer</p>')
    expect(rewritten?.size).toBe(Buffer.byteLength('<p>two, which is longer</p>', 'utf8'))
  })

  /*
   * R1, stated as a test. The untouched file being in the copy is the whole
   * difference between a snapshot and a changelog: without it, restoring
   * version 1 of a three-file app produces an app of one file.
   */
  it('keeps a file the turn did not touch, byte for byte', () => {
    const merged = mergeSnapshotFiles(
      [storedFile('a.js', 'untouched'), storedFile('index.html', '<p>one</p>')],
      [file('index.html', '<p>two</p>'), file('about.html', '<p>new</p>')],
    )

    expect(merged.find((entry) => entry.path === 'a.js')).toEqual(file('a.js', 'untouched'))
  })

  it('holds one entry per path — three, for two stored and two written', () => {
    const merged = mergeSnapshotFiles(
      [storedFile('a.js', 'old'), storedFile('index.html', '<p>one</p>')],
      [file('index.html', '<p>two</p>'), file('about.html', '<p>new</p>')],
    )

    expect(merged.map((entry) => entry.path)).toEqual(['a.js', 'about.html', 'index.html'])
  })

  it('orders by path, whatever order the two inputs arrived in', () => {
    const merged = mergeSnapshotFiles(
      [storedFile('styles.css', 'body{}'), storedFile('app.js', 'let x')],
      [file('index.html', '<p>hi</p>')],
    )

    expect(merged.map((entry) => entry.path)).toEqual(['app.js', 'index.html', 'styles.css'])
  })

  it('is exactly the writes, ordered, for an empty project', () => {
    const writes = [file('index.html', '<p>hi</p>'), file('app.js', 'let x')]

    expect(mergeSnapshotFiles([], writes)).toEqual([
      file('app.js', 'let x'),
      file('index.html', '<p>hi</p>'),
    ])
  })
})

/** AC-2. */
describe('planSnapshotSeq', () => {
  it('numbers the first version 1', () => {
    expect(planSnapshotSeq([])).toBe(1)
  })

  it('is the maximum plus one', () => {
    expect(planSnapshotSeq(heads(1, 2, 7))).toBe(8)
  })

  /*
   * D5. The prune removes the lowest, so gaps are the normal state of a
   * long-lived project — and a version number that reused a pruned one would
   * name two different file sets over a project's life.
   */
  it('does not close a gap the prune left', () => {
    expect(planSnapshotSeq(heads(1, 4, 7))).toBe(8)
  })

  it('reads the maximum rather than the last element', () => {
    expect(planSnapshotSeq(heads(7, 2, 4))).toBe(8)
  })
})

/** AC-3. */
describe('planSnapshotPrune', () => {
  it('prunes nothing while the collection is under the cap', () => {
    expect(planSnapshotPrune(heads(...range(1, SNAPSHOT_LIMIT - 1)))).toEqual([])
  })

  /*
   * The `+ 1` is the whole function. At exactly the cap the collection is not over it — it is
   * one write away from being over it, and that write is the one this plan is for.
   */
  it('prunes the single lowest at exactly the cap, so the write lands at the cap', () => {
    const pruned = planSnapshotPrune(heads(...range(1, SNAPSHOT_LIMIT)))

    expect(pruned.map((head) => head.seq)).toEqual([1])
  })

  it('prunes the three lowest when the invariant is already broken by two', () => {
    const pruned = planSnapshotPrune(heads(...range(1, SNAPSHOT_LIMIT + 2)))

    expect(pruned.map((head) => head.seq)).toEqual([1, 2, 3])
    // The point of pruning three rather than one: the collection lands *at* the
    // cap after the write, rather than staying broken by two forever.
    expect(SNAPSHOT_LIMIT + 2 - pruned.length + 1).toBe(SNAPSHOT_LIMIT)
  })

  it('selects by seq rather than by position', () => {
    const pruned = planSnapshotPrune(heads(...range(1, SNAPSHOT_LIMIT).reverse()))

    expect(pruned.map((head) => head.seq)).toEqual([1])
  })

  it('carries the id, because the id is what the batch deletes', () => {
    const pruned = planSnapshotPrune(heads(...range(1, SNAPSHOT_LIMIT)))

    expect(pruned[0]).toEqual({ id: 'snap-1', seq: 1 })
  })
})

/** AC-4. D10's no-op restore rests entirely on this. */
describe('filesEqual', () => {
  const set = [file('a.js', 'let x'), file('index.html', '<p>hi</p>')]

  it('is true for the same paths and byte-identical contents', () => {
    expect(filesEqual(set, [file('a.js', 'let x'), file('index.html', '<p>hi</p>')])).toBe(true)
  })

  it('is true whatever order the two arrived in', () => {
    expect(filesEqual(set, [file('index.html', '<p>hi</p>'), file('a.js', 'let x')])).toBe(true)
  })

  it('is false for one differing byte', () => {
    expect(filesEqual(set, [file('a.js', 'let y'), file('index.html', '<p>hi</p>')])).toBe(false)
  })

  it('is false for one extra path', () => {
    expect(filesEqual(set, [...set, file('about.html', '')])).toBe(false)
  })

  it('is false for one missing path', () => {
    expect(filesEqual(set, [file('a.js', 'let x')])).toBe(false)
  })

  it('is true for two empty sets, which is what an empty project compares as', () => {
    expect(filesEqual([], [])).toBe(true)
  })
})

/** `[from … to]` inclusive — the seq values a collection of that size holds. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => from + index)
}
