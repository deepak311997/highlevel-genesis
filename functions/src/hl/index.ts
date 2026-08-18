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
 * Three of the four are authenticated and check both that an ID token is present
 * and that `email_verified` is true. The fourth, the OAuth callback, cannot be:
 * HighLevel redirects a browser to it and there is no session on that request. Its
 * protection is the encrypted `state`.
 *
 * **Middleware is attached per route, never with `router.use`.** This router is
 * mounted at both `/` and `/api`, and router-level middleware matches on prefix,
 * so it would run twice for a single request. **App Check runs before the user
 * check**, so a request that cannot prove it came from our app is refused before
 * it costs a token verification.
 */
export const hlRouter: Router = Router()

const attested = asyncHandler(requireAppCheck)

// Unauthenticated by necessity: the encrypted state is the authorisation, and App
// Check has nothing to attest on a navigation another company's server started.
hlRouter.get('/oauth/callback', asyncHandler(handleCallback))

hlRouter.post('/hl/connect', attested, asyncHandler(withVerifiedUser(handleConnect)))

// Reading status is not attested — it is a plain authenticated read the dashboard
// issues on every visit, and App Check buys nothing against a caller who already
// holds a valid ID token. Deleting is attested, because it is destructive.
hlRouter.get('/hl/connection', asyncHandler(withVerifiedUser(handleGetConnection)))
hlRouter.delete('/hl/connection', attested, asyncHandler(withVerifiedUser(handleDeleteConnection)))

/**
 * The proxy — every method, and the bare subtree.
 *
 * A **pathful** `router.use` rather than `router.all` or a pathless `use`. Pathless
 * would run twice, since this router is mounted at both `/` and `/api`.
 * `router.all` would need a second line for the bare path and would still miss any
 * method with no `router.<verb>` — and a `DELETE` here must be refused with `403
 * route_not_allowed`, not fall through to the app's 404.
 *
 * **App Check on this route cannot be observed by an emulator-backed test**:
 * `requireAppCheck` short-circuits under the emulator and there is no App Check
 * emulator. `index.spec.ts` drives this router over a socket with the middleware
 * replaced by one that refuses, so deleting `attested` fails six cases rather than
 * none. It is also why the preview's shim fetches from the parent: a `srcdoc`
 * iframe has an opaque origin and cannot mint an App Check token.
 */
hlRouter.use('/hl/proxy', attested, asyncHandler(withVerifiedUser(handleProxy)))

/**
 * The stand-in for HighLevel, mounted last and only under the emulator.
 * `buildFakeHlRouter` returns an empty router otherwise, so there is nothing to
 * reach in a deployed build even if this line is read out of context.
 */
hlRouter.use(buildFakeHlRouter(isEmulator()))
