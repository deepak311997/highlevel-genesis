import type { Request, Response } from 'express'
import type { DocumentSnapshot, Query } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'

import { stageFileWrites, type FileWritePlan } from '../files/handlers'
import { HttpError } from '../lib/errors'
import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import { parseBody } from '../lib/parse'
import { notFound, readProject, requireProjectId } from '../projects/handlers'
import { stageSnapshot, type SnapshotPlan } from '../snapshots/handlers'
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

/**
 * The transcript, parsed and ordered — **one definition, two readers.**
 *
 * `handleListMessages` answers with this and `/generate` builds the model's
 * context from it, so the corrupt-document filtering the LLM sees is
 * byte-identical to the one the browser sees. Two copies would be two answers to
 * "what is in this transcript", and the one that drifted would be the one
 * deciding what the model is told.
 */
export async function readTranscript(uid: string, projectId: string): Promise<Message[]> {
  const snapshot = await transcriptQuery(getDb().collection(messagesPath(uid, projectId))).get()

  return snapshot.docs
    .map((doc) => {
      const stored = parseStoredMessage(doc)
      return stored === null ? null : toMessage(doc.id, stored)
    })
    .filter((message): message is Message => message !== null)
}

/** A project's messages, oldest first, capped — or the 404 the project earns. */
export async function handleListMessages(req: Request, res: Response, uid: string): Promise<void> {
  const projectId = requireProjectId(req)

  // The project first, and its answer is the whole of "gone" (D14). A transcript
  // is not addressable without one, so there is nothing to read past this.
  if ((await readProject(uid, projectId)) === null) throw notFound()

  res.json({ messages: await readTranscript(uid, projectId) })
}

/** The user's turn is 0 and the assistant's is 1, within a turn. */
const USER_SEQ = 0
const ASSISTANT_SEQ = 1

/**
 * Re-read a document just written, or fail closed.
 *
 * `serverTimestamp()` is a sentinel until it commits, so the committed document
 * is the only place the real timestamp exists — answering from what we wrote
 * would put a sentinel where an ISO-8601 string belongs. The `null` branch is
 * unreachable: a complete document has just been written. It exists so a
 * half-written turn is an error rather than a response describing a message that
 * cannot be read back.
 */
function readBackOrFail(snapshot: DocumentSnapshot, detail: string): Message {
  const stored = parseStoredMessage(snapshot)
  if (stored === null) {
    logAuthEvent('message.unreadable', { outcome: 'invalid', detail })
    throw new HttpError(500, 'Internal error', 'internal')
  }
  return toMessage(snapshot.id, stored)
}

/**
 * The assistant turn **and the turn's files**, in one batch (D11).
 *
 * Called by `/generate` and nowhere else, on every terminal path that produced
 * text — `done`, a mid-stream failure carrying a partial, and a client that
 * disconnected (D21, D22, D23). The `truncated` flag is the caller's to decide,
 * because only the caller knows *why* the stream ended.
 *
 * **One `WriteBatch` per turn**, and the message is why it is owned here rather
 * than in `files/`: the message contains `[file: index.html]`, so if that commits
 * and the file does not, the transcript is lying about the project's contents.
 * The message is the turn's anchor and the files hang off it (P7). Twenty-one
 * writes at the cap — one message, twenty files — is far inside Firestore's 500.
 *
 * A batch resolves every `serverTimestamp()` in it to one commit timestamp, which
 * was Slice 4's hazard (R1). It is harmless here: the message keeps its `seq: 1`,
 * and the files live in a different collection ordered by name.
 *
 * The re-read still happens and still happens **after** the commit, because
 * `serverTimestamp()` is a sentinel until then — so the committed document is the
 * only place the real timestamp exists.
 *
 * **The turn is one object, not five positional parameters** (R10). The list was
 * `(uid, projectId, content, truncated, fileWrites)` and Slice 11 adds a sixth;
 * at that width a call reads as `(…, text, false, [], null)`, where a value in
 * the wrong slot is caught only if its neighbours happen to have different
 * types. The two path segments stay positional because they are what *addresses*
 * the write; everything that *is* the turn goes in the object.
 *
 * `seq` is 1 (D35). Both halves of a turn are written in requests of their own,
 * so their `createdAt` values genuinely differ and `seq` is belt and braces
 * rather than the tiebreak it was in Slice 4 — but the transcript query still
 * reads it, and every transcript written before this slice still needs it.
 */
export interface AssistantTurn {
  content: string
  truncated: boolean
  fileWrites: readonly FileWritePlan[]
  /**
   * The turn's snapshot, or `null` when it stored no files (D2, D4).
   *
   * Staged on this batch rather than committed after it, which is the whole of
   * R5: writing the snapshot in its own commit afterwards is one line shorter
   * and leaves a crash window in which the project's files moved and its history
   * did not — a version list that is silently missing the version you are
   * looking at.
   */
  snapshot: SnapshotPlan | null
}

export async function appendAssistantMessage(
  uid: string,
  projectId: string,
  turn: AssistantTurn,
): Promise<Message> {
  // Auto-id, minted locally: nothing is read to get it.
  const ref = getDb().collection(messagesPath(uid, projectId)).doc()
  const batch = getDb().batch()

  batch.set(ref, {
    role: 'assistant',
    content: turn.content,
    seq: ASSISTANT_SEQ,
    createdAt: FieldValue.serverTimestamp(),
    truncated: turn.truncated,
  })

  stageFileWrites(batch, uid, projectId, turn.fileWrites)
  // D4, R5. On the turn's own batch, so the files and the history cannot part
  // company across a crash.
  if (turn.snapshot !== null) stageSnapshot(batch, turn.snapshot)

  await batch.commit()

  return readBackOrFail(await ref.get(), 'after append')
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
 * Write the user's turn, and answer with it.
 *
 * In order: the id, then the body, then the project, then the count, then one
 * write. **Parsing before reading** is `handleCreateProject`'s rule and it is
 * load-bearing twice over — a refused body costs no Firestore call, and a body
 * carrying `role` is refused before anything could have acted on it (D5).
 *
 * **One document, and the reply is somebody else's job now** (D3). Slice 4 wrote
 * the pair in one `WriteBatch` so a prompt could never be stranded without its
 * echo; the reply is now a real generation, and it is written by `/generate` at
 * the stream's terminal event. Splitting the turn across two requests is what
 * gives F8.2 its property: the user's prompt is durable *before* the expensive,
 * failure-prone half begins, so a generation that dies before producing a byte
 * still leaves a transcript the user recognises and a Retry that works.
 *
 * The response keeps the array shape with one element in it (D4), so the store's
 * append is unchanged.
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
   * **Still `+ 2`, even though only one document is written here** (D4). The
   * refusal is about the *pair*: the reply this `POST` is about to make the user
   * trigger needs room, and refusing at 199 is what stops a transcript ending on
   * a prompt with nowhere to put its answer. Read immediately before the write
   * and not transactional, as `liveProjectCount` is — two simultaneous sends at
   * 198 can both land, which is a guard-rail missing by one rather than a
   * boundary being crossed.
   */
  if ((await messageCount(uid, projectId)) + 2 > MESSAGE_LIMIT) {
    throw new HttpError(
      409,
      `This project has reached its limit of ${String(MESSAGE_LIMIT)} messages.`,
      'message_limit',
    )
  }

  // Auto-id, minted locally: nothing is read to get it.
  const ref = getDb().collection(messagesPath(uid, projectId)).doc()

  await ref.set({
    role: 'user',
    content: body.content,
    seq: USER_SEQ,
    createdAt: FieldValue.serverTimestamp(),
    truncated: false,
  })

  res.status(201).json({ messages: [readBackOrFail(await ref.get(), 'after create')] })
}
