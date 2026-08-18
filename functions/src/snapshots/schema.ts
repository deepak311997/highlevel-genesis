import { z } from 'zod'

import { filePathSchema } from '../files/schema'
import { projectsPath } from '../projects/schema'
import { firestoreTimestamp } from '../users/schema'

/**
 * `users/{uid}/projects/{projectId}/snapshots/{snapshotId}` and its
 * `files/{fileId}` subcollection — a point-in-time copy of a project's **whole**
 * file set, and the boundaries around it.
 *
 * **Two collections, because 20 × 100,000 bytes does not fit in a document.**
 * The obvious shape — an inline `Record<path, content>` on the snapshot — exceeds
 * Firestore's 1,048,576-byte limit at the project cap, and would do so only on
 * the largest projects, which is the worst possible place for a limit to bite.
 * So the metadata is one document and the files hang off it, one per file.
 *
 * **The file document's id *is* the path**, exactly as the live `files`
 * collection's is (D13). A copy cannot then hold two documents claiming one
 * filename, and `id === path` is an invariant asserted on parse — by
 * `parseSnapshotFile` in `handlers.ts` — rather than assumed.
 *
 * **A snapshot's file documents carry no timestamps**, where the live ones carry
 * two. The snapshot document's `createdAt` is the one time that means anything
 * about a copy: every file in it was copied at that instant, so a per-file
 * `updatedAt` would be twenty repetitions of one fact, and a per-file
 * `createdAt` would claim something about the file's own history that the copy
 * does not know.
 *
 * The documents are written only by the Admin SDK, from two places: `/generate`'s
 * one batch per turn, and
 * `POST /api/projects/:projectId/snapshots/:snapshotId/restore`. They are read
 * only by `GET /api/projects/:projectId/snapshots` and by the restore.
 * `firestore.rules` denies both collections to every client, owner included —
 * and denies them *separately*, because rules do not cascade.
 *
 * **The path is the ownership.** A snapshot lives under its project, which lives
 * under its owner's uid — the one `withVerifiedUser` read off the ID token — so
 * there is no `ownerUid` field here and no equality check anywhere.
 */

export const SNAPSHOTS = 'snapshots'

/** The subcollection under one snapshot. Named as the live collection is. */
export const SNAPSHOT_FILES = 'files'

/**
 * The most snapshots one project keeps, and the most the list returns.
 *
 * The same number as `FILE_LIMIT`, and the same as the list's cap — which is
 * `PROJECT_LIMIT` / `MESSAGE_LIMIT` / `FILE_LIMIT`'s rule: an unpaginated list
 * is only honest if it cannot truncate, so "you are seeing every version" is a
 * guarantee rather than a hope. Twenty turns of history is more than a
 * single-purpose CRM mini-app accumulates in a sitting, and the prune is what
 * keeps a project's storage bounded rather than growing with its transcript.
 */
export const SNAPSHOT_LIMIT = 20

/**
 * One place composes each path, from `projectsPath` rather than a second
 * `'users'` literal, so the segments cannot drift — `filesPath`'s and
 * `messagesPath`'s shape.
 */
export function snapshotsPath(uid: string, projectId: string): string {
  return `${projectsPath(uid)}/${projectId}/${SNAPSHOTS}`
}

/** Composed from `snapshotsPath`, so the two cannot disagree about the first four segments. */
export function snapshotFilesPath(uid: string, projectId: string, snapshotId: string): string {
  return `${snapshotsPath(uid, projectId)}/${snapshotId}/${SNAPSHOT_FILES}`
}

/** A version that is not there — the one 404 both routes answer with. */
export const SNAPSHOT_MISSING = 'That version no longer exists.'

/**
 * A version that is there and cannot be trusted — the 409, and the one refusal
 * in this slice that is neither "gone" nor "try again".
 *
 * The last sentence is the point of it. A restore that half-applied would leave
 * a project that is neither version, so the copy has to say the write did not
 * begin.
 */
export const SNAPSHOT_UNREADABLE =
  'That version could not be restored: part of it is unreadable. Nothing was changed.'

/** A restore that failed for a reason the caller can do nothing about but retry. */
export const RESTORE_FAILED = 'That version could not be restored. Try again.'

/**
 * A Firestore auto-id, and nothing that could change the depth of a document
 * path (P1).
 *
 * **Its own copy of `projectIdSchema`'s pattern with its own message**, rather
 * than an import. A malformed snapshot id and a malformed project id are two
 * different failures one segment apart, and sharing one sentence between them
 * would make a caller who mistyped the version think they had mistyped the
 * project. The message describes the outcome rather than the rule, so a
 * malformed id and a stranger's version read the same to the caller.
 */
export const snapshotIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'That version could not be found.')

/**
 * Why a snapshot exists, and the whole of the allowlist.
 *
 * Two values, and the enum is what makes `originLabel` exhaustive on the client:
 * a third would render as nothing at all, so the document is refused here
 * instead of being displayed as a version with no explanation.
 */
export const snapshotOriginSchema = z.enum(['generation', 'restore'])

export type SnapshotOrigin = z.infer<typeof snapshotOriginSchema>

/**
 * The snapshot document, **parsed rather than asserted**.
 *
 * Nothing here carries a `.catch`, deliberately: `seq` is how a version is
 * named, `createdAt` is how it is dated, `origin` is how it is explained, and
 * the two counts are the subtitle. A document missing any of them cannot be
 * shown in a list, so it is *known* to be unusable — omitted, and logged once.
 *
 * `fileCount` has a floor of **1** (D27) rather than 0: a snapshot is only ever
 * written for a turn that stored files, or for a project that had some, so a
 * document claiming to be a copy of nothing is corrupt rather than empty. It is
 * also the count the restore checks its subcollection against, and a 0 would
 * make "every file is present" vacuously true.
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
 * One copied file.
 *
 * **The same `filePathSchema` the live collection uses**, so a copy cannot hold
 * a name the project itself could never have stored — which matters because a
 * restore writes these paths straight back into `files`, and a path that got
 * past this schema would be a path that got past that one.
 *
 * No timestamps: see the module header.
 */
export const storedSnapshotFileSchema = z.object({
  path: filePathSchema,
  content: z.string(),
  size: z.number().int().min(0),
})

export type StoredSnapshotFile = z.infer<typeof storedSnapshotFileSchema>

/**
 * The wire shape. Timestamps are ISO-8601 strings — the project's convention
 * since Slice 2.
 *
 * **There is no `files` and no `content`.** A version is up to 20 files of up to
 * 100 KB, and opening a history sheet must not ship a megabyte of code nobody
 * has asked to restore (AC-11). The absence is carried by the *type*, so an
 * entry cannot acquire one by accident.
 *
 * `id` is present here where `FileMeta` has none, because a snapshot's id is an
 * auto-id rather than a name the user can see — it is what the restore route
 * addresses, and there is nothing else to address it by.
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
