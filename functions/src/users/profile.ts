import type { Request, Response } from 'express'
import { FieldValue } from 'firebase-admin/firestore'

import { getAdminAuth, getDb } from '../lib/firebase'
import { HttpError } from '../lib/errors'
import { logAuthEvent } from '../lib/log'
import { parseBody } from '../lib/parse'
import {
  firestoreTimestamp,
  profileBodySchema,
  storedProfileSchema,
  toProfile,
  USERS,
  type Profile,
} from './schema'

/**
 * The caller's own profile — read, and ensured.
 *
 * The uid is the one `withVerifiedUser` read off the ID token, and there is no
 * other source for it: the path is the literal `/users/me`, so a request has
 * nowhere to name a different user. That is the shape the whole API takes from
 * here on, and it is why `firestore.rules` can deny `users/{uid}` to every
 * client — a mistake in this file is a bug, not a breach.
 */

/** What both routes answer with, so the two cannot drift in shape. */
export interface ProfileResponse {
  profile: Profile | null
}

/**
 * Read and project, in one place, so `GET` and `PUT` cannot disagree about what
 * a profile looks like on the wire.
 *
 * `null` means "no usable profile", covering both an absent document and one
 * that fails to parse. The two callers draw different conclusions from it: for
 * `GET` it is an ordinary answer, for `PUT` — which has just written a complete
 * document — it is an internal failure.
 */
async function readProfile(uid: string): Promise<Profile | null> {
  const snapshot = await getDb().doc(`${USERS}/${uid}`).get()
  if (!snapshot.exists) return null

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
    return null
  }

  return toProfile(parsed.data)
}

/**
 * Not a 404 when there is no document. "Verified, signed in, no profile yet" is
 * where a user sits between verifying and their first ensure — an ordinary
 * state, and the account card's empty state. Answering it through the error
 * channel would make the first client that forgot to translate it show an error
 * screen to a perfectly healthy account.
 */
export async function handleGetProfile(_req: Request, res: Response, uid: string): Promise<void> {
  res.json({ profile: await readProfile(uid) } satisfies ProfileResponse)
}

/**
 * Create the profile if it is absent, touch it if it is not.
 *
 * Idempotent, because the callers cannot know which case they are in: a page
 * refresh, a second tab and a retry after a timeout all arrive here, and every
 * one of them should end with the same document and the same answer.
 */
export async function handlePutProfile(req: Request, res: Response, uid: string): Promise<void> {
  /*
   * Parsed **first**, before anything touches Firestore, so a refused body
   * writes nothing — including the caller's own document. A body carrying `uid`
   * or `email` is rejected outright rather than silently stripped, which is what
   * makes "the request cannot name another user" a property rather than a
   * promise.
   */
  const body = parseBody(profileBodySchema, req)

  /*
   * The address comes from the Admin Auth record — never from the body. It is
   * Firebase Auth's field to own, and this copy exists for display; taking it
   * from a caller would let one user store another's address as their own.
   */
  const email = (await getAdminAuth().getUser(uid)).email?.trim() ?? ''
  if (email === '') {
    // Unreachable in this product: every account is created by /auth/register
    // with an address. Guarded rather than stored, because an empty email would
    // make GET answer `{ profile: null }` for this user until a repair.
    logAuthEvent('profile.no_email', { outcome: 'invalid' })
    throw new HttpError(500, 'Internal error', 'internal')
  }

  const ref = getDb().doc(`${USERS}/${uid}`)

  /*
   * A transaction rather than `set(..., { merge: true })`.
   *
   * The merge version makes "createdAt is written once and never rewritten"
   * true only for sequential callers — and two tabs ensuring at the same moment
   * is the ordinary case, not the exotic one.
   */
  await getDb().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref)

    /*
     * Branch on whether the stored document is *usable*, not merely on whether
     * it exists.
     *
     * D18 promises that a corrupt profile is repaired by the next ensure, and a
     * document missing `createdAt` cannot be repaired by a patch that only ever
     * writes `email` and `updatedAt` — it would stay unreadable, and `GET` would
     * go on answering `{ profile: null }` forever. So anything that does not
     * parse is rewritten whole. A `createdAt` that is still a usable timestamp
     * survives that rewrite, because losing it would silently reset the account's
     * age; there is nothing to preserve when it is not.
     */
    const stored = snapshot.exists ? storedProfileSchema.safeParse(snapshot.data()) : undefined

    if (stored?.success !== true) {
      const existingCreatedAt = firestoreTimestamp.safeParse(snapshot.get('createdAt'))

      tx.set(ref, {
        email,
        displayName: body.displayName ?? null,
        createdAt: existingCreatedAt.success
          ? existingCreatedAt.data
          : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      return
    }

    const patch: Record<string, unknown> = { email, updatedAt: FieldValue.serverTimestamp() }
    /*
     * Present-versus-absent, not truthy-versus-falsy. An explicit `null` clears
     * the name; an absent key leaves whatever is stored alone. Collapsing the
     * two would make every ensure — which sends `{}` — wipe the display name.
     */
    if ('displayName' in body) patch['displayName'] = body.displayName ?? null

    tx.update(ref, patch)
  })

  /*
   * Re-read rather than answer from what we wrote: `serverTimestamp()` is a
   * sentinel until it commits, so the committed document is the only place the
   * real timestamps exist. One extra read on a route called once per session.
   */
  const profile = await readProfile(uid)
  if (profile === null) {
    // Unreachable: we have just written a complete document. No AC covers it;
    // it fails closed rather than answering `{ profile: null }` to a caller
    // whose ensure actually succeeded.
    logAuthEvent('profile.unreadable', { outcome: 'invalid', detail: 'after write' })
    throw new HttpError(500, 'Internal error', 'internal')
  }

  res.json({ profile } satisfies ProfileResponse)
}
