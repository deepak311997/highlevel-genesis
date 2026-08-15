import type { Request, Response } from 'express'

import { getAdminAuth } from '../lib/firebase'
import { HttpError } from '../lib/errors'
import { logAuthEvent } from '../lib/log'
import { registerSchema } from './schema'
import { hashKey } from './throttle'

/**
 * `POST /auth/register`.
 *
 * The response is the point. It is `200 { ok: true }` whatever the state of the
 * address, because the client SDK's own `createUserWithEmailAndPassword`
 * answers "does this account exist?" on the wire — an attacker reads
 * `EMAIL_EXISTS` off the Identity Toolkit response, not our error copy. Moving
 * creation here is the only way the answer stops being available.
 *
 * **This endpoint sends no email at all**, and that is what makes it airtight:
 * an earlier version mailed a different template per branch, so the branch was
 * observable to whoever held the mailbox. Now nothing differs. Verification is
 * sent later, by the gate, once the user has signed in and Firebase has a
 * `currentUser` to send it for.
 *
 * It also never alters an account that already exists — see the note in
 * handleRegister. Two orderings of the account pre-hijacking attack depend on
 * that, and Firebase does not retire outstanding verification codes.
 */
export async function handleRegister(req: Request, res: Response): Promise<void> {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    // Validation runs before any Auth call, so a password that misses the
    // policy is refused identically whether or not the address exists. A check
    // that only ran for real accounts would be an oracle in itself.
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? 'Check the details and try again.',
      'invalid_request',
    )
  }

  const { email, password } = parsed.data
  const emailHash = hashKey(email)

  // Create first and catch the collision, rather than checking existence and
  // then creating. The check-then-act version has a race — two simultaneous
  // registrations both see "absent" — and this way the atomicity is Firebase's
  // problem, not ours.
  let branch: 'new' | 'existing' = 'new'
  try {
    await getAdminAuth().createUser({ email, password, emailVerified: false })
  } catch (err) {
    if (!isEmailAlreadyExists(err)) throw err

    // Deliberately nothing. This request may be an attacker probing someone
    // else's address, and it must not be able to change, resend, or reveal
    // anything about an account it does not control. The legitimate user whose
    // address this is signs in as normal, or resets from the sign-in screen.
    branch = 'existing'
  }

  logAuthEvent('register.completed', { emailHash, branch, outcome: 'ok' })
  res.json({ ok: true })
}

function isEmailAlreadyExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'auth/email-already-exists'
  )
}
