import { Router } from 'express'

import { asyncHandler } from '../lib/errors'
import { handleConnect } from './connect'
import { requireAppCheck } from '../auth/appCheck'
import { withVerifiedUser } from '../auth/requireUser'

/**
 * The HighLevel connection endpoints.
 *
 * Three of the four routes here are authenticated and check **both** that an ID
 * token is present and that `email_verified` is true — Slice 1's D26. The
 * fourth, the OAuth callback, cannot be: HighLevel redirects a browser to it
 * and there is no session on that request. Its protection is the encrypted
 * `state` instead.
 *
 * ## Two pieces of wiring that look redundant and are not
 *
 * **Middleware is attached per route, never with `router.use`.** This router is
 * mounted at both `/` and `/api` — the emulator strips the function name, a
 * Hosting rewrite does not — and router-level middleware matches on prefix, so
 * it would run twice for a single request. `authRouter` carries the same note
 * for the same reason.
 *
 * **App Check runs before the user check.** A request that cannot prove it came
 * from our app should be refused before it costs a token verification, and the
 * ordering matches the auth router so there is one rule to remember rather than
 * two.
 *
 * `/api/hl/proxy/**` is reserved for Slice 8, which forwards arbitrary
 * HighLevel paths. Without that reservation a HighLevel path segment could one
 * day shadow a management route here.
 */
export const hlRouter: Router = Router()

const attested = asyncHandler(requireAppCheck)

hlRouter.post('/hl/connect', attested, asyncHandler(withVerifiedUser(handleConnect)))
