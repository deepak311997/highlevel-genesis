import type { Request, Response } from 'express'
import type { DocumentSnapshot, Query } from 'firebase-admin/firestore'

import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import { notFound, readProject, requireProjectId } from '../projects/handlers'
import {
  MESSAGE_LIMIT,
  messagesPath,
  storedMessageSchema,
  toMessage,
  type Message,
  type StoredMessage,
} from './schema'

/**
 * A project's transcript.
 *
 * The uid is the one `withVerifiedUser` read off the ID token and the collection
 * path is built from it — `users/{uid}/projects/{id}/messages` — so the read is
 * scoped before a `where` clause is written and another user's transcript is not
 * addressable by a request. `readProject` is called first on every route here, so
 * "this project is gone" means exactly what it means in `/api/projects*`: absent,
 * soft-deleted and unreadable all collapse into one 404 (D14).
 */

/**
 * Parse a snapshot, or `null` when it cannot describe a message.
 *
 * Fail closed, and say so in the log — the precedent runs through `parseStored`,
 * `readProfile` and `handleGetConnection`. A corrupt message is otherwise
 * **silent** by design: there is no by-id read of a message, so omission from the
 * transcript is the whole behaviour, and this line is the only thing that says a
 * document is broken rather than never written. No field of the document goes in
 * it — a message is the user's own prose, and from Slice 5 on the model's.
 */
export function parseStoredMessage(snapshot: DocumentSnapshot): StoredMessage | null {
  // An absent document is not corruption, so it is not logged as such.
  if (!snapshot.exists) return null

  const parsed = storedMessageSchema.safeParse(snapshot.data())
  if (!parsed.success) {
    logAuthEvent('message.unreadable', { outcome: 'invalid' })
    return null
  }

  return parsed.data
}

/**
 * The transcript's ordering, factored out so it has a test of its own.
 *
 * **The second `orderBy` is the slice's one real hazard** (D8, R1). A
 * `WriteBatch` resolves every `serverTimestamp()` sentinel in it to the *same*
 * commit timestamp, so the two messages of a turn are not nearly tied on
 * `createdAt` — they are exactly tied, on every single turn. Firestore then
 * breaks the tie by document name, and a name here is a random auto-id, so the
 * echo would render above the prompt roughly half the time: a deterministic bug
 * that looks like a flaky test.
 *
 * It is a function rather than an inline chain because deleting the `seq` clause
 * would leave every emulator-backed test passing about half the time. As a
 * function it has an L1 test asserting the two calls *and their order*, so the
 * regression fails in one obvious place instead.
 *
 * The `limit` matches `MESSAGE_LIMIT`, the cap `POST` enforces, so "you are
 * seeing the whole conversation" is a guarantee rather than a hope.
 */
export function transcriptQuery(collection: Query): Query {
  return collection.orderBy('createdAt', 'asc').orderBy('seq', 'asc').limit(MESSAGE_LIMIT)
}

/** A project's messages, oldest first, capped — or the 404 the project earns. */
export async function handleListMessages(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)

  // The project first, and its answer is the whole of "gone" (D14). A transcript
  // is not addressable without one, so there is nothing to read past this.
  if ((await readProject(uid, projectId)) === null) throw notFound()

  const snapshot = await transcriptQuery(getDb().collection(messagesPath(uid, projectId))).get()

  const messages = snapshot.docs
    .map((doc) => {
      const stored = parseStoredMessage(doc)
      return stored === null ? null : toMessage(doc.id, stored)
    })
    .filter((message): message is Message => message !== null)

  res.json({ messages })
}
