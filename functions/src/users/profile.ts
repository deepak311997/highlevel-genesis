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
 * The uid comes from the verified ID token and there is no other source: the path
 * is `/profile`, naming the resource and no user at all, so a request has nowhere
 * to name a different one. That is what lets `firestore.rules` deny `users/{uid}`
 * to every client — a mistake in this file is a bug, not a breach.
 */

/** What both routes answer with, so the two cannot drift in shape. */
export interface ProfileResponse {
  profile: Profile | null
}

/**
 * Read and project in one place, so `GET` and `PUT` cannot disagree about what a
 * profile looks like on the wire. `null` covers both an absent document and one
 * that fails to parse; `GET` treats it as an ordinary answer, `PUT` — which has
 * just written a complete document — as an internal failure.
 */
async function readProfile(uid: string): Promise<Profile | null> {
  const snapshot = await getDb().doc(`${USERS}/${uid}`).get()
  if (!snapshot.exists) return null

  const parsed = storedProfileSchema.safeParse(snapshot.data())
  if (!parsed.success) {
    /*
     * Fail closed, and say so in the log. A half-populated profile hides
     * corruption behind a screen the user cannot act on; "not created yet" is
     * truthful and self-healing, because the next `PUT` rewrites the document.
     */
    logAuthEvent('profile.unreadable', { outcome: 'invalid' })
    return null
  }

  return toProfile(parsed.data)
}

/**
 * Not a 404 when there is no document: "verified, signed in, no profile yet" is an
 * ordinary state, and answering it through the error channel would make the first
 * client that forgot to translate it show an error screen to a healthy account.
 */
export async function handleGetProfile(_req: Request, res: Response, uid: string): Promise<void> {
  res.json({ profile: await readProfile(uid) } satisfies ProfileResponse)
}

/**
 * Create the profile if it is absent, touch it if it is not — idempotent, because
 * a refresh, a second tab and a retry after a timeout all arrive here and should
 * end with the same document.
 */
export async function handlePutProfile(req: Request, res: Response, uid: string): Promise<void> {
  /*
   * Parsed first, so a refused body writes nothing. A body carrying `uid` or
   * `email` is rejected outright rather than silently stripped.
   */
  const body = parseBody(profileBodySchema, req)

  // The address comes from the Admin Auth record, never from the body: taking it
  // from a caller would let one user store another's address as their own.
  const email = (await getAdminAuth().getUser(uid)).email?.trim() ?? ''
  if (email === '') {
    // Unreachable in this product: every account is created with an address.
    // Guarded rather than stored, because an empty email would make GET answer
    // `{ profile: null }` for this user until a repair.
    logAuthEvent('profile.no_email', { outcome: 'invalid' })
    throw new HttpError(500, 'Internal error', 'internal')
  }

  const ref = getDb().doc(`${USERS}/${uid}`)

  /*
   * A transaction rather than `set(..., { merge: true })`: the merge version makes
   * "createdAt is written once" true only for sequential callers, and two tabs
   * ensuring at the same moment is the ordinary case.
   */
  await getDb().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref)

    /*
     * Branch on whether the stored document is *usable*, not merely on whether it
     * exists. A document missing `createdAt` cannot be repaired by a patch that
     * only writes `email` and `updatedAt` — it would stay unreadable forever — so
     * anything that does not parse is rewritten whole. A `createdAt` that is still
     * a usable timestamp survives that rewrite, since losing it would silently
     * reset the account's age.
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
     * Present-versus-absent, not truthy-versus-falsy: an explicit `null` clears the
     * name, an absent key leaves it alone. Collapsing the two would make every
     * ensure — which sends `{}` — wipe the display name.
     */
    if ('displayName' in body) patch['displayName'] = body.displayName ?? null

    tx.update(ref, patch)
  })

  // Re-read, because `serverTimestamp()` is a sentinel until it commits.
  const profile = await readProfile(uid)
  if (profile === null) {
    // Unreachable: we have just written a complete document. It fails closed
    // rather than answering `{ profile: null }` to a successful ensure.
    logAuthEvent('profile.unreadable', { outcome: 'invalid', detail: 'after write' })
    throw new HttpError(500, 'Internal error', 'internal')
  }

  res.json({ profile } satisfies ProfileResponse)
}
