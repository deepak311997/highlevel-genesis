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
 * A project's generated files — the reads, the batch, and the three routes'
 * shared parts.
 *
 * The uid is the one `withVerifiedUser` read off the ID token and every path is
 * built from it, so another user's files are not addressable by a request rather
 * than merely refused. `readProject` is called first on every route here, so
 * "this project is gone" means exactly what it means in `/api/projects*`: absent,
 * soft-deleted and unreadable all collapse into one 404 (D14).
 */

/**
 * Parse a snapshot, or `null` when it cannot describe a file.
 *
 * Two ways to fail, and the second is this collection's own (D13). The schema
 * says what a file document is made of; the **`id === path` check** says the
 * document is about the file it is filed under. A document where the two
 * disagree cannot be shown in the right row of a tree or answered for the right
 * `GET`, so it is *known* to be unusable — omitted from the list, 404 by id.
 *
 * Fail closed and say so in the log: the precedent runs through `parseStored`,
 * `parseStoredMessage` and `readProfile`. The log line is the only warning
 * anybody gets, because from outside a corrupt file is indistinguishable from one
 * that was never generated. **No field of the document goes in it** — a file is
 * the user's own application.
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
 * The path from the URL, or a refusal.
 *
 * Called as the **first statement** of every handler that takes one, so a
 * malformed path costs no Firestore call at all — `requireProjectId`'s rule.
 * Express percent-decodes a route parameter, so `%2e%2e%2fsecrets.js` arrives
 * here as `../secrets.js` and fails to be a filename, which is D12's whole
 * argument: traversal is refused by the shape of a name rather than by a
 * sanitiser that has to be right about every encoding.
 *
 * The message describes the outcome rather than the rule, so a malformed path
 * and a stranger's file read the same to the caller.
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
 * Which paths the project already holds, up to the cap.
 *
 * `select()` with no arguments asks for document references and no field data, so
 * this is ≤20 refs rather than ≤20 documents — `liveProjectCount` and
 * `messageCount`'s shape. It answers two questions at once: whether the union is
 * within `FILE_LIMIT`, and which of a turn's writes are rewrites rather than
 * creations.
 *
 * Read immediately before the write and **not transactional**, exactly as the
 * other two guard-rails are (D23's last-write-wins says the same thing from the
 * other side). Two simultaneous generations at the cap can both land, which is a
 * guard-rail missing by one rather than a boundary being crossed.
 */
export async function readFilePaths(uid: string, projectId: string): Promise<Set<string>> {
  const snapshot = await getDb()
    .collection(filesPath(uid, projectId))
    .limit(FILE_LIMIT)
    .select()
    .get()

  return new Set(snapshot.docs.map((doc) => doc.id))
}

/**
 * A file to write, and whether the project already holds it.
 *
 * The flag rides along rather than being re-read inside the batch, because the
 * read that answers it — `readFilePaths` — has already happened for the cap
 * check, and a second one inside the write path would be a second answer to the
 * same question.
 */
export interface FileWritePlan extends FileWrite {
  exists: boolean
}

/**
 * Stage every file of a turn onto a batch. **Nothing is committed here** (D11).
 *
 * The commit belongs to `appendAssistantMessage`, which owns the batch: the
 * assistant message says `[file: index.html]`, and if that commits and the file
 * does not, the transcript is lying about the project's contents.
 *
 * **A rewrite carries no `createdAt` and merges**, which is the whole of AC-19: a
 * plain `set` would replace the document and reset the date the file was first
 * generated. A new file is written whole, so nothing from an earlier shape can
 * survive under it.
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
  error: FileRejection | null
}

/**
 * Turn a finished collection into the writes a turn should commit (D9, D10).
 *
 * **Nothing is committed here and nothing is read unless there is something to
 * write.** The order of the three refusals is the order the user needs them in:
 *
 * 1. **The turn did not complete.** A cut-off turn's last block is unterminated
 *    by construction, and its earlier blocks describe an app whose remaining
 *    parts were never written. One rule — *completed, or nothing* — is impossible
 *    to get subtly wrong, where "keep the blocks that closed" is a half-app that
 *    looks fine in the tree. A turn that attempted **no** file at all is silent
 *    here (P6): a prose-only reply is a legitimate turn, and a truncated
 *    prose-only reply is still one.
 * 2. **A block was left open**, on a turn that otherwise completed.
 * 3. **The set failed validation** — path, duplicate, byte cap or file cap.
 *
 * `completed` is the caller's to decide, and it is read from the **mapper's own**
 * `truncated` rather than from the flag the message carries. The two differ in
 * exactly one case, and D10 names it: a client that disconnects *after* a clean
 * `end`. The message is marked truncated because the client left mid-stream, and
 * the files are still written — they belong to the project, not to the
 * connection, and a model that finished cleanly produced a complete app whether
 * or not anyone was still listening.
 */
export async function planFileWrites(
  uid: string,
  projectId: string,
  collected: CollectResult,
  completed: boolean,
): Promise<FileWriteOutcome> {
  const attempted = collected.ops.length > 0 || collected.unterminated !== null

  if (!completed) {
    return { writes: [], error: attempted ? { reason: 'incomplete' } : null }
  }

  if (collected.unterminated !== null) {
    return { writes: [], error: { reason: 'unterminated', path: collected.unterminated } }
  }

  // A prose-only reply reads nothing at all: no cap to check, nothing to write.
  if (collected.ops.length === 0) return { writes: [], error: null }

  const existing = await readFilePaths(uid, projectId)
  const validated = validateFileOps(collected.ops, [...existing])
  if (!validated.ok) return { writes: [], error: validated.error }

  return {
    writes: validated.writes.map((write) => ({ ...write, exists: existing.has(write.path) })),
    error: null,
  }
}

/**
 * One document a query returned, parsed — or `null`, logged, and skipped (D13).
 *
 * Shared by the two readers below because both fail closed the same two ways,
 * and the reason they must not drift is concrete: the file tree and the model's
 * view of the project would otherwise disagree about which files exist. The
 * **schema is the parameter**, because the schema is the entire difference
 * between them — `readFileList` parses a projection with no `content`,
 * `readProjectFiles` parses the whole document.
 *
 * Deliberately not folded into {@link parseStoredFile}, which additionally
 * answers for an *absent* document. A query never returns one, so sharing that
 * function would give both list readers a branch neither can reach.
 *
 * **No field of the document goes in the log line** — a file is the user's own
 * application, and a log sink is a disclosure channel like any other. The line is
 * also the only warning anybody gets, because from outside a corrupt file is
 * indistinguishable from one that was never generated.
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

  // The id *is* the path (D13), so a document filed under a name it does not
  // claim cannot be shown in the right row of a tree or sent as the right file.
  if (parsed.data.path !== doc.id) {
    logAuthEvent('file.unreadable', { outcome: 'invalid', detail: 'id mismatch' })
    return null
  }

  return parsed.data
}

/**
 * The list, parsed and ordered — metadata only.
 *
 * `orderBy('path')` on a single field is served by Firestore's automatic index,
 * and `select()` adds no requirement (D30) — stated because Slices 3 and 4 both
 * paid for a missing composite index and the emulator does not enforce them.
 *
 * `select(...)` is what makes this a projection rather than a read of the whole
 * project's code: opening a workspace must not ship 20 × 100 KB for files nobody
 * has clicked on. The cap matches `FILE_LIMIT`, so "you are seeing every file" is
 * a guarantee rather than a hope — `LIST_LIMIT` / `PROJECT_LIMIT`'s rule.
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
 * The same list, **with the content** — what a generation is shown (Slice 9 D26).
 *
 * A second reader beside `readFileList`, not a widening of it. `readFileList` is
 * deliberately a projection with no `content`, and widening it would ship
 * 20 × 100 KB of code to every workspace that merely opens a file tree — a cost
 * paid on every page load to serve one caller that runs once per generation.
 * Rejected for the same reason: a `withContent` flag, which is the same widening
 * with a boolean in front of it, and leaves the expensive read one default away.
 *
 * What it *does* share is everything that could drift: the collection, the
 * `orderBy('path')`, the `FILE_LIMIT` cap and the fail-closed handling of a
 * document that cannot describe a file. Two different reads answering two
 * different questions — "what files does this project hold" and "what is in
 * them" — never two different answers to either.
 *
 * The stored documents come back rather than the wire shape: the caller is
 * `buildProjectState`, which wants `path` and `content` and has no use for
 * ISO-8601 timestamps.
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

/** One file's document reference. The id *is* the path (D13). */
function fileRef(uid: string, projectId: string, path: string): DocumentReference {
  return getDb().doc(`${filesPath(uid, projectId)}/${path}`)
}

/**
 * A project's file tree — or the 404 the project earns.
 *
 * The project first, and its answer is the whole of "gone" (D14). A file is not
 * addressable without one, so there is nothing to read past this.
 */
export async function handleListFiles(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  res.json({ files: await readFileList(uid, projectId) })
}

/**
 * One file, with its content.
 *
 * The id, then the path, then the project: a refusal costs no Firestore call at
 * all — `handleCreateProject`'s rule, restated. `%2e%2e%2fsecrets.js` is refused
 * here, before anything composes a document path out of it.
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
 * Save an edit. **`PUT` does not create** (D19).
 *
 * Creating a file by hand is not in F5.1, and refusing it keeps the write surface
 * to documents the generator made — so a path the project does not hold is a 404
 * rather than a new file.
 *
 * Deliberately not transactional, and not optimistically concurrent (D23). Last
 * write wins: two tabs editing one file is a case a user has to work at, and the
 * realistic collision — a generation against an editor — is closed by D21, where
 * it actually happens, by making the panel read-only while a stream is open.
 *
 * The order is the same as every other mutation in this codebase: id, path, body,
 * project. A refused body writes nothing and costs no read.
 */
export async function handlePutFile(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)
  const path = requireFilePath(req)
  const body = parseBody(putFileBodySchema, req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  const ref = fileRef(uid, projectId, path)
  // A document that will not parse is unreadable, which from outside is the same
  // answer as a file that was never generated (D13).
  if (parseStoredFile(await ref.get()) === null) throw fileNotFound()

  await ref.update({
    content: body.content,
    // Recomputed server-side: `size` is not a field a caller may choose, which is
    // what `.strict()` on the body makes a property rather than a promise.
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
