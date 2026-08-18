import type { Request, Response } from 'express'

import { getAdminAuth } from '../lib/firebase'
import { HttpError } from '../lib/errors'
import { logAuthEvent } from '../lib/log'
import { registerSchema } from './schema'
import { hashKey } from './throttle'

/**
 * `POST /auth/register`.
 *
 * The response is the point: `200 { ok: true }` whatever the state of the address,
 * because the client SDK's own `createUserWithEmailAndPassword` answers "does this
 * account exist?" on the wire. Moving creation here is the only way that answer
 * stops being available.
 *
 * **This endpoint sends no email at all**, which is what makes it airtight: an
 * earlier version mailed a different template per branch, so the branch was
 * observable to whoever held the mailbox. Verification is sent later, once the
 * user has signed in.
 *
 * It also never alters an account that already exists — two orderings of the
 * account pre-hijacking attack depend on that, and Firebase does not retire
 * outstanding verification codes.
 */
export async function handleRegister(req: Request, res: Response): Promise<void> {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    // Validation runs before any Auth call, so a password that misses the policy
    // is refused identically whether or not the address exists.
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? 'Check the details and try again.',
      'invalid_request',
    )
  }

  const { email, password } = parsed.data
  const emailHash = hashKey(email)

  // Create first and catch the collision rather than checking existence and then
  // creating: the check-then-act version races, and this way atomicity is
  // Firebase's problem.
  try {
    await getAdminAuth().createUser({ email, password, emailVerified: false })
  } catch (err) {
    if (!isEmailAlreadyExists(err)) throw err

    // Deliberately nothing. This request may be an attacker probing someone else's
    // address, and it must not change, resend or reveal anything about an account
    // it does not control.
  }

  // The branch taken is deliberately absent from this line: everything else about
  // the two paths is indistinguishable, and this would be the one place it survived.
  logAuthEvent('register.completed', { emailHash, outcome: 'ok' })
  res.json({ ok: true })
}

function isEmailAlreadyExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'auth/email-already-exists'
  )
}
