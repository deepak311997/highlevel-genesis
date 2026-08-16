import type { Request, Response } from 'express'

import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import { storedProfileSchema, toProfile, USERS, type Profile } from './schema'

/**
 * Reading the caller's own profile.
 *
 * The uid is the one `withVerifiedUser` read off the ID token, and there is no
 * other source for it: the path is the literal `/users/me`, so a request has
 * nowhere to name a different user. That is the shape the whole API takes from
 * here on.
 */

/** What both routes answer with, so the two cannot drift in shape. */
export interface ProfileResponse {
  profile: Profile | null
}

export async function handleGetProfile(_req: Request, res: Response, uid: string): Promise<void> {
  const snapshot = await getDb().doc(`${USERS}/${uid}`).get()

  /*
   * Not a 404. "Verified, signed in, no profile yet" is where a user sits
   * between verifying and their first ensure — an ordinary state, and the
   * account card's empty state. Answering it through the error channel would
   * make the first client that forgot to translate it show an error screen to a
   * perfectly healthy account.
   */
  if (!snapshot.exists) {
    res.json({ profile: null } satisfies ProfileResponse)
    return
  }

  const parsed = storedProfileSchema.safeParse(snapshot.data())
  if (!parsed.success) {
    /*
     * Fail closed, and say so in the log — the precedent is
     * `handleGetConnection`. A half-populated profile hides corruption behind a
     * screen the user cannot act on; "not created yet" is both truthful and
     * self-healing, because the next `PUT` rewrites the document. No field of
     * the document goes in the log line.
     */
    logAuthEvent('profile.unreadable', { outcome: 'invalid' })
    res.json({ profile: null } satisfies ProfileResponse)
    return
  }

  res.json({ profile: toProfile(parsed.data) } satisfies ProfileResponse)
}
