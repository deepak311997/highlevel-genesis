import { z } from 'zod'

import { filePathSchema } from '../files/schema'
import { projectsPath } from '../projects/schema'
import { firestoreTimestamp } from '../users/schema'

/**
 * `users/{uid}/projects/{projectId}/snapshots/{snapshotId}` and its
 * `files/{fileId}` subcollection — a point-in-time copy of a project's whole file
 * set.
 *
 * **Two collections, because 20 × 100,000 bytes does not fit in a document.** An
 * inline `Record<path, content>` exceeds Firestore's limit at the project cap, and
 * would do so only on the largest projects — the worst place for a limit to bite.
 *
 * **The file document's id *is* the path**, as the live collection's is, so a copy
 * cannot hold two documents claiming one filename. **Snapshot files carry no
 * timestamps**: the snapshot's own `createdAt` is the one time that means anything
 * about a copy.
 *
 * Written only by the Admin SDK, read only by the list and the restore.
 * `firestore.rules` denies both collections to every client — *separately*,
 * because rules do not cascade.
 */

export const SNAPSHOTS = 'snapshots'

/** The subcollection under one snapshot. Named as the live collection is. */
export const SNAPSHOT_FILES = 'files'

/**
 * The most snapshots one project keeps, and the most the list returns — the same
 * number, so "you are seeing every version" is a guarantee rather than a hope. The
 * prune is what keeps a project's storage bounded rather than growing with its
 * transcript.
 */
export const SNAPSHOT_LIMIT = 20

/** One place composes each path, so the segments cannot drift. */
export function snapshotsPath(uid: string, projectId: string): string {
  return `${projectsPath(uid)}/${projectId}/${SNAPSHOTS}`
}

/** Composed from `snapshotsPath`, so the two cannot disagree. */
export function snapshotFilesPath(uid: string, projectId: string, snapshotId: string): string {
  return `${snapshotsPath(uid, projectId)}/${snapshotId}/${SNAPSHOT_FILES}`
}

/** A version that is not there — the one 404 both routes answer with. */
export const SNAPSHOT_MISSING = 'That version no longer exists.'

/**
 * A version that is there and cannot be trusted — the 409, and the one refusal
 * that is neither "gone" nor "try again". The last sentence is the point: a
 * restore that half-applied would leave a project that is neither version.
 */
export const SNAPSHOT_UNREADABLE =
  'That version could not be restored: part of it is unreadable. Nothing was changed.'

/** A restore that failed for a reason the caller can do nothing about but retry. */
export const RESTORE_FAILED = 'That version could not be restored. Try again.'

/**
 * A Firestore auto-id, and nothing that could change the depth of a document path.
 *
 * **Its own copy of the project id's pattern, with its own message**: a malformed
 * snapshot id and a malformed project id are two failures one segment apart, and
 * one shared sentence would tell a caller they mistyped the wrong thing.
 */
export const snapshotIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'That version could not be found.')

/**
 * Why a snapshot exists, and the whole of the allowlist. The enum is what makes
 * the client's label exhaustive: a third value would render as nothing at all, so
 * the document is refused here instead.
 */
export const snapshotOriginSchema = z.enum(['generation', 'restore'])

export type SnapshotOrigin = z.infer<typeof snapshotOriginSchema>

/**
 * The snapshot document, **parsed rather than asserted** — nothing carries a
 * `.catch`, so a document missing any field is omitted and logged once.
 *
 * `fileCount` has a floor of **1** rather than 0: a snapshot is only written for a
 * turn that stored files, so a document claiming to be a copy of nothing is
 * corrupt. It is also what the restore checks its subcollection against, and a 0
 * would make "every file is present" vacuously true.
 */
export const storedSnapshotSchema = z.object({
  seq: z.number().int().min(1),
  createdAt: firestoreTimestamp,
  origin: snapshotOriginSchema,
  fileCount: z.number().int().min(1),
  totalBytes: z.number().int().min(0),
})

export type StoredSnapshot = z.infer<typeof storedSnapshotSchema>

/**
 * One copied file, under **the same `filePathSchema` the live collection uses** —
 * a restore writes these paths straight back into `files`, so a path that got past
 * this schema would be one that got past that one.
 */
export const storedSnapshotFileSchema = z.object({
  path: filePathSchema,
  content: z.string(),
  size: z.number().int().min(0),
})

export type StoredSnapshotFile = z.infer<typeof storedSnapshotFileSchema>

/**
 * The wire shape. Timestamps are ISO-8601 strings.
 *
 * **There is no `files` and no `content`**: opening a history sheet must not ship
 * a megabyte of code nobody has asked to restore, and the absence is carried by
 * the type so an entry cannot acquire one by accident. `id` is present, unlike
 * `FileMeta`, because a snapshot has nothing else to be addressed by.
 */
export interface SnapshotMeta {
  id: string
  seq: number
  createdAt: string
  origin: SnapshotOrigin
  fileCount: number
  totalBytes: number
}

export function toSnapshotMeta(id: string, stored: StoredSnapshot): SnapshotMeta {
  return {
    id,
    seq: stored.seq,
    createdAt: stored.createdAt.toDate().toISOString(),
    origin: stored.origin,
    fileCount: stored.fileCount,
    totalBytes: stored.totalBytes,
  }
}
