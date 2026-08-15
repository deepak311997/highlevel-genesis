import type { UserRecord } from 'firebase-admin/auth'

import { getTransport } from '../lib/email'
import type { EmailContent } from '../lib/email/templates'
import { getAdminAuth } from '../lib/firebase'
import { appActionLink, extractOobCode, type ActionMode } from './links'

/**
 * Shared by all three auth endpoints, because they must behave identically in
 * the one respect that matters: the HTTP response never reveals whether the
 * address exists. Only the mail differs, and only the mailbox holder sees it.
 */

/**
 * Look an account up without turning "absent" into an error path.
 *
 * `getUserByEmail` rejects for an unknown address, and letting that reject
 * propagate is precisely how a 500 on one branch and a 200 on the other becomes
 * an account-existence oracle.
 */
export async function findUser(email: string): Promise<UserRecord | null> {
  try {
    return await getAdminAuth().getUserByEmail(email)
  } catch (err) {
    if (isUserNotFound(err)) return null
    throw err
  }
}

function isUserNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'auth/user-not-found'
  )
}

/** Mint a link on our own action route (D9) and mail it. */
export async function sendActionLink(
  email: string,
  mode: ActionMode,
  build: (link: string) => EmailContent,
): Promise<void> {
  const auth = getAdminAuth()
  const firebaseLink =
    mode === 'verifyEmail'
      ? await auth.generateEmailVerificationLink(email)
      : await auth.generatePasswordResetLink(email)

  await getTransport().send({
    to: email,
    ...build(appActionLink(mode, extractOobCode(firebaseLink))),
  })
}
