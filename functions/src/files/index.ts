import { Router } from 'express'

import { requireAppCheck } from '../auth/appCheck'
import { withVerifiedUser } from '../auth/requireUser'
import { asyncHandler } from '../lib/errors'
import { handleGetFile, handleListFiles, handlePutFile } from './handlers'

/**
 * A project's generated files — list, read, save (D19).
 *
 * **Its own router, not a branch of `projectsRouter`.** One module per
 * collection, matching `functions/src/{auth,hl,users,projects,messages}/`: Slice 3
 * reserved the `/api/projects/**` *URL* namespace, not the module, and keeping
 * the file a reviewer opens to answer "who can write a file" small is worth more
 * than co-locating by path prefix.
 *
 * **The routes name the resource, never the user.** The project id is checked
 * against a schema and the filename against `filePathSchema` before Firestore is
 * touched, and the *owner* half of the path comes from the verified token and
 * from nowhere else.
 *
 * **There is no `POST` and no `DELETE`.** F5.1 is exactly three verbs, and `PUT`
 * refuses to create — creating files by hand is not in scope, and refusing it
 * keeps the write surface to documents the generator made.
 *
 * **Middleware is attached per route, never with `router.use`.** This router is
 * mounted at both `/` and `/api` — the emulator strips the function name, a
 * Hosting rewrite does not — so router-level middleware would run twice for one
 * request. Every other router carries the same note.
 */
export const filesRouter: Router = Router()

const attested = asyncHandler(requireAppCheck)

// Reading is not attested: a plain authenticated read, and App Check buys nothing
// against a caller who already holds a valid ID token. The mutation is — one rule
// for the whole API, unchanged since Slice 2 (D28).
//
// `requireAppCheck` short-circuits under the emulator, so no emulator-backed test
// can observe the difference; which routes carry it is verified by reading these
// lines, and `index.spec.ts` scans them.
filesRouter.get('/projects/:projectId/files', asyncHandler(withVerifiedUser(handleListFiles)))
filesRouter.get('/projects/:projectId/files/:path', asyncHandler(withVerifiedUser(handleGetFile)))
filesRouter.put(
  '/projects/:projectId/files/:path',
  attested,
  asyncHandler(withVerifiedUser(handlePutFile)),
)
