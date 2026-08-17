import { Router } from 'express'

import { asyncHandler } from '../lib/errors'
import { handleCallback } from './callback'
import { handleConnect } from './connect'
import { handleDeleteConnection, handleGetConnection } from './connection'
import { buildFakeHlRouter } from './fake'
import { handleProxy } from './proxy'
import { isEmulator } from '../lib/env'
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
 * `/api/hl/proxy/**` takes the subtree Slice 2 reserved, and forwards arbitrary
 * HighLevel paths from the allowlist. Without that reservation a HighLevel path
 * segment could one day shadow a management route here.
 */
export const hlRouter: Router = Router()

const attested = asyncHandler(requireAppCheck)

// Unauthenticated by necessity: HighLevel redirects a browser here and
// there is no session on the request. The encrypted state is the
// authorisation, and App Check has nothing to attest on a top-level
// navigation initiated by another company's server.
hlRouter.get('/oauth/callback', asyncHandler(handleCallback))

hlRouter.post('/hl/connect', attested, asyncHandler(withVerifiedUser(handleConnect)))

// Reading status is not attested: it is a plain authenticated read the
// dashboard issues on every visit, and App Check buys nothing against a
// caller who already holds a valid ID token. Deleting is attested, because
// it is destructive.
hlRouter.get('/hl/connection', asyncHandler(withVerifiedUser(handleGetConnection)))
hlRouter.delete('/hl/connection', attested, asyncHandler(withVerifiedUser(handleDeleteConnection)))

/**
 * The proxy — every method, and the bare subtree (P2, AC-23).
 *
 * A **pathful** `router.use` rather than a `router.all` or a pathless `use`, and
 * each half of that matters. Pathless would run twice, because this router is
 * mounted at both `/` and `/api`; with a path it matches under exactly one of
 * them. `router.all` would need a second line for the bare `/hl/proxy` and would
 * still miss any method with no `router.<verb>` — and a `DELETE` here must be
 * refused with `403 route_not_allowed`, not fall through to the app's 404.
 *
 * Above the fake, and clear of `/__fake-hl`, so the order of these two lines is
 * not load-bearing. `cors()` answers preflight `OPTIONS` ahead of the router, so
 * no `OPTIONS` reaches the matcher.
 *
 * **App Check on this route cannot be observed by an emulator-backed test**:
 * `requireAppCheck` short-circuits under `FUNCTIONS_EMULATOR` and there is no
 * App Check emulator to stand in for it, so AC-19 is covered by
 * `auth/appCheck.spec.ts` plus a reading of this line. `projects/index.ts`
 * carries the same note. It is also the constraint Slice 10 inherits (D16): a
 * `srcdoc` iframe has an opaque origin and cannot mint an App Check token, so
 * the shim's fetch has to happen in the parent.
 */
hlRouter.use('/hl/proxy', attested, asyncHandler(withVerifiedUser(handleProxy)))

/**
 * The stand-in for HighLevel, mounted last and only under the emulator.
 * `buildFakeHlRouter` returns an empty router otherwise, so there is nothing to
 * reach in a deployed build even if this line is read out of context.
 */
hlRouter.use(buildFakeHlRouter(isEmulator()))
