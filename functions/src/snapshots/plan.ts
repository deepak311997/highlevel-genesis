import { SNAPSHOT_LIMIT } from './schema'
import type { FileWrite, StoredFile } from '../files/schema'

/**
 * The slice's arithmetic — **pure, and deliberately kept out of the handlers.**
 *
 * Two of these exist because the mistake they prevent is invisible in a route.
 * Snapshotting the turn's *writes* rather than merging is smaller, more obvious,
 * and passes any test that generates exactly once — it fails the first time a turn
 * rewrites a subset, and the symptom is a restore producing an app missing files,
 * which reads as a restore bug. And the prune is an off-by-one whose two failure
 * modes are a collection that grows forever and one that deletes a version it
 * should have kept.
 */

/** One existing snapshot, as the prune read sees it: a ref's id and its number. */
export interface SnapshotHead {
  id: string
  seq: number
}

/**
 * The project's file set **as it stands after this turn**: writes win, untouched
 * files are kept, ordered by path so a copy and the live list read the same way.
 *
 * A write carries its own `size`, measured by the validator against the bytes it
 * actually saw, rather than one recomputed here under a different assumption.
 */
export function mergeSnapshotFiles(
  stored: readonly StoredFile[],
  writes: readonly FileWrite[],
): FileWrite[] {
  const merged = new Map<string, FileWrite>()

  for (const file of stored) {
    merged.set(file.path, { path: file.path, content: file.content, size: file.size })
  }
  // Second, so a rewrite replaces the stored entry rather than sitting beside it.
  for (const write of writes) {
    merged.set(write.path, { path: write.path, content: write.content, size: write.size })
  }

  return [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The next version number: the maximum plus one, or 1 for an empty collection.
 *
 * **Not the count, and not the list position.** The prune removes the lowest, so
 * gaps are the normal state — and a number derived from position would renumber
 * every row on every prune, which means the "Version 3" a user restored yesterday
 * is a different file set today. A `seq` is a name, and a name that moves is not one.
 */
export function planSnapshotSeq(heads: readonly SnapshotHead[]): number {
  return heads.reduce((highest, head) => Math.max(highest, head.seq), 0) + 1
}

/**
 * Which snapshots must go so the collection lands **at** the cap after the write.
 *
 * The `+ 1` is the whole function: it is the snapshot this plan is *for*, which
 * does not exist yet. At exactly the cap the collection is one write away from
 * being over it, so one goes.
 *
 * It selects by `seq` rather than by position, so an already-broken invariant
 * repairs itself — 22 heads prune three and land at 20 rather than pruning one and
 * staying broken forever. That case is reachable: a crash between a commit and a
 * prune, or a limit that was once higher.
 */
export function planSnapshotPrune<T extends SnapshotHead>(heads: readonly T[]): T[] {
  const excess = heads.length + 1 - SNAPSHOT_LIMIT
  if (excess <= 0) return []

  return [...heads].sort((a, b) => a.seq - b.seq).slice(0, excess)
}

/**
 * Same paths, byte-identical contents — the question "would the restore do
 * anything?", answered before a batch is opened, because restoring the version a
 * project already *is* must write nothing at all.
 *
 * `size` is deliberately not compared: it is derived from `content` by both
 * writers, so comparing it would either be redundant or let a stale count make two
 * identical file sets look different. Order-independent, because the two sides
 * come from two reads that need not agree on ordering.
 */
export function filesEqual(a: readonly FileWrite[], b: readonly FileWrite[]): boolean {
  if (a.length !== b.length) return false

  const byPath = new Map(a.map((file) => [file.path, file.content]))

  return b.every((file) => byPath.get(file.path) === file.content)
}
