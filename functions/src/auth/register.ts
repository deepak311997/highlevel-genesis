import type { Request, Response } from 'express'

import { getTransport } from '../lib/email'
import { activationEmail } from '../lib/email/templates'
import { getAdminAuth } from '../lib/firebase'
import { HttpError } from '../lib/errors'
import { logAuthEvent } from '../lib/log'
import { appActionLink, extractOobCode } from './links'
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

  await auth.createUser({ email, password, emailVerified: false })
  const link = appActionLink(
    'verifyEmail',
    extractOobCode(await auth.generateEmailVerificationLink(email)),
  )
  await getTransport().send({ to: email, ...activationEmail(link) })

  logAuthEvent('register.completed', { emailHash, branch: 'new', outcome: 'ok' })
  res.json({ ok: true })
}
