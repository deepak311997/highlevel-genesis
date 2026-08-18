import { z } from 'zod'

import { firestoreTimestamp, USERS } from '../users/schema'

/**
 * `users/{uid}/projects/{projectId}` — a project, and the boundaries around it.
 *
 * The documents are written only by the Admin SDK inside `/api/projects*`;
 * `firestore.rules` denies the collection to every client, owner included. This
 * file is where the shape of it is stated, from three directions: what a caller
 * may send, what may appear in a path, and what the stored document must look
 * like to be usable.
 *
 * **The path is the ownership.** A project lives under its owner's uid — the one
 * `withVerifiedUser` read off the ID token — so there is no `ownerUid` field
 * here and no equality check anywhere in the slice. Another user's project is
 * not addressable by a request rather than merely refused, which is the same
 * argument that made the profile route `/api/profile`, applied to a resource
 * that must carry an id in its path.
 */

export const PROJECTS = 'projects'

/** Matches `DISPLAY_NAME_MAX`, and is what the card's layout survives. */
export const NAME_MAX = 80

/** A paragraph, which is what a description is. */
export const DESCRIPTION_MAX = 500

/**
 * The most live projects one account may hold, and the most the list returns.
 *
 * The two are the same number on purpose: an unpaginated list is only honest if
 * it cannot truncate, so creation is capped at exactly what the list can show.
 */
export const PROJECT_LIMIT = 100
export const LIST_LIMIT = 100

/**
 * One place composes the path, from `USERS` rather than a second `'users'`
 * literal, so the two halves cannot drift.
 */
export function projectsPath(uid: string): string {
  return `${USERS}/${uid}/${PROJECTS}`
}

const name = z.string().trim().min(1).max(NAME_MAX)

/**
 * The form of a name that two projects are compared by.
 *
 * Names are the user's own words, so `Contact center`, `contact center` and
 * `Contact  center` are the same project to everybody except a byte comparison —
 * a list holding all three is a list you cannot navigate. Case-folded and with
 * runs of whitespace collapsed, so what the check means is "looks like the same
 * name" rather than "is the same string".
 *
 * **A comparison key, never a stored value.** The document keeps what the user
 * typed, capitals and all; this exists only to decide whether a create or a
 * rename collides. Deriving a stored `nameLower` field instead would be faster
 * to query and wrong for every document written before it existed — a duplicate
 * check that silently skips the projects it does not know about is worse than
 * none.
 */
export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * A description, or `null` — and **`null` is the only way to say "none"**.
 *
 * The trim happens before the limit, so padding cannot be smuggled past it; the
 * transform is what stops the trim from inventing a second empty. Without it a
 * caller who sends `''` or `'   '` stores `''`, which no screen can tell apart
 * from `null` — the card hides a falsy description either way — while the rename
 * dialog, which decides what changed by comparing its trimmed field against the
 * stored value, reads the two as different and offers a Save that alters
 * nothing. One state, one representation, decided at the boundary rather than
 * re-decided by each reader.
 */
const description = z
  .string()
  .trim()
  .max(DESCRIPTION_MAX)
  .nullable()
  .transform((value) => (value === '' ? null : value))

/**
 * The `POST` body.
 *
 * `.strict()` is the load-bearing call. `id`, `locationId`, `createdAt` and
 * `deletedAt` are the server's to write — the id is a Firestore auto-id, the
 * location comes from `hlConnections/{uid}`, the timestamps come from the server
 * clock — and `ownerUid` does not exist at all, because the path is the
 * ownership. A body carrying any of them is refused rather than quietly stripped.
 */
export const createProjectBodySchema = z
  .object({ name, description: description.optional() })
  .strict()

export type CreateProjectBody = z.infer<typeof createProjectBodySchema>

/**
 * The `PATCH` body — genuinely partial, and never empty.
 *
 * Both fields are optional so a rename need not resend the description, and an
 * explicit `null` clears one where an absent key leaves it alone. The refinement
 * is what stops `{}`: an accepted no-op would still advance `updatedAt`, which
 * reorders a list sorted by it for a request that changed nothing. `parseBody`
 * surfaces `issues[0].message`, so this string is the 400's body.
 */
export const patchProjectBodySchema = z
  .object({ name: name.optional(), description: description.optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send a name or a description to change.',
  })

export type PatchProjectBody = z.infer<typeof patchProjectBodySchema>

/**
 * What may appear in `:projectId`.
 *
 * `getDb().doc()` composes a path by string concatenation, so an id containing
 * `/` changes the *depth* of the path rather than the document it names, and
 * `.` / `..` are ids Firestore refuses outright. Express's single-segment
 * `:param` already stops the slash case; checking here makes it a property of
 * the id instead of a dependency on how a router happens to behave.
 *
 * The message is the one a caller sees, and it describes the outcome rather than
 * the rule — a malformed id and a stranger's id should read the same.
 */
export const projectIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'That project could not be found.')

/**
 * The stored document, **parsed rather than asserted**.
 *
 * `name` and the two timestamps carry no `.catch`: they are what a row is made
 * of, and a document missing one cannot be rendered — so it is *known* to be
 * unusable, omitted from the list and 404 by id, rather than drawn as a row with
 * blanks in it that the user can click actions on. `description`, `locationId`
 * and `deletedAt` degrade, which is `storedProfileSchema`'s split applied here.
 *
 * `deletedAt` degrading to `null` also means a document written before the field
 * existed reads as live rather than as unreadable.
 */
export const storedProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().catch(null),
  locationId: z.string().nullable().catch(null),
  createdAt: firestoreTimestamp,
  updatedAt: firestoreTimestamp,
  deletedAt: firestoreTimestamp.nullable().catch(null),
})

export type StoredProject = z.infer<typeof storedProjectSchema>

/**
 * The wire shape. Timestamps are ISO-8601 strings — D23, as `connectedAt` is.
 *
 * **`deletedAt` is deliberately not here.** A deleted project is never returned,
 * so the field has no wire representation at all, and leaving it off the type is
 * what stops it reaching one by accident.
 */
export interface Project {
  id: string
  name: string
  description: string | null
  locationId: string | null
  createdAt: string
  updatedAt: string
}

export function toProject(id: string, stored: StoredProject): Project {
  return {
    id,
    name: stored.name,
    description: stored.description,
    locationId: stored.locationId,
    createdAt: stored.createdAt.toDate().toISOString(),
    updatedAt: stored.updatedAt.toDate().toISOString(),
  }
}
