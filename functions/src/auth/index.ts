import { Router } from 'express'

import { asyncHandler } from '../lib/errors'
import { handleRegister } from './register'

/**
 * The auth endpoints.
 *
 * These exist because the Firebase client SDK cannot implement a
 * non-disclosing registration: it reports `EMAIL_EXISTS` on the wire, so any
 * branching done in the browser is visible to whoever is asking. Everything
 * that must not vary by account state runs here instead.
 */
export const authRouter: Router = Router()

authRouter.post('/auth/register', asyncHandler(handleRegister))
