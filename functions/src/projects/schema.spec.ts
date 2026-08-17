import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import {
  createProjectBodySchema,
  DESCRIPTION_MAX,
  NAME_MAX,
  patchProjectBodySchema,
  projectIdSchema,
  projectsPath,
  storedProjectSchema,
  toProject,
} from './schema'

/**
 * The four schemas around `users/{uid}/projects/{projectId}`, from both
 * directions.
 *
 * The two body schemas guard what a caller may send, and `.strict()` is the
 * load-bearing call on each: `ownerUid`, `id`, `locationId`, `createdAt` and
 * `deletedAt` are all fields the *server* owns, so a body carrying one is a
 * refusal rather than a key we happened not to read.
 *
 * `projectIdSchema` guards the one thing this slice's routes accept that the
 * profile route could not — a document id in the path. `getDb().doc()` composes
 * a path by string concatenation, so an id containing `/` changes the *depth* of
 * the path rather than the document it names.
 *
 * `storedProjectSchema` guards what Firestore hands back, for the same reason
 * `storedProfileSchema` does: `snapshot.data() as T` is a lie the compiler
 * believes.
 */

const complete = {
  name: 'Contact dashboard',
  description: 'Lists and filters contacts',
  locationId: 'lUanVn0CtZJTlymH8ySo',
  createdAt: Timestamp.fromMillis(1_700_000_000_000),
  updatedAt: Timestamp.fromMillis(1_700_000_500_000),
  deletedAt: null,
}

/** The complete document with one field missing — a half-written write. */
function without(field: keyof typeof complete): Record<string, unknown> {
  return Object.fromEntries(Object.entries(complete).filter(([key]) => key !== field))
}

describe('projectsPath', () => {
  /*
   * Composed in one place from `USERS`, so the two halves of the path cannot
   * drift: a project lives *under* its owner, and that is what makes ownership
   * structural rather than a `where` clause someone has to remember.
   */
  it('nests the collection under the owner', () => {
    expect(projectsPath('alice')).toBe('users/alice/projects')
  })
})

describe('createProjectBodySchema — what a caller may send', () => {
  it('accepts a name on its own', () => {
    expect(createProjectBodySchema.parse({ name: 'Contact dashboard' })).toEqual({
      name: 'Contact dashboard',
    })
  })

  it('accepts a description alongside it', () => {
    expect(
      createProjectBodySchema.parse({ name: 'Contact dashboard', description: 'Contacts' }),
    ).toEqual({ name: 'Contact dashboard', description: 'Contacts' })
  })

  it('accepts an explicit null description', () => {
    expect(createProjectBodySchema.parse({ name: 'A', description: null })).toEqual({
      name: 'A',
      description: null,
    })
  })

  it('trims both fields, so padding cannot be smuggled past the limits', () => {
    expect(
      createProjectBodySchema.parse({ name: '  Contacts  ', description: '  Notes  ' }),
    ).toEqual({ name: 'Contacts', description: 'Notes' })
  })

  /*
   * AC-14. Every one of these is a field the server owns — the id is generated,
   * `locationId` comes from `hlConnections/{uid}`, the timestamps come from the
   * server clock, and there is no `ownerUid` at all because the path is the
   * ownership. A dropped unknown key would make that true only until somebody
   * adds a read.
   */
  it.each(['ownerUid', 'id', 'locationId', 'createdAt', 'deletedAt'])(
    'rejects a body carrying %s',
    (key) => {
      expect(createProjectBodySchema.safeParse({ name: 'A', [key]: 'x' }).success).toBe(false)
    },
  )

  it.each([
    ['a missing name', {}],
    ['a blank name', { name: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a non-string name', { name: 42 }],
  ])('rejects %s', (_label, body) => {
    expect(createProjectBodySchema.safeParse(body).success).toBe(false)
  })

  it(`rejects a name longer than ${String(NAME_MAX)} characters and accepts one at the limit`, () => {
    expect(createProjectBodySchema.safeParse({ name: 'a'.repeat(NAME_MAX + 1) }).success).toBe(
      false,
    )
    expect(createProjectBodySchema.safeParse({ name: 'a'.repeat(NAME_MAX) }).success).toBe(true)
  })

  it(`rejects a description longer than ${String(DESCRIPTION_MAX)} characters`, () => {
    const body = (length: number) => ({ name: 'A', description: 'a'.repeat(length) })

    expect(createProjectBodySchema.safeParse(body(DESCRIPTION_MAX + 1)).success).toBe(false)
    expect(createProjectBodySchema.safeParse(body(DESCRIPTION_MAX)).success).toBe(true)
  })
})

describe('patchProjectBodySchema — what a caller may change', () => {
  /*
   * AC-16, D18. An accepted no-op would still advance `updatedAt`, which
   * reorders a list sorted by it for a request that changed nothing. The message
   * is asserted because `parseBody` surfaces `issues[0].message` verbatim — this
   * string is the 400's body, so it has to read as copy rather than as a Zod
   * internal.
   */
  it('rejects an empty body with a message naming what is required', () => {
    const parsed = patchProjectBodySchema.safeParse({})

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('Send a name or a description to change.')
  })

  it('accepts a name alone', () => {
    expect(patchProjectBodySchema.parse({ name: 'Contacts' })).toEqual({ name: 'Contacts' })
  })

  it('accepts a description alone', () => {
    expect(patchProjectBodySchema.parse({ description: 'Notes' })).toEqual({ description: 'Notes' })
  })

  /* An explicit null is how a description is cleared — distinct from absent. */
  it('accepts an explicit null description', () => {
    expect(patchProjectBodySchema.parse({ description: null })).toEqual({ description: null })
  })

  it.each(['ownerUid', 'id', 'locationId', 'createdAt', 'deletedAt'])(
    'rejects a body carrying %s',
    (key) => {
      expect(patchProjectBodySchema.safeParse({ name: 'A', [key]: 'x' }).success).toBe(false)
    },
  )

  it.each([
    ['a blank name', { name: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a non-string name', { name: 42 }],
    ['an over-length name', { name: 'a'.repeat(NAME_MAX + 1) }],
    ['an over-length description', { description: 'a'.repeat(DESCRIPTION_MAX + 1) }],
    ['a non-string description', { description: 42 }],
  ])('rejects %s', (_label, body) => {
    expect(patchProjectBodySchema.safeParse(body).success).toBe(false)
  })
})

describe('projectIdSchema — what may appear in a path', () => {
  it.each(['abc123_-', 'a', 'a'.repeat(64)])('accepts %s', (id) => {
    expect(projectIdSchema.safeParse(id).success).toBe(true)
  })

  /*
   * AC-17. `..` and `.` are ids Firestore refuses outright, and `a/b` changes
   * the depth of the composed path rather than the document it names. Express's
   * single-segment `:param` already stops the slash case at the routing layer;
   * this makes it a property of the id rather than a dependency on how a router
   * happens to behave.
   */
  it.each(['', '..', '.', 'a/b', 'a b', 'a.b', 'a!b', 'a'.repeat(65)])('rejects %s', (id) => {
    expect(projectIdSchema.safeParse(id).success).toBe(false)
  })

  /* The message is a 404's worth of information, not a hint about the schema. */
  it('refuses without describing the rule it applied', () => {
    expect(projectIdSchema.safeParse('a/b').error?.issues[0]?.message).toBe(
      'That project could not be found.',
    )
  })
})

describe('storedProjectSchema — what Firestore hands back', () => {
  it('parses a complete document', () => {
    expect(storedProjectSchema.safeParse(complete).success).toBe(true)
  })

  /*
   * AC-20. A name and two timestamps are what a row is made of, so a document
   * missing one of them cannot be rendered and fails closed. `description` and
   * `locationId` degrade instead, which is `storedProfileSchema`'s split applied
   * to this document.
   */
  it.each(['name', 'createdAt', 'updatedAt'] as const)('rejects a document with no %s', (field) => {
    expect(storedProjectSchema.safeParse(without(field)).success).toBe(false)
  })

  it('rejects a document whose name is blank', () => {
    expect(storedProjectSchema.safeParse({ ...complete, name: '' }).success).toBe(false)
  })

  it('degrades a wrong-typed description and locationId rather than failing', () => {
    const parsed = storedProjectSchema.parse({ ...complete, description: 42, locationId: 42 })

    expect(parsed.description).toBeNull()
    expect(parsed.locationId).toBeNull()
  })

  /* A document written before `deletedAt` existed still parses, as absent. */
  it('treats an absent deletedAt as null', () => {
    expect(storedProjectSchema.parse(without('deletedAt')).deletedAt).toBeNull()
  })
})

describe('toProject', () => {
  it('puts ISO-8601 strings on the wire, not Timestamps', () => {
    const project = toProject('proj-1', storedProjectSchema.parse(complete))

    expect(project).toEqual({
      id: 'proj-1',
      name: 'Contact dashboard',
      description: 'Lists and filters contacts',
      locationId: 'lUanVn0CtZJTlymH8ySo',
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:21:40.000Z',
    })
  })

  /*
   * AC-3, D23. `deletedAt` is not on the `Project` interface at all, so it
   * cannot reach the wire by accident — a deleted project is never returned, and
   * nothing outside these handlers needs to know when one was.
   */
  it('never emits a deletedAt key', () => {
    const deleted = storedProjectSchema.parse({
      ...complete,
      deletedAt: Timestamp.fromMillis(1_700_000_900_000),
    })

    expect(Object.keys(toProject('proj-1', deleted))).not.toContain('deletedAt')
  })
})
