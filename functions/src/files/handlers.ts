import type { Request } from 'express'
import type { DocumentSnapshot, WriteBatch } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'

import { HttpError } from '../lib/errors'
import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import {
  filePathSchema,
  FILE_LIMIT,
  filesPath,
  storedFileSchema,
  type FileWrite,
  type StoredFile,
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
