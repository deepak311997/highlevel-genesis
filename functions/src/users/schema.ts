import type { Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'

/**
 * `users/{uid}` — the profile, and the two boundaries around it.
 *
 * The document is written only by the Admin SDK inside `PUT /api/users/me`;
 * `firestore.rules` denies it to every client, owner included. That is the
 * project's one data-access pattern, and this file is where the shape of it is
 * stated: what a caller may send, what the stored document must look like to be
 * usable, and what goes back on the wire.
 */

export const USERS = 'users'

/**
 * Long enough for a real name, short enough that the card's layout survives it.
 * Enforced here rather than in the UI, because the UI is not the boundary.
 */
export const DISPLAY_NAME_MAX = 80

/**
 * The `PUT` body.
 *
 * `.strict()` is the load-bearing call. The trap named for this slice is a route
 * that authenticates its caller and then trusts a uid it was handed; `/me` gives
 * the request nowhere to put one, and this makes a body that tries anyway a 400
 * rather than a field silently dropped. "We do not read `uid`" is a promise;
 * "a body containing `uid` is refused" is a property.
 *
 * Every field is optional, so `{}` is a valid ensure. `null` is distinct from
 * absent: absent leaves the stored name alone, `null` clears it.
 */
export const profileBodySchema = z
  .object({
    displayName: z.string().trim().max(DISPLAY_NAME_MAX).nullable().optional(),
  })
  .strict()

export type ProfileBody = z.infer<typeof profileBodySchema>

/** A Firestore Timestamp, recognised structurally rather than by instanceof. */
export const firestoreTimestamp = z.custom<Timestamp>(
  (value) => typeof (value as Timestamp | undefined)?.toMillis === 'function',
)

/**
 * The stored document, **parsed rather than asserted**.
 *
 * `snapshot.data() as T` is a lie the compiler believes: Firestore returns
 * whatever is there, including a document from an older shape or an interrupted
 * write. Parsing means a document that cannot describe a profile is *known* not
 * to, and the route can answer "not created yet" — truthful, and repaired by the
 * next ensure — instead of rendering blanks the user cannot act on.
 *
 * `displayName` gets a `.catch(null)` and the other three do not, deliberately:
 * a name is cosmetic and degrades, an address and a creation date are what the
 * card is made of.
 */
export const storedProfileSchema = z.object({
  email: z.string().min(1),
  displayName: z.string().nullable().catch(null),
  createdAt: firestoreTimestamp,
  updatedAt: firestoreTimestamp,
})

export type StoredProfile = z.infer<typeof storedProfileSchema>

/** The wire shape. Timestamps are ISO-8601 strings — D19, as `connectedAt` is. */
export interface Profile {
  email: string
  displayName: string | null
  createdAt: string
  updatedAt: string
}

export function toProfile(stored: StoredProfile): Profile {
  return {
    email: stored.email,
    displayName: stored.displayName,
    createdAt: stored.createdAt.toDate().toISOString(),
    updatedAt: stored.updatedAt.toDate().toISOString(),
  }
}
