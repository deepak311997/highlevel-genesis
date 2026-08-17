import type { DocumentReference } from 'firebase-admin/firestore'

import type { FileWrite } from '../files/schema'
import type { SnapshotOrigin } from './schema'

/**
 * A project's version history — the reads, the staging, and the two routes.
 *
 * The uid is the one `withVerifiedUser` read off the ID token and every path is
 * built from it, so another user's history is not addressable by a request
 * rather than merely refused. `readProject` is called first on every route here,
 * so "this project is gone" means exactly what it means in `/api/projects*`:
 * absent, soft-deleted and unreadable all collapse into one 404 (D14).
 */

/** One snapshot to remove, and the file documents that would otherwise outlive it. */
export interface PrunedSnapshot {
  ref: DocumentReference
  /**
   * Deleted **explicitly**, because deleting a document in Firestore does not
   * delete its subcollections (R4). A prune that removed only the parent would
   * leave up to twenty orphaned file documents per pruned version, unreachable
   * from any query this codebase makes and paid for forever.
   */
  fileRefs: DocumentReference[]
}

/**
 * Everything a snapshot needs in order to be *staged* — decided by reads, before
 * any write is opened.
 *
 * The split is D4's: every read happens in `planSnapshot`, and `stageSnapshot`
 * then puts the result onto a batch somebody else owns and commits. That is what
 * lets the snapshot ride on the turn's own batch rather than on a second commit
 * after it, and it is why `stageSnapshot` needs no `getDb()` at all — the plan
 * carries the references.
 */
export interface SnapshotPlan {
  /** Minted locally by `planSnapshot`; nothing is read to get it. */
  ref: DocumentReference
  seq: number
  origin: SnapshotOrigin
  files: FileWrite[]
  prune: PrunedSnapshot[]
}
