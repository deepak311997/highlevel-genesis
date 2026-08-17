import type { Request, Response } from 'express'
import type { DocumentSnapshot } from 'firebase-admin/firestore'

import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import { LIST_LIMIT, projectsPath, storedProjectSchema, toProject, type Project } from './schema'

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
 * Parse a snapshot into a project, or `null` when it cannot describe one.
 *
 * One function, so the list and the by-id read cannot disagree about what
 * "unusable" means: the list omits what this rejects and `GET` by id answers 404
 * for it, which is the same decision reached from two directions.
 */
function readProjectFrom(snapshot: DocumentSnapshot): Project | null {
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

  return toProject(snapshot.id, parsed.data)
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
