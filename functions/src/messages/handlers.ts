import type { Request, Response } from 'express'
import type { DocumentData, DocumentSnapshot, Query } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'

import { HttpError } from '../lib/errors'
import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import { parseBody } from '../lib/parse'
import { notFound, readProject, requireProjectId } from '../projects/handlers'
import {
  createMessageBodySchema,
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

/**
 * The stub assistant, in full (D7).
 *
 * Deterministic, no LLM, no randomness: it has to be assertable byte-for-byte and
 * obviously not intelligence when a human looks at it. The chat panel says the
 * same thing out loud with an `Echo mode` badge, and the two disappear together in
 * Slice 5 — this function and the badge are the whole of what that slice deletes
 * from the reply path.
 */
export function echoFor(content: string): string {
  return `You said: ${content}`
}

/**
 * The two documents of one turn.
 *
 * `now` is injected rather than read here, so this is pure and testable — and so
 * that the two documents demonstrably carry the *same* timestamp value. That
 * sharing is not a shortcut: a `WriteBatch` resolves every `serverTimestamp()`
 * sentinel in it to one commit timestamp whatever we pass, so writing it this way
 * makes the tie visible where it is created rather than a surprise where it is
 * read. `seq` is what orders them, and it is assigned here because the timestamps
 * cannot do it.
 */
export function messagePair(content: string, now: FieldValue): [DocumentData, DocumentData] {
  return [
    { role: 'user', content, seq: 0, createdAt: now },
    { role: 'assistant', content: echoFor(content), seq: 1, createdAt: now },
  ]
}

/**
 * How many messages the project already holds, up to the cap.
 *
 * `select()` with no arguments asks for document references and no field data, so
 * this is ~200 refs rather than ~200 documents. `liveProjectCount`'s shape, and
 * deliberately not `count()` for the same reason: the aggregation buys nothing
 * here and adds a question about emulator support.
 */
async function messageCount(uid: string, projectId: string): Promise<number> {
  const snapshot = await getDb()
    .collection(messagesPath(uid, projectId))
    .limit(MESSAGE_LIMIT)
    .select()
    .get()

  return snapshot.size
}

/**
 * Write the user's turn and the stub reply, and answer with both.
 *
 * In order: the id, then the body, then the project, then the count, then one
 * batch. **Parsing before reading** is `handleCreateProject`'s rule and it is
 * load-bearing twice over — a refused body costs no Firestore call, and a body
 * carrying `role` is refused before anything could have acted on it (D5).
 *
 * The pair is one `WriteBatch` (D6), so a user message can never be stranded
 * without its reply. This contract changes in Slice 5 and knowingly: the assistant
 * write moves to the stream's `done` handler, the user write stays exactly here,
 * and the response becomes the user message alone.
 *
 * The project document is deliberately **not** touched (D15). `updatedAt` means
 * "the project's own fields changed", which is what the dashboard's ordering and
 * its "Updated" line both claim.
 */
export async function handleCreateMessage(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)
  const body = parseBody(createMessageBodySchema, req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  /*
   * The refusal is about the *pair*, not about one message: storing both is what
   * the request asks for, so 198 stored succeeds and lands on exactly the cap,
   * and 199 is refused because only half a turn would fit. Read immediately
   * before the write and not transactional, as `liveProjectCount` is — two
   * simultaneous sends at 198 can both land, which is a guard-rail missing by one
   * rather than a boundary being crossed.
   */
  if ((await messageCount(uid, projectId)) + 2 > MESSAGE_LIMIT) {
    throw new HttpError(
      409,
      `This project has reached its limit of ${String(MESSAGE_LIMIT)} messages.`,
      'message_limit',
    )
  }

  const collection = getDb().collection(messagesPath(uid, projectId))
  // Auto-ids, minted locally: nothing is read to get them.
  const userRef = collection.doc()
  const assistantRef = collection.doc()

  const [userDoc, assistantDoc] = messagePair(body.content, FieldValue.serverTimestamp())
  const batch = getDb().batch()
  batch.set(userRef, userDoc)
  batch.set(assistantRef, assistantDoc)
  await batch.commit()

  /*
   * Re-read rather than answer from what we wrote: `serverTimestamp()` is a
   * sentinel until it commits, so the committed documents are the only place the
   * real timestamps exist. `getAll` fetches both in one round trip.
   */
  const snapshots = await getDb().getAll(userRef, assistantRef)
  const messages = snapshots
    .map((snapshot) => {
      const stored = parseStoredMessage(snapshot)
      return stored === null ? null : toMessage(snapshot.id, stored)
    })
    .filter((message): message is Message => message !== null)

  if (messages.length !== 2) {
    // Unreachable: we have just written two complete documents. It fails closed
    // rather than answering half a turn to a caller whose send actually succeeded.
    logAuthEvent('message.unreadable', { outcome: 'invalid', detail: 'after create' })
    throw new HttpError(500, 'Internal error', 'internal')
  }

  res.status(201).json({ messages })
}
