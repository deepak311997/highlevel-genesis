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
  LIST_LIMIT,
  PROJECT_LIMIT,
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
 */
function parseStored(snapshot: DocumentSnapshot): StoredProject | null {
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
 * One project of the caller's, or `null` — absent, unreadable and soft-deleted
 * all collapse into the same answer.
 *
 * That collapse is what makes 404 mean the same thing in three handlers, and it
 * is also why a project belonging to somebody else is not a special case: the
 * path is composed from the token's uid, so another user's project is simply not
 * at any address this request can name.
 */
async function readProject(uid: string, id: string): Promise<Project | null> {
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
 * How many live projects the caller holds, up to the cap.
 *
 * `select()` with no arguments asks for document references and no field data,
 * so this is ~100 refs rather than ~100 documents, and `limit(PROJECT_LIMIT)`
 * means a user with thousands of soft-deleted projects still reads at most a
 * hundred. Deliberately not `count()`: the aggregation buys nothing here and
 * adds a question about emulator support.
 *
 * Read immediately before the write and not transactional (D8): two simultaneous
 * creates at 99 can both land, which is a guard-rail missing by one rather than
 * a boundary being crossed.
 */
async function liveProjectCount(uid: string): Promise<number> {
  const snapshot = await getDb()
    .collection(projectsPath(uid))
    .where('deletedAt', '==', null)
    .limit(PROJECT_LIMIT)
    .select()
    .get()

  return snapshot.size
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

  if ((await liveProjectCount(uid)) >= PROJECT_LIMIT) {
    throw new HttpError(
      409,
      `You have reached the limit of ${String(PROJECT_LIMIT)} projects.`,
      'project_limit',
    )
  }

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
