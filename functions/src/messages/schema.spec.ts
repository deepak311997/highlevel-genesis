import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import { CONTENT_MAX, messagesPath, storedMessageSchema, toMessage } from './schema'

/**
 * The three schemas around `users/{uid}/projects/{projectId}/messages/{id}`.
 *
 * The body schema is the security boundary of the slice, and `.strict()` is the load-bearing
 * call on it. `role` is the server's to assign — from Slice 5 on the transcript *is* the LLM's
 * context, so a client that could author an assistant turn could write its own future prompt —
 * and `id`, `seq` and `createdAt` are the server's too. A body carrying any of them is refused
 * rather than quietly stripped, which is what makes "the server owns `role`" a property rather
 * than a promise.
 */

const complete = {
  role: 'user',
  content: 'build a contact dashboard',
  seq: 0,
  createdAt: Timestamp.fromMillis(1_700_000_000_000),
}

/** The complete document with one field missing — a half-written write. */
function without(field: keyof typeof complete): Record<string, unknown> {
  return Object.fromEntries(Object.entries(complete).filter(([key]) => key !== field))
}

describe('messagesPath', () => {
  /*
   * Composed in one place from `projectsPath`, so the three segments of the path cannot drift: a
   * message lives under its project, which lives under its owner.
   */
  it('nests the collection under the project, under the owner', () => {
    expect(messagesPath('alice', 'proj-1')).toBe('users/alice/projects/proj-1/messages')
  })
})

describe('storedMessageSchema — what Firestore hands back', () => {
  it('parses a complete document', () => {
    expect(storedMessageSchema.safeParse(complete).success).toBe(true)
  })

  it('parses an assistant document', () => {
    expect(storedMessageSchema.safeParse({ ...complete, role: 'assistant', seq: 1 }).success).toBe(
      true,
    )
  })

  /*
   * Nothing here carries a `.catch`: content is the whole message, the timestamp is how it is
   * ordered and dated, and `seq` is what breaks the commit-timestamp tie.
   */
  it.each(['role', 'content', 'seq', 'createdAt'] as const)(
    'rejects a document with no %s',
    (field) => {
      expect(storedMessageSchema.safeParse(without(field)).success).toBe(false)
    },
  )

  it('rejects a document whose content is blank and reports no failure', () => {
    expect(storedMessageSchema.safeParse({ ...complete, content: '' }).success).toBe(false)
  })

  /** **A failed turn has no prose, and it is still a message.** */
  it('accepts a blank document that carries the reason it is blank', () => {
    expect(
      storedMessageSchema.safeParse({ ...complete, content: '', error: 'upstream' }).success,
    ).toBe(true)
  })

  /*
   * A bubble that is neither the user's nor the assistant's has no side of the transcript to sit
   * on, so an unrecognised role is unreadable by the same rule as a missing field.
   */
  it.each(['system', 'tool', '', 'User'])('rejects the role %s', (role) => {
    expect(storedMessageSchema.safeParse({ ...complete, role }).success).toBe(false)
  })

  /*
   * D11, and it matters far more now than it did in Slice 4. The stored schema carries **no
   * maximum** on content: a generated reply runs to `max_tokens`, which is three orders of
   * magnitude past the 4,000-character request-body limit.
   */
  it('accepts stored content longer than the request-body maximum', () => {
    const long = 'a'.repeat(CONTENT_MAX * 10)

    expect(storedMessageSchema.safeParse({ ...complete, content: long }).success).toBe(true)
  })

  it('rejects a non-integer or negative seq', () => {
    expect(storedMessageSchema.safeParse({ ...complete, seq: 1.5 }).success).toBe(false)
    expect(storedMessageSchema.safeParse({ ...complete, seq: -1 }).success).toBe(false)
  })

  /*
   * Slice 4's documents have no `truncated` key at all, and a required field here would make
   * every message written before this slice unreadable — silently emptying every transcript that
   * already exists.
   */
  it('parses a Slice-4-shaped document and reads it as not truncated', () => {
    const parsed = storedMessageSchema.safeParse(complete)

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.truncated).toBe(false)
  })

  it('round-trips truncated: true', () => {
    const parsed = storedMessageSchema.safeParse({ ...complete, truncated: true })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.truncated).toBe(true)
  })

  /* Present but not a boolean is corruption, not absence — so it fails closed. */
  it.each(['yes', 1, null])('rejects a truncated field of %s', (truncated) => {
    expect(storedMessageSchema.safeParse({ ...complete, truncated }).success).toBe(false)
  })
})

describe('toMessage', () => {
  it('puts an ISO-8601 string on the wire, not a Timestamp', () => {
    const message = toMessage('msg-1', storedMessageSchema.parse(complete))

    expect(message).toEqual({
      id: 'msg-1',
      role: 'user',
      content: 'build a contact dashboard',
      createdAt: '2023-11-14T22:13:20.000Z',
      truncated: false,
      error: null,
    })
  })

  /*
   * `seq` is an ordering mechanism the server owns, and the array it produces is already in
   * order — so it has no wire representation at all.
   */
  it('never emits a seq key', () => {
    const message = toMessage('msg-1', storedMessageSchema.parse({ ...complete, seq: 1 }))

    expect(Object.keys(message).sort()).toEqual([
      'content',
      'createdAt',
      'error',
      'id',
      'role',
      'truncated',
    ])
  })

  /** AC-40's server half: the flag is on the wire for every message. */
  it('carries truncated onto the wire shape', () => {
    const stored = storedMessageSchema.parse({ ...complete, truncated: true })

    expect(toMessage('msg-1', stored).truncated).toBe(true)
  })
})
