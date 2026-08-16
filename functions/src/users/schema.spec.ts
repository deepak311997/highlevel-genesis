import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import { DISPLAY_NAME_MAX, profileBodySchema, storedProfileSchema, toProfile } from './schema'

/**
 * The two schemas that guard `users/{uid}`, from opposite directions.
 *
 * `profileBodySchema` guards what a caller may send. It is `.strict()`, and that
 * is the load-bearing call: the trap this slice exists to close is a route that
 * authenticates the caller and then trusts a uid it was handed, so a body
 * carrying `uid` or `email` has to be a refusal rather than a field we happened
 * not to read.
 *
 * `storedProfileSchema` guards what Firestore hands back. `snapshot.data() as T`
 * is a lie the compiler believes — a half-written document from an interrupted
 * write parses as a complete one — so the document is parsed, and a document
 * that cannot describe a profile is *known* not to.
 */

const complete = {
  email: 'alice@example.test',
  displayName: null,
  createdAt: Timestamp.fromMillis(1_700_000_000_000),
  updatedAt: Timestamp.fromMillis(1_700_000_500_000),
}

/** The complete document with one field missing — a half-written write. */
function without(field: keyof typeof complete): Record<string, unknown> {
  return Object.fromEntries(Object.entries(complete).filter(([key]) => key !== field))
}

describe('profileBodySchema — what a caller may send', () => {
  it('accepts an empty body, since every field is optional', () => {
    expect(profileBodySchema.safeParse({}).success).toBe(true)
  })

  it('accepts a display name', () => {
    expect(profileBodySchema.parse({ displayName: 'Alice' })).toEqual({ displayName: 'Alice' })
  })

  it('accepts an explicit null, which is how a name is cleared', () => {
    expect(profileBodySchema.parse({ displayName: null })).toEqual({ displayName: null })
  })

  /*
   * R1, as an assertion rather than a convention. A dropped unknown key would
   * make "we do not read `uid`" true only for as long as nobody adds a read.
   */
  it('rejects a body carrying a uid', () => {
    expect(profileBodySchema.safeParse({ uid: 'bob' }).success).toBe(false)
  })

  /* The address is Firebase Auth's to own — D6. It is never taken from a body. */
  it('rejects a body carrying an email', () => {
    expect(profileBodySchema.safeParse({ email: 'attacker@example.test' }).success).toBe(false)
  })

  it('rejects a display name of the wrong type', () => {
    expect(profileBodySchema.safeParse({ displayName: 42 }).success).toBe(false)
  })

  it(`rejects a display name longer than ${String(DISPLAY_NAME_MAX)} characters`, () => {
    expect(profileBodySchema.safeParse({ displayName: 'a'.repeat(81) }).success).toBe(false)
    expect(profileBodySchema.safeParse({ displayName: 'a'.repeat(80) }).success).toBe(true)
  })

  it('measures the length after trimming, so padding cannot be smuggled in', () => {
    const padded = ` ${'a'.repeat(80)} `

    expect(profileBodySchema.parse({ displayName: padded })).toEqual({
      displayName: 'a'.repeat(80),
    })
  })
})

describe('storedProfileSchema — what Firestore hands back', () => {
  it('parses a complete document', () => {
    expect(storedProfileSchema.safeParse(complete).success).toBe(true)
  })

  /*
   * AC-11. A profile with no address cannot be rendered — the card shows the
   * address when there is no display name — so it fails closed rather than
   * emitting a half-populated profile the user cannot act on.
   */
  it('rejects a document with no email', () => {
    expect(storedProfileSchema.safeParse(without('email')).success).toBe(false)
  })

  it('rejects a document with no createdAt', () => {
    expect(storedProfileSchema.safeParse(without('createdAt')).success).toBe(false)
  })

  /*
   * A display name is cosmetic, so a wrong-typed one degrades to "no name"
   * rather than condemning the whole document. `email` and the timestamps get no
   * such fallback — without them there is nothing to render.
   */
  it('falls back to no display name rather than failing on a wrong-typed one', () => {
    const parsed = storedProfileSchema.parse({ ...complete, displayName: 42 })

    expect(parsed.displayName).toBeNull()
  })
})

describe('toProfile', () => {
  it('puts ISO-8601 strings on the wire, not Timestamps', () => {
    const profile = toProfile(storedProfileSchema.parse(complete))

    expect(profile).toEqual({
      email: 'alice@example.test',
      displayName: null,
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:21:40.000Z',
    })
    expect(new Date(profile.createdAt).toISOString()).toBe(profile.createdAt)
  })
})
