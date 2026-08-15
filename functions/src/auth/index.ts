import { Router } from 'express'

import { asyncHandler } from '../lib/errors'
import { deleteExpiredUnverifiedUsers } from './cleanup'
import { isEmulator } from '../lib/env'
import { handleRegister } from './register'
import { throttleAuthRequest } from './throttleGuard'

/**
 * The auth endpoint.
 *
 * Only registration lives server-side, and only because the Firebase client
 * SDK cannot implement it without disclosure: it reports `EMAIL_EXISTS` on the
 * wire, so any branching done in the browser is visible to whoever is asking.
 *
 * Everything else — sign-in, sign-out, verification email, password reset — is
 * client SDK. Firebase sends those emails itself, and with email-enumeration
 * protection enabled `sendPasswordResetEmail` does not disclose either, so
 * routing them through here would add a hop and buy nothing.
 *
 * The throttle is attached per route rather than with `router.use`. This router
 * is mounted at both `/` and `/api` — for the emulator and for the Hosting
 * rewrite — and router-level middleware matches on prefix, so it would run
 * twice for a single request and count every attempt double.
 */
export const authRouter: Router = Router()

const throttled = asyncHandler(throttleAuthRequest)

authRouter.post('/auth/register', throttled, asyncHandler(handleRegister))

/**
 * Test-only door onto the scheduled sweep.
 *
 * The emulator has no scheduler, so the integration suite has no other way to
 * exercise the cleanup end to end. Gated on emulator detection — the same
 * signal that selects the fake mail transport, and the one an operator cannot
 * set — so this route does not exist in a deployed build. It also takes `now`
 * as input, which is exactly why it must never be reachable in production.
 */
if (isEmulator()) {
  authRouter.post(
    '/auth/__test/cleanup',
    asyncHandler(async (req, res) => {
      const body: unknown = req.body
      const now =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { now?: unknown }).now === 'number'
          ? (body as { now: number }).now
          : Date.now()

      res.json({ deleted: await deleteExpiredUnverifiedUsers(now) })
    }),
  )
}
