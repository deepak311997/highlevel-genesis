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
 *
 * **And no `orderBy('seq')` either, which is the same rule stated the other way.**
 * Firestore omits a document that does not carry the ordered field at all, so an
 * `orderBy('seq')` here would hide exactly the head the paragraph above says to
 * prune first — it would be invisible to this read *and* to `readSnapshotList`,
 * never listed, never counted toward the excess, never pruned, and its up to
 * twenty file documents paid for forever. That is R4's orphan, reached from the
 * one direction `PrunedSnapshot` does not cover. Neither consumer needs the
 * order: `planSnapshotSeq` takes a maximum and `planSnapshotPrune` sorts what it
 * is given.
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
export async function handleListSnapshots(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  res.json({ snapshots: await readSnapshotList(uid, projectId) })
}

/**
 * The version id from the URL, or a refusal.
 *
 * Called as the **second statement** of the restore handler, right after
 * `requireProjectId`, so a malformed id costs no Firestore call at all —
 * `requireProjectId`'s rule, one segment deeper.
 *
 * It carries `snapshotIdSchema`'s own message rather than the project's (P1). A
 * malformed version id and a malformed project id are two different failures one
 * segment apart; they share a status and a code and deliberately not a sentence,
 * so a caller who mistyped the version is not told they mistyped the project.
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
 * A version's copied files — **all of them, or none** (D8).
 *
 * `null` is "this version cannot be read whole", and it has two causes that the
 * caller deliberately does not tell apart: a document that will not parse, and
 * a subcollection holding fewer documents than the snapshot says it should. Both
 * would restore an app with a hole in it, which is worse than refusing because
 * it looks like it worked.
 *
 * The count check is against the snapshot's own `fileCount`, so a subcollection
 * that lost a document to a partial delete is caught even though every document
 * still present parses perfectly.
 *
 * Read unordered: the restore compares sets and writes by name, so there is
 * nothing an ordering would buy — and an unordered collection read needs no
 * index (D16).
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
 * A version's own document, parsed — or `null`, which is the whole of "gone".
 *
 * Narrowed to `fileCount` because that is the only field the restore uses it
 * for: D8's integrity check, the count the subcollection must match. The
 * version's `seq` names it in the *list*; nothing about rolling a project back
 * needs the name.
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
 * A body with **no keys at all** — the version to restore is named by the URL.
 *
 * `.strict()` is the whole schema. There is nothing for a caller to say here, and
 * a route that ignored a body would be a route where a later field could be
 * smuggled past review. `parseBody` substitutes `{}` for a bodyless request, so
 * the ordinary call and this schema agree.
 */
const restoreBodySchema = z.object({}).strict()

/**
 * Roll a project back to one of its versions.
 *
 * The order is the point of the function, and each step is where it is because
 * of what the step before it made impossible:
 *
 * 1. **the project id**, then 2. **the version id** — a malformed either costs no
 *    Firestore call at all;
 * 3. **the body**, refused before anything reads, so a request carrying a field
 *    writes nothing;
 * 4. **the project** — absent, soft-deleted, unreadable and somebody else's all
 *    collapse into one 404 (D14), and the path is composed from the token's uid,
 *    so another user's project is not addressable rather than merely refused;
 * 5. **the version document** — a version id is scoped to its project, so one
 *    from a different project of the caller's own is a 404 here rather than a
 *    cross-project restore;
 * 6. **the version's files, whole or not at all** — 409 before a batch is opened,
 *    which is what lets the refusal promise that nothing was changed (D8);
 * 7. **the project's current files**, which answers two questions at once: is
 *    this a no-op, and what does the safety snapshot copy;
 * 8. **the no-op**, answered with **no batch at all** (D10) — writing would
 *    advance every file's `updatedAt` and mint a version recording that nothing
 *    happened, and the prune would push a real one out to make room for it;
 * 9. **one batch**: the safety snapshot, the writes and the deletes together;
 * 10. **the re-read**, because `serverTimestamp()` is a sentinel until it
 *     commits.
 *
 * `FILE_LIMIT` is never exceeded at any point (AC-18) because the writes and the
 * deletes are in that one batch: the union of the old set and the new one never
 * exists. A restore that deleted in a second commit would pass through 40 files
 * on a full project, and a crash between the two would leave it there.
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

  /*
   * D10. `readStoredFiles` orders by path and `filesEqual` is order-independent
   * anyway, so this needs no second read — and answering the files we have just
   * read costs nothing a `GET` would not have cost the caller anyway.
   */
  if (filesEqual(current, version)) {
    res.json({ files: current.map(toFileMeta), changed: false })
    return
  }

  const currentPaths = new Set(current.map((file) => file.path))

  /*
   * D9. Planned **before** the batch is opened, because planning reads and a
   * batch is not a transaction — and skipped entirely for a project with no
   * files, because a safety snapshot of nothing is a version nothing can restore
   * to (and `fileCount` has a floor of 1, so it could not even be written).
   */
  const safety = current.length > 0 ? await planSnapshot(uid, projectId, current, 'restore') : null

  const batch = getDb().batch()
  if (safety !== null) stageSnapshot(batch, safety)

  // `exists` from the current path set, so a file both sides hold **merges** and
  // keeps the date it was first generated, exactly as a rewriting generation does.
  stageFileWrites(
    batch,
    uid,
    projectId,
    version.map((file) => ({ ...file, exists: currentPaths.has(file.path) })),
  )

  // D7, R3. The deletes are what make the restore an *equality* rather than an
  // overlay: without them, version 1's files sit beside version 2's extra one and
  // the app breaks in a way the tree does not show.
  const restored = new Set(version.map((file) => file.path))
  for (const path of currentPaths) {
    if (!restored.has(path)) batch.delete(getDb().doc(`${filesPath(uid, projectId)}/${path}`))
  }

  /*
   * The PRD's copy for this state, rather than the `Internal error` an uncaught
   * rejection would produce. The batch is all-or-nothing, so the one thing worth
   * telling the caller is that **nothing was written** and pressing Restore again
   * is safe — which is what the sentence says and what a generic 500 does not.
   * The cause still reaches the log, redacted the way `errorHandler` redacts it,
   * because a Firebase error carries the failing request on the object.
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
