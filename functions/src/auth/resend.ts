import type { Request, Response } from 'express'

import { activationEmail, passwordResetEmail } from '../lib/email/templates'
import { HttpError } from '../lib/errors'
import { logAuthEvent } from '../lib/log'
import { findUser, sendActionLink } from './mail'
import { emailOnlySchema } from './schema'
import { hashKey } from './throttle'

/**
 * `POST /auth/resend` — re-issue a verification link.
 *
 * Reached from the verification gate, where a user is stuck without the email.
 * Answers `200 { ok: true }` for an address that does not exist and for one
 * that is already verified, exactly as for one awaiting verification: the gate
 * is public enough that a discriminating response here would undo the
 * registration endpoint's work.
 */
export async function handleResend(req: Request, res: Response): Promise<void> {
  const email = parseEmail(req)
  const emailHash = hashKey(email)
  const user = await findUser(email)

  if (user === null) {
    logAuthEvent('resend.no_account', { emailHash, outcome: 'ok' })
  } else if (user.emailVerified) {
    // Nothing to resend. Sending a verification link to an already-verified
    // account would be noise at best, and at worst a way to spam its owner.
    logAuthEvent('resend.already_verified', { emailHash, outcome: 'ok' })
  } else {
    await sendActionLink(email, 'verifyEmail', activationEmail)
    logAuthEvent('resend.sent', { emailHash, outcome: 'ok' })
  }

  res.json({ ok: true })
}

/**
 * `POST /auth/password-reset`.
 *
 * Same contract. This is the endpoint the "forgot password" form calls, and it
 * replaces the client SDK's `sendPasswordResetEmail` so that both this and the
 * already-registered branch of registration send one identically branded
 * message rather than two different-looking ones for the same action.
 */
export async function handlePasswordReset(req: Request, res: Response): Promise<void> {
  const email = parseEmail(req)
  const emailHash = hashKey(email)
  const user = await findUser(email)

  if (user === null) {
    logAuthEvent('reset.no_account', { emailHash, outcome: 'ok' })
  } else {
    await sendActionLink(email, 'resetPassword', passwordResetEmail)
    logAuthEvent('reset.sent', { emailHash, outcome: 'ok' })
  }

  res.json({ ok: true })
}

function parseEmail(req: Request): string {
  const parsed = emailOnlySchema.safeParse(req.body)
  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? 'Check the address and try again.',
      'invalid_request',
    )
  }
  return parsed.data.email
}
