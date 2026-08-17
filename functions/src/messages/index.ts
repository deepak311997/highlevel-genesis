import { Router } from 'express'

import { asyncHandler } from '../lib/errors'
import { requireAppCheck } from '../auth/appCheck'
import { withVerifiedUser } from '../auth/requireUser'
import { handleCreateMessage, handleListMessages } from './handlers'

/**
 * A project's chat transcript.
 *
 * **Its own router, not a branch of `projectsRouter`** (D4). One module per
 * collection, matching `functions/src/{auth,hl,users,projects}/`: Slice 3 reserved
 * the `/api/projects/**` *URL* namespace, not the module, and keeping the file a
 * reviewer opens to answer "who can write a message" small is worth more than
 * co-locating by path prefix.
 *
 * **The routes name the resource, never the user.** The project id is checked
 * against a schema before Firestore is touched, and the *owner* half of the path
 * comes from the verified token and from nowhere else.
 *
 * **Middleware is attached per route, never with `router.use`.** This router is
 * mounted at both `/` and `/api` — the emulator strips the function name, a
 * Hosting rewrite does not — so router-level middleware would run twice for one
 * request. Every other router carries the same note.
 */
export const messagesRouter: Router = Router()

const attested = asyncHandler(requireAppCheck)

// Reading is not attested: a plain authenticated read, and App Check buys nothing
// against a caller who already holds a valid ID token. Mutations are — one rule
// for the whole API, unchanged since Slice 2 (D28).
//
// `requireAppCheck` short-circuits under the emulator, so no emulator-backed test
// can observe the difference; which routes carry it is verified by reading these
// lines, and the plan says so rather than pretending otherwise.
messagesRouter.get(
  '/projects/:projectId/messages',
  asyncHandler(withVerifiedUser(handleListMessages)),
)
messagesRouter.post(
  '/projects/:projectId/messages',
  attested,
  asyncHandler(withVerifiedUser(handleCreateMessage)),
)
