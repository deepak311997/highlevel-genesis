import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import {
  CONTENT_MAX,
  createMessageBodySchema,
  messagesPath,
  storedMessageSchema,
  toMessage,
} from './schema'

/**
 * The three schemas around `users/{uid}/projects/{projectId}/messages/{id}`.
 *
 * The body schema is the security boundary of the slice, and `.strict()` is the
 * load-bearing call on it. `role` is the server's to assign — from Slice 5 on the
 * transcript *is* the LLM's context, so a client that could author an assistant
 * turn could write its own future prompt — and `id`, `seq` and `createdAt` are
 * the server's too. A body carrying any of them is refused rather than quietly
 * stripped, which is what makes "the server owns `role`" a property rather than
 * a promise.
 *
 * `storedMessageSchema` guards what Firestore hands back, for the same reason
 * `storedProjectSchema` does: `snapshot.data() as T` is a lie the compiler
 * believes.
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
   * Composed in one place from `projectsPath`, so the three segments of the path
   * cannot drift: a message lives under its project, which lives under its
   * owner. That nesting is what makes ownership structural rather than a `where`
   * clause someone has to remember.
   */
  it('nests the collection under the project, under the owner', () => {
    expect(messagesPath('alice', 'proj-1')).toBe('users/alice/projects/proj-1/messages')
  })
})

describe('createMessageBodySchema — what a caller may send', () => {
  it('accepts content on its own', () => {
    expect(createMessageBodySchema.parse({ content: 'build a contact dashboard' })).toEqual({
      content: 'build a contact dashboard',
    })
  })

  it('trims content, so padding cannot be smuggled past the limit', () => {
    expect(createMessageBodySchema.parse({ content: '  hi  ' })).toEqual({ content: 'hi' })
  })

  /*
   * AC-11, D5, R3. Every one of these is a field the server owns, and `role` is
   * the one that matters: a client that can set it can author an assistant turn,
   * which from Slice 5 on is self-service prompt injection into a context that
   * also carries HighLevel API knowledge and the user's files.
   */
  it.each(['role', 'id', 'seq', 'createdAt'])('rejects a body carrying %s', (key) => {
    expect(createMessageBodySchema.safeParse({ content: 'x', [key]: 'x' }).success).toBe(false)
  })

  /*
   * Spelled out rather than folded into the loop above, because this exact body
   * is the shape every chat tutorial uses and the reason D5 needed deciding
   * rather than defaulting. AC-11 names it explicitly.
   */
  it('rejects { role: "assistant", content } — a client cannot author an assistant turn', () => {
    expect(
      createMessageBodySchema.safeParse({ role: 'assistant', content: 'I am the model' }).success,
    ).toBe(false)
  })

  /** AC-12. */
  it.each([
    ['missing content', {}],
    ['blank content', { content: '' }],
    ['whitespace-only content', { content: '   ' }],
    ['non-string content', { content: 42 }],
    ['null content', { content: null }],
  ])('rejects %s', (_label, body) => {
    expect(createMessageBodySchema.safeParse(body).success).toBe(false)
  })

  it(`rejects content longer than ${String(CONTENT_MAX)} characters and accepts one at the limit`, () => {
    const body = (length: number) => ({ content: 'a'.repeat(length) })

    expect(createMessageBodySchema.safeParse(body(CONTENT_MAX + 1)).success).toBe(false)
    expect(createMessageBodySchema.safeParse(body(CONTENT_MAX)).success).toBe(true)
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
   * AC-15. Nothing here carries a `.catch`: content is the whole message, the
   * timestamp is how it is ordered and dated, and `seq` is what breaks the
   * commit-timestamp tie. A document missing one of them cannot be rendered in
   * the right place, so it is *known* to be unusable and omitted (D27) rather
   * than drawn as a bubble with a blank in it.
   */
  it.each(['role', 'content', 'seq', 'createdAt'] as const)(
    'rejects a document with no %s',
    (field) => {
      expect(storedMessageSchema.safeParse(without(field)).success).toBe(false)
    },
  )

  it('rejects a document whose content is blank', () => {
    expect(storedMessageSchema.safeParse({ ...complete, content: '' }).success).toBe(false)
  })

  /*
   * D27. A bubble that is neither the user's nor the assistant's has no side of
   * the transcript to sit on, so an unrecognised role is unreadable by the same
   * rule as a missing field.
   */
  it.each(['system', 'tool', '', 'User'])('rejects the role %s', (role) => {
    expect(storedMessageSchema.safeParse({ ...complete, role }).success).toBe(false)
  })

  /*
   * D11. The stored schema carries **no maximum** on content: the echo of a
   * 4,000-character prompt is longer than one, and a stored document is not a
   * request body. A maximum here would make the server's own write unreadable.
   */
  it('accepts stored content longer than the request-body maximum', () => {
    const long = `You said: ${'a'.repeat(CONTENT_MAX)}`

    expect(storedMessageSchema.safeParse({ ...complete, content: long }).success).toBe(true)
  })

  it('rejects a non-integer or negative seq', () => {
    expect(storedMessageSchema.safeParse({ ...complete, seq: 1.5 }).success).toBe(false)
    expect(storedMessageSchema.safeParse({ ...complete, seq: -1 }).success).toBe(false)
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
    })
  })

  /*
   * AC-2. `seq` is an ordering mechanism the server owns, and the array it
   * produces is already in order — so it has no wire representation at all.
   * Leaving it off the `Message` interface is what stops it reaching one by
   * accident.
   */
  it('never emits a seq key', () => {
    const message = toMessage('msg-1', storedMessageSchema.parse({ ...complete, seq: 1 }))

    expect(Object.keys(message).sort()).toEqual(['content', 'createdAt', 'id', 'role'])
  })
})
