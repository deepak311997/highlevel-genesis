import type { Request, Response } from 'express'
import type { DocumentReference, DocumentSnapshot, WriteBatch } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { z } from 'zod'

import { HttpError } from '../lib/errors'
import { getDb } from '../lib/firebase'
import { describeError, logAuthEvent } from '../lib/log'
import { parseBody } from '../lib/parse'
import { notFound, readProject, requireProjectId } from '../projects/handlers'
import { readFileList, readStoredFiles, stageFileWrites } from '../files/handlers'
import { filesPath, toFileMeta, type FileWrite } from '../files/schema'
import { filesEqual, planSnapshotPrune, planSnapshotSeq, type SnapshotHead } from './plan'
import {
  SNAPSHOT_FILES,
  SNAPSHOT_LIMIT,
  RESTORE_FAILED,
  SNAPSHOT_MISSING,
  SNAPSHOT_UNREADABLE,
  snapshotFilesPath,
  snapshotIdSchema,
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
 * Every path is built from the token's uid, so another user's history is not
 * addressable rather than merely refused, and `readProject` runs first on every
 * route: absent, soft-deleted and unreadable collapse into one 404.
 */

/** One snapshot to remove, and the file documents that would otherwise outlive it. */
export interface PrunedSnapshot {
  ref: DocumentReference
  /**
   * Deleted **explicitly**: deleting a document in Firestore does not delete its
   * subcollections, so a prune that removed only the parent would leave up to
   * twenty orphaned documents per version, unreachable and paid for forever.
   */
  fileRefs: DocumentReference[]
}

/**
 * Everything a snapshot needs in order to be staged, decided by reads first.
 *
 * Every read happens in `planSnapshot`; `stageSnapshot` puts the result on a
 * batch somebody else owns and commits. That is what lets a snapshot ride on the
 * turn's own batch, and why staging needs no `getDb()` — the plan carries the
 * references.
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
 * Two ways to fail: the schema, and the `id === path` check. A copy where the
 * two disagree cannot be written back to the right filename, and a restore that
 * meets one refuses the **whole version** rather than restoring under the wrong
 * name. Nothing from the document reaches the log — it is the user's own app.
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
 * Every version's id and number — **uncapped, unordered, projected to one field**.
 *
 * No `limit()`: the prune has to see an already-broken invariant (22 heads must
 * prune three, not one), and a capped read would hide the rows that say so.
 *
 * No `orderBy('seq')` either, which is the same rule the other way round:
 * Firestore omits a document that lacks the ordered field, so a head with no
 * `seq` would be invisible here *and* to the list — never counted, never pruned,
 * its file documents paid for forever. A missing `seq` reads as `0` instead,
 * which sorts it to the front of the prune. Neither consumer needs the order.
 */
async function readSnapshotHeads(
  uid: string,
  projectId: string,
): Promise<(SnapshotHead & { ref: DocumentReference })[]> {
  const snapshot = await getDb().collection(snapshotsPath(uid, projectId)).select('seq').get()

  return snapshot.docs.map((doc) => {
    const seq: unknown = doc.get('seq')
    return { id: doc.id, seq: typeof seq === 'number' ? seq : 0, ref: doc.ref }
  })
}

/**
 * Every read a snapshot needs, and nothing else — nothing is written or staged.
 *
 * One read for the heads, plus one `listDocuments()` per pruned version, which
 * is zero on all but one turn in twenty and returns references rather than
 * documents.
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
 * Put the whole snapshot onto a batch. **Nothing is committed here.**
 *
 * The commit belongs to whoever owns the batch, so the snapshot rides on the
 * turn's: a commit of its own leaves a crash window where the project's files
 * moved and its history did not. Worst case is 63 writes — a message, twenty
 * files, a snapshot, twenty copies, and one pruned version's 21 — inside
 * Firestore's limit of 500.
 */
export function stageSnapshot(batch: WriteBatch, plan: SnapshotPlan): void {
  batch.set(plan.ref, {
    seq: plan.seq,
    createdAt: FieldValue.serverTimestamp(),
    origin: plan.origin,
    fileCount: plan.files.length,
    // The validator's own numbers, not ones recomputed here.
    totalBytes: plan.files.reduce((total, file) => total + file.size, 0),
  })

  const copies = plan.ref.collection(SNAPSHOT_FILES)
  for (const file of plan.files) {
    // The id *is* the path, so no two documents can claim one filename.
    batch.set(copies.doc(file.path), { path: file.path, content: file.content, size: file.size })
  }

  for (const pruned of plan.prune) {
    for (const fileRef of pruned.fileRefs) batch.delete(fileRef)
    batch.delete(pruned.ref)
  }
}

/**
 * The version list — newest first, capped, metadata only.
 *
 * The cap is the prune's cap, so "you are seeing every version" is a guarantee
 * rather than a hope. A single-field `orderBy` is served by Firestore's automatic
 * index, so this needs no entry in `firestore.indexes.json`. A document that will
 * not parse is omitted and logged — the log line is the only warning anybody gets.
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

/** A project's version history — or the 404 the project earns. */
export async function handleListSnapshots(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  res.json({ snapshots: await readSnapshotList(uid, projectId) })
}

/**
 * The version id from the URL, or a refusal — before any Firestore call.
 *
 * Its own sentence rather than the project's: two failures one segment apart
 * share a status and a code and deliberately not a message.
 */
export function requireSnapshotId(req: Request): string {
  const parsed = snapshotIdSchema.safeParse(req.params['snapshotId'])
  if (!parsed.success) {
    throw new HttpError(400, 'That version could not be found.', 'invalid_id')
  }
  return parsed.data
}

/** The one 404, so no two snapshot handlers describe the same state differently. */
export function snapshotNotFound(): HttpError {
  return new HttpError(404, SNAPSHOT_MISSING, 'not_found')
}

/**
 * A version's copied files — **all of them, or none**.
 *
 * `null` means "cannot be read whole", from either a document that will not
 * parse or a subcollection shorter than the snapshot's own `fileCount`. Both
 * would restore an app with a hole in it, which is worse than refusing because
 * it looks like it worked.
 */
export async function readSnapshotFiles(
  uid: string,
  projectId: string,
  snapshotId: string,
  fileCount: number,
): Promise<FileWrite[] | null> {
  const snapshot = await getDb()
    .collection(snapshotFilesPath(uid, projectId, snapshotId))
    .get()

  const files = snapshot.docs
    .map((doc) => parseSnapshotFile(doc))
    .filter((file): file is StoredSnapshotFile => file !== null)

  return files.length === fileCount ? files : null
}

/**
 * A version's own document, parsed — narrowed to `fileCount`, which is the only
 * field a restore needs: the count its subcollection must match.
 */
async function readSnapshot(
  uid: string,
  projectId: string,
  snapshotId: string,
): Promise<{ fileCount: number } | null> {
  const doc = await getDb()
    .doc(`${snapshotsPath(uid, projectId)}/${snapshotId}`)
    .get()
  if (!doc.exists) return null

  const parsed = storedSnapshotSchema.safeParse(doc.data())
  if (!parsed.success) {
    logAuthEvent('snapshot.unreadable', { outcome: 'invalid' })
    return null
  }

  return { fileCount: parsed.data.fileCount }
}

/**
 * No keys at all — the version is named by the URL. `.strict()` is the whole
 * schema: a route that ignored its body is one a later field can be smuggled into.
 */
const restoreBodySchema = z.object({}).strict()

/**
 * Roll a project back to one of its versions.
 *
 * The order is the point: ids, then the body, then the project, then the version
 * — each refusal costing nothing the one before it did not already rule out. The
 * version's files are read whole or not at all *before* a batch is opened, which
 * is what lets a refusal promise nothing was changed.
 *
 * **The writes and the deletes are one batch**, so the union of the old set and
 * the new never exists: a restore that deleted in a second commit would pass
 * through 40 files on a full project, and a crash between the two would leave it
 * there.
 */
export async function handleRestoreSnapshot(
  req: Request,
  res: Response,
  uid: string,
): Promise<void> {
  const projectId = requireProjectId(req)
  const snapshotId = requireSnapshotId(req)
  parseBody(restoreBodySchema, req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  const stored = await readSnapshot(uid, projectId, snapshotId)
  if (stored === null) throw snapshotNotFound()

  const version = await readSnapshotFiles(uid, projectId, snapshotId, stored.fileCount)
  if (version === null) throw new HttpError(409, SNAPSHOT_UNREADABLE, 'snapshot_unreadable')

  const current = await readStoredFiles(uid, projectId)

  // A no-op is answered with no batch at all: writing would advance every
  // file's `updatedAt` and mint a version recording that nothing happened.
  if (filesEqual(current, version)) {
    res.json({ files: current.map(toFileMeta), changed: false })
    return
  }

  const currentPaths = new Set(current.map((file) => file.path))

  /*
   * Planned before the batch is opened, because planning reads and a batch is not
   * a transaction — and skipped for a project with no files, since a safety
   * snapshot of nothing is a version nothing can restore to.
   */
  const safety = current.length > 0 ? await planSnapshot(uid, projectId, current, 'restore') : null

  const batch = getDb().batch()
  if (safety !== null) stageSnapshot(batch, safety)

  // `exists` from the current path set, so a file both sides hold merges and
  // keeps the date it was first generated.
  stageFileWrites(
    batch,
    uid,
    projectId,
    version.map((file) => ({ ...file, exists: currentPaths.has(file.path) })),
  )

  // The deletes are what make a restore an equality rather than an overlay:
  // without them, version 1's files sit beside version 2's extra one.
  const restored = new Set(version.map((file) => file.path))
  for (const path of currentPaths) {
    if (!restored.has(path)) batch.delete(getDb().doc(`${filesPath(uid, projectId)}/${path}`))
  }

  /*
   * The batch is all-or-nothing, so the one thing worth telling the caller is
   * that nothing was written and pressing Restore again is safe — which a generic
   * 500 does not say. The cause reaches the log, redacted.
   */
  try {
    await batch.commit()
  } catch (err) {
    console.error('snapshot.restore_failed', describeError(err))
    throw new HttpError(500, RESTORE_FAILED, 'internal')
  }

  // Re-read, because `serverTimestamp()` is a sentinel until it commits.
  res.json({ files: await readFileList(uid, projectId), changed: true })
}
