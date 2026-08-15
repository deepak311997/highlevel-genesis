import type { UserRecord } from 'firebase-admin/auth'

import { getAdminAuth } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'

/**
 * Delete accounts that were never verified.
 *
 * This is the last of D18's mitigations against account pre-hijacking. An
 * attacker can register someone else's address; rules make that account inert,
 * and a registration request can never alter an account it does not control —
 * but the account still sits there, and the victim could still be socially
 * engineered into clicking "verify" on it days later. Expiring it closes that
 * window rather than leaving it open indefinitely.
 *
 * It also keeps the address free: an unverified squat would otherwise block the
 * real owner from ever completing a registration of their own.
 */

export const UNVERIFIED_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Firebase caps a batch delete at 1000 identifiers. */
const DELETE_BATCH = 1000

export function isExpiredUnverified(user: UserRecord, now: number): boolean {
  if (user.emailVerified) return false

  const created = Date.parse(user.metadata.creationTime)
  // An unparseable timestamp must not be read as "infinitely old" — deleting an
  // account because its metadata was odd is far worse than keeping it.
  if (Number.isNaN(created)) return false

  return now - created >= UNVERIFIED_MAX_AGE_MS
}

/**
 * Sweep every account. Returns how many were removed.
 *
 * Paginated because `listUsers` returns at most 1000 at a time, and a sweep
 * that silently stopped at the first page would look like it worked.
 */
export async function deleteExpiredUnverifiedUsers(now: number = Date.now()): Promise<number> {
  const auth = getAdminAuth()
  const doomed: string[] = []

  let pageToken: string | undefined
  do {
    const page = await auth.listUsers(DELETE_BATCH, pageToken)
    doomed.push(...page.users.filter((user) => isExpiredUnverified(user, now)).map((u) => u.uid))
    pageToken = page.pageToken
  } while (pageToken !== undefined)

  for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
    await auth.deleteUsers(doomed.slice(i, i + DELETE_BATCH))
  }

  if (doomed.length > 0) {
    logAuthEvent('cleanup.deleted_unverified', { outcome: 'ok', status: doomed.length })
  }
  return doomed.length
}
