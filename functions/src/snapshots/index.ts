import { Router } from 'express'

import { withVerifiedUser } from '../auth/requireUser'
import { asyncHandler } from '../lib/errors'
import { handleListSnapshots } from './handlers'

/**
 * A project's version history — list, and restore.
 *
 * **Its own router, not a branch of `projectsRouter` or `filesRouter`.** One
 * module per collection, matching `functions/src/{auth,hl,users,projects,messages,files}/`:
 * keeping the file a reviewer opens to answer "who can roll a project back" small
 * is worth more than co-locating by path prefix.
 *
 * **The routes name the resource, never the user.** A project id and a version id
 * are both checked against a schema before Firestore is touched, and the *owner*
 * half of every path comes from the verified token and from nowhere else.
 *
 * **There is no `DELETE` and no `POST` that creates.** A version is written by
 * the writers — `/generate`'s batch, and the restore's safety snapshot — and
 * pruned by the cap. Letting a client mint or remove one would make the history a
 * thing the user maintains rather than a thing that is simply true.
 *
 * **Middleware is attached per route, never with `router.use`.** This router is
 * mounted at both `/` and `/api` — the emulator strips the function name, a
 * Hosting rewrite does not — so router-level middleware would run twice for one
 * request. Every other router carries the same note.
 */
export const snapshotsRouter: Router = Router()

// Reading is not attested: a plain authenticated read, and App Check buys nothing
// against a caller who already holds a valid ID token (D28).
//
// `requireAppCheck` short-circuits under the emulator, so no emulator-backed test
// can observe the difference; which routes carry it is verified by reading these
// lines, and `index.spec.ts` scans them.
snapshotsRouter.get(
  '/projects/:projectId/snapshots',
  asyncHandler(withVerifiedUser(handleListSnapshots)),
)
