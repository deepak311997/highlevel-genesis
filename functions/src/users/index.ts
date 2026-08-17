import { Router } from 'express'

import { asyncHandler } from '../lib/errors'
import { handleGetProfile, handlePutProfile } from './profile'
import { requireAppCheck } from '../auth/appCheck'
import { withVerifiedUser } from '../auth/requireUser'

/**
 * The user's own profile.
 *
 * **The path is the literal `me`, never `/users/:uid`.** The trap named for this
 * slice is a route that authenticates its caller and then trusts a uid it was
 * handed, and an equality check against the token is exactly the line that gets
 * copied into the next route without its guard. With no parameter there is
 * nothing to check and nothing to forget: another user's id is not expressible
 * in the request at all.
 *
 * **Middleware is attached per route, never with `router.use`.** This router is
 * mounted at both `/` and `/api` — the emulator strips the function name, a
 * Hosting rewrite does not — so router-level middleware would run twice for one
 * request. `authRouter` and `hlRouter` carry the same note.
 *
 * `/api/users/**` is reserved for user-scoped resources.
 */
export const usersRouter: Router = Router()

const attested = asyncHandler(requireAppCheck)

// Reading is not attested: it is a plain authenticated read, and App Check buys
// nothing against a caller who already holds a valid ID token. Mutations are —
// one rule for the whole API, matching `GET` and `DELETE /hl/connection`.
//
// `PUT` rather than `POST /users/ensure`: create-if-absent, touch-if-present is
// idempotent, which is exactly what the verb means, and a procedure wearing a
// URL is not.
usersRouter.get('/users/me', asyncHandler(withVerifiedUser(handleGetProfile)))
usersRouter.put('/users/me', attested, asyncHandler(withVerifiedUser(handlePutProfile)))
