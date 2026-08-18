import { SNAPSHOT_LIMIT } from './schema'
import type { FileWrite, StoredFile } from '../files/schema'

/**
 * The slice's arithmetic — **pure, and deliberately kept out of the handlers.**
 *
 * Four functions, and two of them exist because the mistake they prevent is
 * invisible in a route:
 *
 * - `mergeSnapshotFiles` is R1. Snapshotting the turn's *writes* is the smaller,
 *   more obvious implementation — the writes are right there in the plan — and it
 *   passes any test that generates exactly once. It fails the first time a turn
 *   rewrites a subset, and the symptom is a restore producing an app that is
 *   missing files, which reads as a restore bug rather than a snapshot bug.
 * - `planSnapshotPrune` is an off-by-one whose two failure modes are a collection
 *   that grows forever and one that deletes a version it should have kept.
 *
 * Nothing here reads or writes Firestore, so all four are asserted against
 * literals before a single document is touched.
 */

/** One existing snapshot, as the prune read sees it: a ref's id and its number. */
export interface SnapshotHead {
  id: string
  seq: number
}

/**
 * The project's file set **as it stands after this turn** (D1, AC-1).
 *
 * Writes win, untouched files are kept, and the result is ordered by path — the
 * same order `readFileList` answers in, so a copy and the live list read the
 * same way in a console.
 *
 * A write carries its own `size`, computed by `validateFileOps` against the
 * bytes it actually measured, so the size stored beside a copied content is the
 * one that content really has rather than one recomputed here from a different
 * assumption about encoding.
 */
export function mergeSnapshotFiles(
  stored: readonly StoredFile[],
  writes: readonly FileWrite[],
): FileWrite[] {
  const merged = new Map<string, FileWrite>()

  for (const file of stored) {
    merged.set(file.path, { path: file.path, content: file.content, size: file.size })
  }
  // Second, so a rewrite replaces the stored entry rather than being dropped
  // beside it.
  for (const write of writes) {
    merged.set(write.path, { path: write.path, content: write.content, size: write.size })
  }

  return [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The next version number: the maximum plus one, or 1 for an empty collection
 * (D5, AC-2).
 *
 * **Not the count, and not the list position.** The prune removes the lowest, so
 * gaps are the normal state of a long-lived project — and a number derived from
 * position would renumber every remaining row on every prune, which means the
 * "Version 3" a user restored yesterday is a different file set today. A `seq`
 * is a name, and a name that moves is not one.
 */
export function planSnapshotSeq(heads: readonly SnapshotHead[]): number {
  return heads.reduce((highest, head) => Math.max(highest, head.seq), 0) + 1
}

/**
 * Which snapshots must go so the collection lands **at** the cap after the write
 * (D6, AC-3).
 *
 * The arithmetic is `heads.length + 1 - SNAPSHOT_LIMIT`, and the `+ 1` is the
 * whole function: it is the snapshot this plan is *for*, which does not exist
 * yet and is not in `heads`. At exactly the cap the collection is not over it —
 * it is one write away from being over it — so one goes.
 *
 * Generic over the head, so a caller that read the document *references* along
 * with the numbers gets them back rather than having to look each one up again
 * by id — which is what the prune needs, since it deletes what it selects.
 *
 * It selects by `seq` rather than by position so an already-broken invariant
 * repairs itself: 22 heads prune three and land at 20, rather than pruning one
 * and staying broken by two forever. That case is reachable — a crash between a
 * commit and a prune, or a limit that was once higher — and a prune that could
 * only ever remove one would never recover from it.
 */
export function planSnapshotPrune<T extends SnapshotHead>(heads: readonly T[]): T[] {
  const excess = heads.length + 1 - SNAPSHOT_LIMIT
  if (excess <= 0) return []

  return [...heads].sort((a, b) => a.seq - b.seq).slice(0, excess)
}

/**
 * Same paths, byte-identical contents (D10, AC-4).
 *
 * What the no-op restore rests on: restoring the version a project already *is*
 * must write nothing at all, because writing would advance every file's
 * `updatedAt` and mint a safety snapshot of a state nothing changed. So this is
 * the question "would the restore do anything?", answered before a batch is
 * opened.
 *
 * `size` is deliberately **not** compared. It is derived from `content` by both
 * writers, so comparing it would either be redundant or would let a stale count
 * make two identical file sets look different — and the bytes are what a restore
 * would actually put back.
 *
 * Order-independent, because the two sides come from two reads that need not
 * agree on ordering, and "the same set" is the claim being made.
 */
export function filesEqual(a: readonly FileWrite[], b: readonly FileWrite[]): boolean {
  if (a.length !== b.length) return false

  const byPath = new Map(a.map((file) => [file.path, file.content]))

  return b.every((file) => byPath.get(file.path) === file.content)
}
