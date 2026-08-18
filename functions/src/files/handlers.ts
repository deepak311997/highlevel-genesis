import type { Request, Response } from 'express'
import type {
  DocumentReference,
  DocumentSnapshot,
  QueryDocumentSnapshot,
  WriteBatch,
} from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import type { ZodType } from 'zod'

import { HttpError } from '../lib/errors'
import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import { parseBody } from '../lib/parse'
import type { CollectResult } from '../llm/fileops'
import { notFound, readProject, requireProjectId } from '../projects/handlers'
import { mergeSnapshotFiles } from '../snapshots/plan'
import {
  byteLength,
  filePathSchema,
  FILE_LIMIT,
  filesPath,
  putFileBodySchema,
  storedFileMetaSchema,
  storedFileSchema,
  toFile,
  toFileMeta,
  validateFileOps,
  type FileMeta,
  type FileRejection,
  type FileWrite,
  type StoredFile,
  type StoredFileMeta,
} from './schema'

/**
 * A project's generated files — the reads, the batch, and the three routes.
 *
 * Every path is built from the token's uid, so another user's files are not
 * addressable rather than merely refused, and `readProject` runs first on every
 * route: absent, soft-deleted and unreadable collapse into one 404.
 */

/**
 * Parse a snapshot, or `null` when it cannot describe a file.
 *
 * Two ways to fail: the schema, and the `id === path` check. A document where the
 * two disagree cannot be shown in the right row of a tree or answered for the
 * right `GET`, so it is omitted from the list and 404 by id. Nothing from the
 * document reaches the log — a file is the user's own application.
 */
export function parseStoredFile(snapshot: DocumentSnapshot): StoredFile | null {
  // An absent document is not corruption, so it is not logged as such.
  if (!snapshot.exists) return null

  const parsed = storedFileSchema.safeParse(snapshot.data())
  if (!parsed.success) {
    logAuthEvent('file.unreadable', { outcome: 'invalid' })
    return null
  }

  if (parsed.data.path !== snapshot.id) {
    logAuthEvent('file.unreadable', { outcome: 'invalid', detail: 'id mismatch' })
    return null
  }

  return parsed.data
}

/**
 * The path from the URL, or a refusal — before any Firestore call.
 *
 * Express percent-decodes a route parameter, so `%2e%2e%2fsecrets.js` arrives as
 * `../secrets.js` and simply fails to be a filename: traversal is refused by the
 * shape of a name rather than by a sanitiser that must be right about every
 * encoding. The message describes the outcome, so a malformed path and a
 * stranger's file read the same.
 */
export function requireFilePath(req: Request): string {
  const parsed = filePathSchema.safeParse(req.params['path'])
  if (!parsed.success) {
    throw new HttpError(400, 'That file could not be found.', 'invalid_path')
  }
  return parsed.data
}

/** The one 404, so no two file handlers describe the same state differently. */
export function fileNotFound(): HttpError {
  return new HttpError(404, 'That file no longer exists.', 'not_found')
}

/**
 * The project's files, content included, up to the cap — **one read, three
 * questions**: is the union within `FILE_LIMIT`, which of a turn's writes are
 * rewrites, and what does a snapshot copy.
 *
 * **A document that cannot be read is omitted**, which the callers rely on: the
 * cap counts one fewer, and a rewrite of a corrupt path is planned with
 * `exists: false`, so it is written whole and repaired rather than merged into
 * rubble.
 *
 * Read immediately before the write and not transactional: two simultaneous
 * generations at the cap can both land, which is a guard-rail missing by one
 * rather than a boundary being crossed.
 */
export async function readStoredFiles(uid: string, projectId: string): Promise<StoredFile[]> {
  const snapshot = await getDb()
    .collection(filesPath(uid, projectId))
    .orderBy('path')
    .limit(FILE_LIMIT)
    .get()

  return snapshot.docs
    .map((doc) => parseStoredFile(doc))
    .filter((file): file is StoredFile => file !== null)
}

/**
 * A file to write, and whether the project already holds it.
 *
 * The flag rides along rather than being re-read inside the batch: the read that
 * answers it has already happened for the cap check and the snapshot's merge.
 */
export interface FileWritePlan extends FileWrite {
  exists: boolean
}

/**
 * Stage every file of a turn onto a batch. **Nothing is committed here.**
 *
 * The commit belongs to `appendAssistantMessage`, which owns the batch: the
 * message says `[file: index.html]`, and if that commits and the file does not,
 * the transcript is lying about the project's contents.
 *
 * **A rewrite merges and carries no `createdAt`** — a plain `set` would reset the
 * date the file was first generated. A new file is written whole, so nothing from
 * an earlier shape survives under it.
 */
export function stageFileWrites(
  batch: WriteBatch,
  uid: string,
  projectId: string,
  writes: readonly FileWritePlan[],
): void {
  // A prose-only turn touches no collection at all.
  if (writes.length === 0) return

  const collection = getDb().collection(filesPath(uid, projectId))

  for (const write of writes) {
    const document = {
      // Stored as a field as well as being the id, so the collection is legible
      // in a console and `orderBy('path')` has something to order by.
      path: write.path,
      content: write.content,
      size: write.size,
      updatedAt: FieldValue.serverTimestamp(),
    }

    if (write.exists) {
      batch.set(collection.doc(write.path), document, { merge: true })
      continue
    }

    batch.set(collection.doc(write.path), { ...document, createdAt: FieldValue.serverTimestamp() })
  }
}

/** What a turn's files came to: what to write, and what to tell the user. */
export interface FileWriteOutcome {
  writes: FileWritePlan[]
  /**
   * The project's file set as it stands **after** this turn — what a snapshot
   * copies.
   *
   * Not the writes: a turn that rewrites one of three files leaves a project of
   * three, and copying the one write would restore an app missing two thirds of
   * itself. Empty exactly when `writes` is.
   */
  resulting: FileWrite[]
  error: FileRejection | null
}

/**
 * Turn a finished collection into the writes a turn should commit.
 *
 * Nothing is committed here, and nothing is read unless there is something to
 * write. The three refusals are ordered as the user needs them:
 *
 * 1. **The turn did not complete** — its last block is unterminated by
 *    construction and its earlier blocks describe an app whose remaining parts
 *    were never written. *Completed, or nothing* is impossible to get subtly
 *    wrong, where "keep the blocks that closed" is a half-app that looks fine in
 *    the tree. A turn that attempted no file is silent here.
 * 2. **A block was left open**, on a turn that otherwise completed.
 * 3. **The set failed validation** — path, duplicate, byte cap or file cap.
 *
 * `completed` comes from the **mapper's** `truncated`, not the message's. They
 * differ for a client that disconnects after a clean `end`: the message is marked
 * truncated, and the files are still written — they belong to the project, not
 * the connection.
 */
export async function planFileWrites(
  uid: string,
  projectId: string,
  collected: CollectResult,
  completed: boolean,
): Promise<FileWriteOutcome> {
  const attempted = collected.ops.length > 0 || collected.unterminated !== null

  if (!completed) {
    return { writes: [], resulting: [], error: attempted ? { reason: 'incomplete' } : null }
  }

  if (collected.unterminated !== null) {
    return {
      writes: [],
      resulting: [],
      error: { reason: 'unterminated', path: collected.unterminated },
    }
  }

  // A prose-only reply reads nothing at all: no cap to check, nothing to write,
  // and therefore no merge and no snapshot.
  if (collected.ops.length === 0) return { writes: [], resulting: [], error: null }

  const existing = await readStoredFiles(uid, projectId)
  const existingPaths = new Set(existing.map((file) => file.path))
  const validated = validateFileOps(collected.ops, [...existingPaths])
  if (!validated.ok) return { writes: [], resulting: [], error: validated.error }

  return {
    writes: validated.writes.map((write) => ({ ...write, exists: existingPaths.has(write.path) })),
    resulting: mergeSnapshotFiles(existing, validated.writes),
    error: null,
  }
}

/**
 * One document a query returned, parsed — or `null`, logged, and skipped.
 *
 * Shared by the two readers below because both fail closed the same two ways, and
 * the drift would be concrete: the file tree and the model's view of the project
 * disagreeing about which files exist. The **schema is the parameter**, because it
 * is the entire difference between them.
 *
 * Deliberately not folded into {@link parseStoredFile}, which also answers for an
 * *absent* document — a branch a query reader could never reach.
 */
function parseQueriedFile<T extends { path: string }>(
  doc: QueryDocumentSnapshot,
  schema: ZodType<T>,
): T | null {
  const parsed = schema.safeParse(doc.data())
  if (!parsed.success) {
    logAuthEvent('file.unreadable', { outcome: 'invalid' })
    return null
  }

  // The id *is* the path, so a document filed under a name it does not claim
  // cannot be shown in the right row of a tree or sent as the right file.
  if (parsed.data.path !== doc.id) {
    logAuthEvent('file.unreadable', { outcome: 'invalid', detail: 'id mismatch' })
    return null
  }

  return parsed.data
}

/**
 * The list, parsed and ordered — **metadata only**.
 *
 * `select(...)` is what keeps opening a workspace from shipping 20 × 100 KB of
 * code nobody has clicked on. The cap matches `FILE_LIMIT`, so "you are seeing
 * every file" is a guarantee rather than a hope, and a single-field `orderBy`
 * needs no entry in `firestore.indexes.json`.
 */
export async function readFileList(uid: string, projectId: string): Promise<FileMeta[]> {
  const snapshot = await getDb()
    .collection(filesPath(uid, projectId))
    .orderBy('path')
    .limit(FILE_LIMIT)
    .select('path', 'size', 'createdAt', 'updatedAt')
    .get()

  return snapshot.docs
    .map((doc) => parseQueriedFile(doc, storedFileMetaSchema))
    .filter((meta): meta is StoredFileMeta => meta !== null)
    .map(toFileMeta)
}

/**
 * The same list, **with the content** — what a generation is shown.
 *
 * A second reader rather than a widening of `readFileList`, which would ship
 * every project's code to every workspace that merely opens a file tree — a cost
 * on every page load to serve one caller that runs once per generation. What the
 * two share is everything that could drift: the collection, the order, the cap,
 * and the fail-closed handling of a document that cannot describe a file.
 *
 * The stored documents come back rather than the wire shape: the caller wants
 * `path` and `content` and has no use for ISO-8601 timestamps.
 */
export async function readProjectFiles(uid: string, projectId: string): Promise<StoredFile[]> {
  const snapshot = await getDb()
    .collection(filesPath(uid, projectId))
    .orderBy('path')
    .limit(FILE_LIMIT)
    .get()

  return snapshot.docs
    .map((doc) => parseQueriedFile(doc, storedFileSchema))
    .filter((file): file is StoredFile => file !== null)
}

/** One file's document reference. The id *is* the path. */
function fileRef(uid: string, projectId: string, path: string): DocumentReference {
  return getDb().doc(`${filesPath(uid, projectId)}/${path}`)
}

/**
 * A project's file tree — or the 404 the project earns. A file is not addressable
 * without a project, so there is nothing to read past that.
 */
export async function handleListFiles(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  res.json({ files: await readFileList(uid, projectId) })
}

/**
 * One file, with its content.
 *
 * The id, then the path, then the project: a refusal costs no Firestore call, and
 * `%2e%2e%2fsecrets.js` is refused before anything composes a document path.
 */
export async function handleGetFile(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)
  const path = requireFilePath(req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  const stored = parseStoredFile(await fileRef(uid, projectId, path).get())
  if (stored === null) throw fileNotFound()

  res.json({ file: toFile(stored) })
}

/**
 * Save an edit. **`PUT` does not create** — a path the project does not hold is a
 * 404, which keeps the write surface to documents the generator made.
 *
 * Last write wins, deliberately: two tabs editing one file is a case a user has
 * to work at, and the realistic collision — a generation against an editor — is
 * closed where it happens, by the panel going read-only while a stream is open.
 */
export async function handlePutFile(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)
  const path = requireFilePath(req)
  const body = parseBody(putFileBodySchema, req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  const ref = fileRef(uid, projectId, path)
  // A document that will not parse is unreadable, which from outside is the same
  // answer as a file that was never generated.
  if (parseStoredFile(await ref.get()) === null) throw fileNotFound()

  await ref.update({
    content: body.content,
    // Recomputed server-side: `size` is not a field a caller may choose.
    size: byteLength(body.content),
    updatedAt: FieldValue.serverTimestamp(),
    // `createdAt` is deliberately untouched — it is the date the file was first
    // generated, and a save is not that.
  })

  // Re-read, because `serverTimestamp()` is a sentinel until it commits.
  const stored = parseStoredFile(await ref.get())
  if (stored === null) {
    // Unreachable: we have just written a complete document. It fails closed
    // rather than answering a half-shaped file to a caller whose save succeeded.
    logAuthEvent('file.unreadable', { outcome: 'invalid', detail: 'after put' })
    throw new HttpError(500, 'Internal error', 'internal')
  }

  res.json({ file: toFile(stored) })
}
