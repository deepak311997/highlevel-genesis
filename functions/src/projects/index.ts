import { Router } from 'express'

import { asyncHandler } from '../lib/errors'
import { handleCreateProject, handleGetProject, handleListProjects } from './handlers'
import { requireAppCheck } from '../auth/appCheck'
import { withVerifiedUser } from '../auth/requireUser'

/**
 * The caller's projects.
 *
 * **The routes name the resource, never the user.** A project needs an id in its
 * path — that is what separates this from `/api/profile` — so the discipline
 * moves one step in: the id is checked against a schema before Firestore is
 * touched, and the *owner* half of the path comes from the verified token and
 * from nowhere else. A caller can name a document; it cannot name a user.
 *
 * **Middleware is attached per route, never with `router.use`.** This router is
 * mounted at both `/` and `/api` — the emulator strips the function name, a
 * Hosting rewrite does not — so router-level middleware would run twice for one
 * request. `authRouter`, `hlRouter` and `usersRouter` carry the same note.
 *
 * `/api/projects/**` is reserved here for project-scoped resources — files,
 * messages and snapshots arrive under it in later slices.
 */
export const projectsRouter: Router = Router()

const attested = asyncHandler(requireAppCheck)

// Reading is not attested: a plain authenticated read, and App Check buys
// nothing against a caller who already holds a valid ID token. Mutations are —
// one rule for the whole API, unchanged since Slice 2.
//
// `requireAppCheck` short-circuits under the emulator, so no emulator-backed
// test can observe the difference; which routes carry `attested` is verified by
// reading these lines, and the plan says so rather than pretending otherwise.
projectsRouter.get('/projects', asyncHandler(withVerifiedUser(handleListProjects)))
projectsRouter.post('/projects', attested, asyncHandler(withVerifiedUser(handleCreateProject)))
projectsRouter.get('/projects/:projectId', asyncHandler(withVerifiedUser(handleGetProject)))
