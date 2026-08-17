import type { Request, Response } from 'express'
import type { DocumentReference, DocumentSnapshot, WriteBatch } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'

import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import { notFound, readProject, requireProjectId } from '../projects/handlers'
import type { FileWrite } from '../files/schema'
import { planSnapshotPrune, planSnapshotSeq, type SnapshotHead } from './plan'
import {
  SNAPSHOT_FILES,
  SNAPSHOT_LIMIT,
  snapshotsPath,
  storedSnapshotFileSchema,
  storedSnapshotSchema,
  toSnapshotMeta,
  type SnapshotMeta,
  type SnapshotOrigin,
  type StoredSnapshotFile,
} from './schema'

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

/**
 * Parse one copied file, or `null` when it cannot describe one.
 *
 * Two ways to fail, and the second is the collection's own (AC-5): the schema
 * says what a copied file is made of; the **`id === path` check** says the
 * document is about the file it is filed under. A copy where the two disagree
 * cannot be written back to the right filename, so it is *known* to be unusable
 * — and a restore that meets one refuses the **whole version** rather than
 * restoring a file under the wrong name.
 *
 * Fail closed and say so in the log: the precedent runs through `parseStored`,
 * `parseStoredMessage` and `parseStoredFile`. **No field of the document goes in
 * it** — a copied file is the user's own application, one version back.
 */
export function parseSnapshotFile(snapshot: DocumentSnapshot): StoredSnapshotFile | null {
  // An absent document is not corruption, so it is not logged as such.
  if (!snapshot.exists) return null

  const parsed = storedSnapshotFileSchema.safeParse(snapshot.data())
  if (!parsed.success) {
    logAuthEvent('snapshot.unreadable', { outcome: 'invalid' })
    return null
  }

  if (parsed.data.path !== snapshot.id) {
    logAuthEvent('snapshot.unreadable', { outcome: 'invalid', detail: 'id mismatch' })
    return null
  }

  return parsed.data
}

/**
 * Every existing version's id and number — **uncapped, and projected to one
 * field** (P3).
 *
 * No `limit()`, deliberately. `planSnapshotPrune` has to be able to see an
 * already-broken invariant — 22 heads must prune three, not one — and a capped
 * read would hide exactly the rows that say so. The collection is bounded to
 * roughly `SNAPSHOT_LIMIT` by the prune itself, and `select('seq')` asks for
 * references and one number rather than for twenty documents, so this is
 * `liveProjectCount` and `messageCount`'s shape with a field attached.
 *
 * A document whose `seq` is missing or not a number is read as `0`, which sorts
 * it to the front of the prune: a head nothing can name is a version nothing can
 * restore, so removing it first is the right outcome rather than a lost one.
 */
async function readSnapshotHeads(
  uid: string,
  projectId: string,
): Promise<(SnapshotHead & { ref: DocumentReference })[]> {
  const snapshot = await getDb()
    .collection(snapshotsPath(uid, projectId))
    .orderBy('seq', 'asc')
    .select('seq')
    .get()

  return snapshot.docs.map((doc) => {
    const seq: unknown = doc.get('seq')
    return { id: doc.id, seq: typeof seq === 'number' ? seq : 0, ref: doc.ref }
  })
}

/**
 * Every read a snapshot needs, and nothing else. **Nothing is written and
 * nothing is staged** (D4).
 *
 * One read for the heads, plus one `listDocuments()` per pruned version — which
 * is zero on all but one turn in twenty, and returns references without reading
 * a byte of the documents behind them.
 *
 * The new snapshot's reference is minted locally from an auto-id, so nothing is
 * read to get it; that is what lets `stageSnapshot` be pure staging.
 */
export async function planSnapshot(
  uid: string,
  projectId: string,
  files: readonly FileWrite[],
  origin: SnapshotOrigin,
): Promise<SnapshotPlan> {
  const heads = await readSnapshotHeads(uid, projectId)

  const prune = await Promise.all(
    planSnapshotPrune(heads).map(async (head) => ({
      ref: head.ref,
      fileRefs: await head.ref.collection(SNAPSHOT_FILES).listDocuments(),
    })),
  )

  return {
    // Auto-id, minted locally: nothing is read to get it.
    ref: getDb().collection(snapshotsPath(uid, projectId)).doc(),
    seq: planSnapshotSeq(heads),
    origin,
    files: [...files],
    prune,
  }
}

/**
 * Put the whole snapshot onto a batch. **Nothing is committed here** (D4).
 *
 * The commit belongs to whoever owns the batch — `appendAssistantMessage` for a
 * generation, `handleRestoreSnapshot` for a restore — which is R5: writing the
 * snapshot in a commit of its own after the turn's is one line shorter and
 * leaves a crash window in which the project's files moved and its history did
 * not.
 *
 * **It takes no `getDb()`** (P4). The plan carries the new snapshot's reference
 * and every pruned reference, and `DocumentReference.collection()` reaches the
 * copies — so this function is pure staging, and AC-9's test is a batch fake
 * rather than a whole Firestore fake.
 *
 * The worst case is 63 writes on the turn's batch: one message, twenty files,
 * one snapshot, twenty copies, one pruned snapshot and its twenty copies. That
 * is comfortably inside Firestore's limit of 500.
 *
 * **The pruned version's file documents are deleted explicitly** (R4). Deleting
 * a document in Firestore does not delete its subcollections, so a prune that
 * removed only the parent would leave up to twenty orphaned documents per
 * pruned version — unreachable from any query this codebase makes, and paid for
 * forever.
 */
export function stageSnapshot(batch: WriteBatch, plan: SnapshotPlan): void {
  batch.set(plan.ref, {
    seq: plan.seq,
    createdAt: FieldValue.serverTimestamp(),
    origin: plan.origin,
    fileCount: plan.files.length,
    // Summed from the files' own `size`, which is the number the validator
    // measured against the byte cap rather than one recomputed here.
    totalBytes: plan.files.reduce((total, file) => total + file.size, 0),
  })

  const copies = plan.ref.collection(SNAPSHOT_FILES)
  for (const file of plan.files) {
    // The id *is* the path, so a copy cannot hold two documents claiming one
    // filename — the live collection's rule (D13), one level down.
    batch.set(copies.doc(file.path), { path: file.path, content: file.content, size: file.size })
  }

  for (const pruned of plan.prune) {
    for (const fileRef of pruned.fileRefs) batch.delete(fileRef)
    batch.delete(pruned.ref)
  }
}

/**
 * The version list — newest first, capped, **metadata only**.
 *
 * Newest first because a version list is read from the top: the version a user
 * wants back is nearly always the one they just left. The cap matches
 * `SNAPSHOT_LIMIT`, which is also the prune's cap, so "you are seeing every
 * version" is a guarantee rather than a hope — `LIST_LIMIT` / `MESSAGE_LIMIT` /
 * `FILE_LIMIT`'s rule.
 *
 * `orderBy('seq','desc')` on a single field is served by Firestore's automatic
 * index (D16, D30), so this adds nothing to `firestore.indexes.json` — stated
 * because Slices 3 and 4 both paid for a missing composite index and the
 * emulator does not enforce them.
 *
 * A document that will not parse is omitted and logged, exactly as a corrupt
 * file is: from outside, a version nobody can read is indistinguishable from one
 * that was never taken, and the log line is the only warning anybody gets.
 */
export async function readSnapshotList(uid: string, projectId: string): Promise<SnapshotMeta[]> {
  const snapshot = await getDb()
    .collection(snapshotsPath(uid, projectId))
    .orderBy('seq', 'desc')
    .limit(SNAPSHOT_LIMIT)
    .get()

  return snapshot.docs
    .map((doc) => {
      const parsed = storedSnapshotSchema.safeParse(doc.data())
      if (!parsed.success) {
        logAuthEvent('snapshot.unreadable', { outcome: 'invalid' })
        return null
      }
      return toSnapshotMeta(doc.id, parsed.data)
    })
    .filter((meta): meta is SnapshotMeta => meta !== null)
}

/**
 * A project's version history — or the 404 the project earns.
 *
 * The id, then the project, and the project's answer is the whole of "gone"
 * (D14): absent, soft-deleted, unreadable and somebody else's collapse into one
 * response. A history is not addressable without a project, so there is nothing
 * to read past this — and the path is composed from the token's uid, so another
 * user's versions are not addressable by a request rather than merely refused.
 */
export async function handleListSnapshots(
  req: Request,
  res: Response,
  uid: string,
): Promise<void> {
  const projectId = requireProjectId(req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  res.json({ snapshots: await readSnapshotList(uid, projectId) })
}
