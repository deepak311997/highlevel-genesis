import type { Request, Response } from 'express'
import { FieldValue, type DocumentSnapshot } from 'firebase-admin/firestore'
import { z } from 'zod'

import { CONNECTIONS } from '../hl/connection'
import { HttpError } from '../lib/errors'
import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import { parseBody } from '../lib/parse'
import {
  createProjectBodySchema,
  patchProjectBodySchema,
  LIST_LIMIT,
  normalizeName,
  PROJECT_LIMIT,
  projectIdSchema,
  projectsPath,
  storedProjectSchema,
  toProject,
  type Project,
  type StoredProject,
} from './schema'

/**
 * The caller's own projects.
 *
 * The uid is the one `withVerifiedUser` read off the ID token, and the document
 * path is built from it — `users/{uid}/projects/{id}` — so the collection is
 * scoped before a `where` clause is written and another user's project is not
 * addressable by a request. There is no `ownerUid` comparison in this file
 * because there is nothing for one to compare.
 */

/**
 * Parse a snapshot, or `null` when it cannot describe a project.
 *
 * One function, so the list and the by-id read cannot disagree about what
 * "unusable" means: the list omits what this rejects and `GET` by id answers 404
 * for it, which is the same decision reached from two directions.
 *
 * Exported for its own unit test rather than only through the routes: a corrupt
 * project is *silent* by design — omitted from the list, 404 by id, which from
 * outside is indistinguishable from a deleted one — so the log line is the only
 * warning anybody gets, and it deserves an assertion that does not need an
 * emulator to make.
 */
export function parseStored(snapshot: DocumentSnapshot): StoredProject | null {
  // An absent document is not corruption, so it is not logged as such.
  if (!snapshot.exists) return null

  const parsed = storedProjectSchema.safeParse(snapshot.data())
  if (!parsed.success) {
    /*
     * Fail closed, and say so in the log — the precedent runs through
     * `readProfile` and `handleGetConnection`. A half-populated project rendered
     * in a list is a row the user can click actions on and cannot fix. No field
     * of the document goes in the log line.
     */
    logAuthEvent('project.unreadable', { outcome: 'invalid' })
    return null
  }

  return parsed.data
}

function readProjectFrom(snapshot: DocumentSnapshot): Project | null {
  const stored = parseStored(snapshot)
  return stored === null ? null : toProject(snapshot.id, stored)
}

/**
 * The id from the path, or a refusal.
 *
 * Called as the **first statement** of every handler that takes one, so a
 * malformed id costs no Firestore call at all. `getDb().doc()` composes a path
 * by string concatenation: an id containing `/` changes the depth of the path
 * rather than the document it names, and `.` / `..` are ids Firestore refuses
 * outright.
 *
 * A malformed id and a stranger's id read identically to the caller. That is not
 * politeness — under this path shape they genuinely are the same answer.
 *
 * Exported for `messages/`, which owes a byte-identical `invalid_id` on a route
 * that carries the same `:projectId`. A second copy is how the two drift.
 */
export function requireProjectId(req: Request): string {
  const parsed = projectIdSchema.safeParse(req.params['projectId'])
  if (!parsed.success) {
    throw new HttpError(400, 'That project could not be found.', 'invalid_id')
  }
  return parsed.data
}

/**
 * The one 404, so no two handlers can describe the same state differently — now
 * including the message routes, which answer for the *project* being gone and
 * must say it in the same words.
 */
export function notFound(): HttpError {
  return new HttpError(404, 'That project no longer exists.', 'not_found')
}

/**
 * One project of the caller's, or `null` — absent, unreadable and soft-deleted
 * all collapse into the same answer.
 *
 * That collapse is what makes 404 mean the same thing in three handlers, and it
 * is also why a project belonging to somebody else is not a special case: the
 * path is composed from the token's uid, so another user's project is simply not
 * at any address this request can name.
 *
 * Exported and now shared with `messages/` (Slice 4, D14). "This project is
 * gone" has to mean the same thing one path segment deeper, so the message
 * routes reuse this definition rather than carrying a second one — absent,
 * soft-deleted and unreadable collapse identically there too.
 */
export async function readProject(uid: string, id: string): Promise<Project | null> {
  const snapshot = await getDb()
    .doc(`${projectsPath(uid)}/${id}`)
    .get()

  const stored = parseStored(snapshot)
  if (stored === null) return null
  // Soft-deleted reads as gone. D17: a rename of a deleted project is a 404
  // rather than a silent resurrection.
  if (stored.deletedAt !== null) return null

  return toProject(snapshot.id, stored)
}

/**
 * Live projects, newest-updated first, capped.
 *
 * The cap matches `POST`'s limit on live projects, so "you are seeing all of
 * your projects" is a guarantee rather than a hope — an unpaginated list is only
 * honest if it cannot truncate.
 *
 * `where('deletedAt','==',null)` matches documents whose field *is* null and
 * skips documents where it is absent, which is why the create path writes an
 * explicit `null` rather than omitting it.
 */
export async function handleListProjects(_req: Request, res: Response, uid: string): Promise<void> {
  const snapshot = await getDb()
    .collection(projectsPath(uid))
    .where('deletedAt', '==', null)
    .orderBy('updatedAt', 'desc')
    .limit(LIST_LIMIT)
    .get()

  const projects = snapshot.docs
    .map((doc) => readProjectFrom(doc))
    .filter((project): project is Project => project !== null)

  res.json({ projects })
}

/**
 * The caller's live projects, by id and name and nothing else.
 *
 * `select('name')` asks for one small field per document, so this is ~100 names
 * rather than ~100 documents, and `limit(PROJECT_LIMIT)` means a user with
 * thousands of soft-deleted projects still reads at most a hundred. Deliberately
 * not `count()`: the aggregation cannot carry the names, and the cap is what
 * makes reading them affordable — a hundred is the most there can ever be.
 *
 * One read answers both questions the write path has: how many are there, and is
 * one of them already called this. Read immediately before the write and not
 * transactional (D8): two simultaneous creates at 99 can both land, and two
 * simultaneous creates of the same name can both land — a guard-rail missing by
 * one rather than a boundary being crossed.
 */
async function liveProjects(uid: string): Promise<{ id: string; name: string }[]> {
  const snapshot = await getDb()
    .collection(projectsPath(uid))
    .where('deletedAt', '==', null)
    .limit(PROJECT_LIMIT)
    .select('name')
    .get()

  return snapshot.docs.map((doc) => {
    const stored: unknown = doc.get('name')
    // A corrupt document has no name to collide with; it is already invisible to
    // the list and 404 by id, so it cannot be what the user is looking at.
    return { id: doc.id, name: typeof stored === 'string' ? stored : '' }
  })
}

/**
 * The refusal a second project of the same name earns.
 *
 * 409 rather than 400: the body is well-formed and the name is one the user may
 * legitimately want — it is the *collection's* current state that refuses it,
 * which is the same shape of answer the project cap gives. The name is echoed
 * back because the dialog that issued the request shows this sentence whole, and
 * "that name" is ambiguous when the rename dialog is open over a list.
 */
function duplicateName(name: string): HttpError {
  return new HttpError(409, `You already have a project called “${name}”.`, 'duplicate_name')
}

/**
 * Is one of the caller's other live projects already called this?
 *
 * `exclude` is the project being renamed: without it every rename that leaves
 * the name alone — or changes only its capitals — would collide with itself.
 */
function nameTaken(
  existing: { id: string; name: string }[],
  name: string,
  exclude?: string,
): boolean {
  const wanted = normalizeName(name)
  return existing.some(
    (project) => project.id !== exclude && normalizeName(project.name) === wanted,
  )
}

/**
 * The location this project targets, snapshotted at create.
 *
 * Read from `hlConnections/{uid}` server-side and **never from the body** — the
 * same rule the profile's `email` follows: a field the server owns is not
 * accepted from a caller. Snapshotting is what "this project targets that
 * location" means, so reconnecting to a different location later does not
 * silently repoint existing projects.
 *
 * Absent, unconnected or unparseable all mean `null`. A project is creatable
 * without a connection at all (D10), so there is no failure to report here.
 */
async function resolveLocationId(uid: string): Promise<string | null> {
  const snapshot = await getDb().doc(`${CONNECTIONS}/${uid}`).get()
  const parsed = z.string().min(1).safeParse(snapshot.get('locationId'))
  return parsed.success ? parsed.data : null
}

/** Create a project owned, by construction, by the caller. */
export async function handleCreateProject(req: Request, res: Response, uid: string): Promise<void> {
  /*
   * Parsed **first**, before anything touches Firestore, so a refused body
   * writes nothing and costs no read. A body carrying `id`, `locationId`,
   * `createdAt` or `deletedAt` is rejected outright rather than silently
   * stripped, which is what makes "the server owns these fields" a property
   * rather than a promise.
   */
  const body = parseBody(createProjectBodySchema, req)

  const existing = await liveProjects(uid)

  if (existing.length >= PROJECT_LIMIT) {
    throw new HttpError(
      409,
      `You have reached the limit of ${String(PROJECT_LIMIT)} projects.`,
      'project_limit',
    )
  }

  // Before the connection read and before the write, so a refused name costs
  // neither and writes nothing.
  if (nameTaken(existing, body.name)) throw duplicateName(body.name)

  const locationId = await resolveLocationId(uid)

  // An auto-id, because a client-chosen one lets a caller probe for collisions
  // and pick ids that mean something. The ref is minted locally; nothing is
  // read to get it.
  const ref = getDb().collection(projectsPath(uid)).doc()

  await ref.set({
    name: body.name,
    description: body.description ?? null,
    locationId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    // Explicit, not omitted: `where('deletedAt','==',null)` skips documents
    // where the field is absent, so omitting it would create a project that is
    // invisible to its own list.
    deletedAt: null,
  })

  /*
   * Re-read rather than answer from what we wrote: `serverTimestamp()` is a
   * sentinel until it commits, so the committed document is the only place the
   * real timestamps exist.
   */
  const project = await readProject(uid, ref.id)
  if (project === null) {
    // Unreachable: we have just written a complete document. It fails closed
    // rather than answering a half-shaped project to a caller whose create
    // actually succeeded.
    logAuthEvent('project.unreadable', { outcome: 'invalid', detail: 'after create' })
    throw new HttpError(500, 'Internal error', 'internal')
  }

  res.status(201).json({ project })
}

/** One project, or the 404 that covers everything it could mean. */
export async function handleGetProject(req: Request, res: Response, uid: string): Promise<void> {
  const id = requireProjectId(req)

  const project = await readProject(uid, id)
  if (project === null) throw notFound()

  res.json({ project })
}

/**
 * Rename a project, change its description, or both.
 *
 * `PATCH` rather than `PUT` because the update is genuinely partial: a rename
 * need not resend the description, and clearing the description need not resend
 * the name.
 *
 * Deliberately not transactional (P2). The document has one writer — its owner,
 * through this route — so the read-then-update buys nothing a transaction would,
 * and `handlePutProfile`'s transaction exists for a different reason: two tabs
 * racing to *create* the same document.
 */
export async function handlePatchProject(req: Request, res: Response, uid: string): Promise<void> {
  const id = requireProjectId(req)

  /*
   * Body before read, so a refused body costs no Firestore call and writes
   * nothing — including an `updatedAt` that would reorder the list for a request
   * that changed nothing.
   */
  const body = parseBody(patchProjectBodySchema, req)

  const current = await readProject(uid, id)
  if (current === null) throw notFound()

  /*
   * Only when the name is actually changing shape. Renaming `sample` to
   * `Sample` is a rename of *this* project, so it is compared against the
   * others and not against itself — which `exclude` is what guarantees.
   */
  if (
    'name' in body &&
    body.name !== undefined &&
    normalizeName(body.name) !== normalizeName(current.name)
  ) {
    if (nameTaken(await liveProjects(uid), body.name, id)) throw duplicateName(body.name)
  }

  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  /*
   * Present-versus-absent, not truthy-versus-falsy. An explicit `null` clears
   * the description; an absent key leaves whatever is stored alone. Collapsing
   * the two would make every rename wipe the description.
   */
  if ('name' in body) patch['name'] = body.name
  if ('description' in body) patch['description'] = body.description ?? null

  await getDb()
    .doc(`${projectsPath(uid)}/${id}`)
    .update(patch)

  // Re-read, because `serverTimestamp()` is a sentinel until it commits.
  const project = await readProject(uid, id)
  if (project === null) {
    logAuthEvent('project.unreadable', { outcome: 'invalid', detail: 'after patch' })
    throw new HttpError(500, 'Internal error', 'internal')
  }

  res.json({ project })
}

/**
 * Soft-delete, idempotently.
 *
 * **This handler never parses the stored document** (P3). Every other read goes
 * through `readProject`, but a project that fails to parse must still be
 * deletable — parsing here would make D16's "always 200" a lie for exactly the
 * projects a user most wants gone, and leave a corrupt document with no way out
 * of the collection.
 *
 * Idempotent because the UI cannot be certain of its own staleness: a second
 * tab, a double click, a retry after a timeout. Answering 404 to any of those
 * puts an error on screen for a user who already has what they asked for — the
 * same reasoning as `handleDeleteConnection`.
 *
 * A second delete writes nothing at all, so the first `deletedAt` stands and
 * "when was this deleted" stays true.
 */
export async function handleDeleteProject(req: Request, res: Response, uid: string): Promise<void> {
  const id = requireProjectId(req)
  const ref = getDb().doc(`${projectsPath(uid)}/${id}`)
  const snapshot = await ref.get()

  const deletedAt: unknown = snapshot.get('deletedAt')
  const alreadyDeleted = deletedAt !== null && deletedAt !== undefined

  if (snapshot.exists && !alreadyDeleted) {
    await ref.update({
      deletedAt: FieldValue.serverTimestamp(),
      // The data model says `updatedAt` advances on every accepted mutation,
      // and a delete is one (P4).
      updatedAt: FieldValue.serverTimestamp(),
    })
  }

  res.json({ ok: true })
}
