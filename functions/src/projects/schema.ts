import { z } from 'zod'

import { firestoreTimestamp, USERS } from '../users/schema'

/**
 * `users/{uid}/projects/{projectId}` — a project, and the boundaries around it.
 *
 * Written only by the Admin SDK inside `/api/projects*`; `firestore.rules` denies
 * the collection to every client. The shape is stated here from three directions:
 * what a caller may send, what may appear in a path, and what the stored document
 * must look like to be usable.
 *
 * **The path is the ownership** — a project lives under its owner's uid, so there
 * is no `ownerUid` field and no equality check anywhere in the slice.
 */

export const PROJECTS = 'projects'

/** Matches `DISPLAY_NAME_MAX`, and is what the card's layout survives. */
export const NAME_MAX = 80

/** A paragraph, which is what a description is. */
export const DESCRIPTION_MAX = 500

/**
 * The most live projects one account may hold, and the most the list returns —
 * the same number, since an unpaginated list is only honest if it cannot truncate.
 */
export const PROJECT_LIMIT = 100
export const LIST_LIMIT = 100

/** One place composes the path, so the two halves cannot drift. */
export function projectsPath(uid: string): string {
  return `${USERS}/${uid}/${PROJECTS}`
}

const name = z.string().trim().min(1).max(NAME_MAX)

/**
 * The form of a name that two projects are compared by.
 *
 * `Contact center`, `contact center` and `Contact  center` are the same project to
 * everybody except a byte comparison, and a list holding all three is one you
 * cannot navigate.
 *
 * **A comparison key, never a stored value.** The document keeps what the user
 * typed. A stored `nameLower` would be faster to query and wrong for every
 * document written before it existed — a duplicate check that silently skips the
 * projects it does not know about is worse than none.
 */
export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * A description, or `null` — and **`null` is the only way to say "none"**.
 *
 * Without the transform, `''` and `'   '` both store `''`, which no screen can
 * tell apart from `null` — while the rename dialog, which compares its trimmed
 * field against the stored value, reads them as different and offers a Save that
 * alters nothing. One state, one representation, decided at the boundary.
 */
const description = z
  .string()
  .trim()
  .max(DESCRIPTION_MAX)
  .nullable()
  .transform((value) => (value === '' ? null : value))

/**
 * The `POST` body. `.strict()` is load-bearing: `id`, `locationId` and the
 * timestamps are the server's to write, and `ownerUid` does not exist at all
 * because the path is the ownership.
 */
export const createProjectBodySchema = z
  .object({ name, description: description.optional() })
  .strict()

export type CreateProjectBody = z.infer<typeof createProjectBodySchema>

/**
 * The `PATCH` body — genuinely partial, and never empty. An explicit `null` clears
 * a description where an absent key leaves it alone, and the refinement is what
 * stops `{}`: an accepted no-op would still advance `updatedAt`, reordering a list
 * sorted by it for a request that changed nothing.
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
 * `getDb().doc()` composes a path by string concatenation, so an id containing `/`
 * changes the *depth* of the path rather than the document it names. Express's
 * single-segment `:param` already stops that; checking here makes it a property of
 * the id rather than a dependency on how a router behaves.
 */
export const projectIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'That project could not be found.')

/**
 * The stored document, **parsed rather than asserted**.
 *
 * `name` and the two timestamps carry no `.catch` — a document missing one cannot
 * be rendered, so it is omitted from the list and 404 by id rather than drawn as a
 * row with blanks the user can click actions on. The other three degrade, which
 * also means a document written before `deletedAt` existed reads as live.
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
 * The wire shape. Timestamps are ISO-8601 strings.
 *
 * **`deletedAt` is deliberately not here**: a deleted project is never returned, so
 * leaving it off the type is what stops it reaching the wire by accident.
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
