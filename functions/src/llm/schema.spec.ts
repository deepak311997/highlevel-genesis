import { describe, expect, it } from 'vitest'

import { generateBodySchema } from './schema'

/**
 * `POST /generate`'s body — `{ projectId }`, and nothing else.
 *
 * `.strict()` is the load-bearing call, and D2 is the reason. The prompt is
 * **not** in this body: the model's input is the transcript, and the transcript
 * is the server's own record. A body carrying the prompt would let the client's
 * copy disagree with what is stored — a caller could stream a reply to a prompt
 * that is not in the history the reply gets appended to — and it would duplicate
 * both the 4,000-character validation and the 200-message cap in a second place.
 *
 * It is also what makes Retry work with no new user message and no special case:
 * the endpoint's whole input is a project id.
 *
 * `projectId` is checked against the **same** `projectIdSchema` the path routes
 * use, so `/generate` and `/api/projects/:projectId/*` cannot disagree about what
 * an id is.
 */

const VALID = { projectId: 'proj-1' }

describe('generateBodySchema — what a caller may send', () => {
  it('accepts a project id on its own', () => {
    expect(generateBodySchema.parse(VALID)).toEqual(VALID)
  })

  it('accepts an id at the 64-character limit', () => {
    const projectId = 'a'.repeat(64)

    expect(generateBodySchema.safeParse({ projectId }).success).toBe(true)
  })

  /*
   * D2. `content` is the tempting one and the one that must be refused: a body
   * carrying the prompt is the shape every chat tutorial uses, and accepting it
   * would put the client in charge of what the model is asked. `role` and `uid`
   * are the server's for the reasons Slice 4 recorded — `uid` doubly so, since a
   * uid in a payload is a second, forgeable source of identity.
   */
  it.each(['content', 'role', 'uid', 'prompt', 'messages', 'model'])(
    'refuses a body carrying %s alongside a valid projectId',
    (key) => {
      expect(generateBodySchema.safeParse({ ...VALID, [key]: 'x' }).success).toBe(false)
    },
  )

  /** AC-24. Each of these is a 400 `invalid_body` before any Firestore read. */
  it.each([
    ['a missing projectId', {}],
    ['a non-string projectId', { projectId: 42 }],
    ['a null projectId', { projectId: null }],
    ['an empty projectId', { projectId: '' }],
    ['a 65-character projectId', { projectId: 'a'.repeat(65) }],
    ['a path-traversal projectId', { projectId: '..' }],
    ['a projectId containing a slash', { projectId: 'a/b' }],
    ['a projectId containing punctuation', { projectId: 'bad!id' }],
  ])('refuses %s', (_label, body) => {
    expect(generateBodySchema.safeParse(body).success).toBe(false)
  })

  /*
   * The copy is deliberately the *project-shaped* one, because that is what the
   * caller is being told: a malformed id and a stranger's id are the same answer
   * under this path shape. `parseBody` surfaces `issues[0].message`, so this
   * string is the 400's body.
   */
  it('refuses a malformed id with the project copy, not a regex complaint', () => {
    const parsed = generateBodySchema.safeParse({ projectId: 'bad!id' })

    expect(parsed.success).toBe(false)
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toBe(
      'That project could not be found.',
    )
  })
})
