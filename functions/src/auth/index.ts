import { Router } from 'express'

import { asyncHandler } from '../lib/errors'
import { handleRegister } from './register'
import { handlePasswordReset, handleResend } from './resend'
import { throttleAuthRequest } from './throttleGuard'

/**
 * The auth endpoints.
 *
 * These exist because the Firebase client SDK cannot implement a
 * non-disclosing registration: it reports `EMAIL_EXISTS` on the wire, so any
 * branching done in the browser is visible to whoever is asking. Everything
 * that must not vary by account state runs here instead.
 *
 * The throttle is attached per route rather than with `router.use`. This router
 * is mounted at both `/` and `/api` — for the emulator and for the Hosting
 * rewrite — and router-level middleware matches on prefix, so it would run
 * twice for a single request and count every attempt double.
 */
export const authRouter: Router = Router()

const throttled = asyncHandler(throttleAuthRequest)

authRouter.post('/auth/register', throttled, asyncHandler(handleRegister))
authRouter.post('/auth/resend', throttled, asyncHandler(handleResend))
authRouter.post('/auth/password-reset', throttled, asyncHandler(handlePasswordReset))
