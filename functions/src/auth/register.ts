import type { Request, Response } from 'express'

import { activationEmail, alreadyRegisteredEmail } from '../lib/email/templates'
import { getAdminAuth } from '../lib/firebase'
import { HttpError } from '../lib/errors'
import { logAuthEvent } from '../lib/log'
import { sendActionLink } from './mail'
import { registerSchema } from './schema'
import { hashKey } from './throttle'

/**
 * `POST /auth/register`.
 *
 * The response is the point. It is `200 { ok: true }` whatever the state of the
 * address, because the client SDK's own `createUserWithEmailAndPassword`
 * answers "does this account exist?" on the wire — an attacker reads
 * `EMAIL_EXISTS` off the Identity Toolkit response, not our error copy. Moving
 * creation here is the only way the answer stops being available, so nothing in
 * this handler may vary the status, the body, or the shape of a failure by
 * branch.
 *
 * Which email goes out *does* vary, and that is fine: only whoever controls the
 * mailbox can observe it.
 */
export async function handleRegister(req: Request, res: Response): Promise<void> {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    // Validation runs before any Auth call, so a weak password is refused
    // identically whether or not the address exists. A check that only ran for
    // real accounts would be an oracle in itself.
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? 'Check the details and try again.',
      'invalid_request',
    )
  }

  const { email, password } = parsed.data
  const emailHash = hashKey(email)
  const auth = getAdminAuth()

  // Create first and catch the collision, rather than checking existence and
  // then creating. The check-then-act version has a race — two simultaneous
  // registrations both see "absent" — and this way the atomicity is Firebase's
  // problem, not ours.
  let created = true
  try {
    await auth.createUser({ email, password, emailVerified: false })
  } catch (err) {
    if (!isEmailAlreadyExists(err)) throw err
    created = false
  }

  let branch: 'new' | 'existing_verified' | 'existing_unverified'
  if (created) {
    await sendActionLink(email, 'verifyEmail', activationEmail)
    branch = 'new'
  } else {
    branch = await handleExistingAccount(email)
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

/**
 * The address is taken. What happens next depends on whether the real owner
 * ever proved they hold the mailbox — and either way the caller learns nothing.
 */
async function handleExistingAccount(
  email: string,
): Promise<'existing_verified' | 'existing_unverified'> {
  const existing = await getAdminAuth().getUserByEmail(email)

  // One behaviour, verified or not: change nothing, mail a reset link.
  //
  // The password is deliberately untouched. This request may be an attacker
  // probing someone else's address, and it must not be able to alter an account
  // it does not control. A reset link is safe to send because it is useful only
  // to whoever holds the mailbox.
  //
  // An *activation* link would not be safe here. It would let whoever submitted
  // this form activate an account whose password someone else set — which is
  // the pre-hijacking attack rather than a defence against it.
  //
  // This replaces the plan's "replace the password and issue a fresh link that
  // retires the old one": measured, Firebase does not retire outstanding codes,
  // and not even deleting the account does so — codes resolve by address, not
  // by uid. See the platform-behaviour test in auth-register.spec.ts.
  await sendActionLink(email, 'resetPassword', alreadyRegisteredEmail)

  return existing.emailVerified ? 'existing_verified' : 'existing_unverified'
}
