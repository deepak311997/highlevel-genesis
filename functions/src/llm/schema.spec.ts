import { describe, expect, it } from 'vitest'

import { generateBodySchema } from './schema'

/**
 * `POST /generate`'s body — one turn, in one request.
 *
 * **`content` is the prompt; `retry: true` re-runs the turn already stored.**
 * The prompt travels here because a turn that took two requests could fail
 * between them: the message landed, the client died, and the transcript kept a
 * prompt no reply was coming for. The durability that split was protecting is
 * preserved by ordering inside the handler — the user turn is written before the
 * stream opens — rather than by the extra round trip.
 *
 * `.strict()` is still load-bearing, and so is the refine. Exactly one of the
 * two shapes: a body carrying both is a caller that has not decided what it
 * wants, and a body carrying neither would silently generate a second reply to
 * whatever the transcript happens to end with. `role`, `uid` and the rest stay
 * refused for Slice 4's reasons — `uid` doubly so, since a uid in a payload is a
 * second, forgeable source of identity.
 *
 * `projectId` is checked against the **same** `projectIdSchema` the path routes
 * use, so `/generate` and `/api/projects/:projectId/*` cannot disagree about what
 * an id is.
 */

const VALID = { projectId: 'proj-1', content: 'Build a contacts view' }

describe('generateBodySchema — what a caller may send', () => {
  it('accepts a project id and a prompt', () => {
    expect(generateBodySchema.parse(VALID)).toEqual(VALID)
  })

  it('accepts a retry, which carries no prompt', () => {
    expect(generateBodySchema.safeParse({ projectId: 'proj-1', retry: true }).success).toBe(true)
  })

  /* Exactly one shape: neither is a reply to nothing, both is undecided. */
  it.each([
    ['neither', { projectId: 'proj-1' }],
    ['both', { projectId: 'proj-1', content: 'hi', retry: true }],
    ['retry: false', { projectId: 'proj-1', retry: false }],
  ])('refuses a body carrying %s', (_name, body) => {
    expect(generateBodySchema.safeParse(body).success).toBe(false)
  })

  /* The prompt is validated here exactly as the message route validated it. */
  it('refuses a prompt past the 4,000-character cap', () => {
    expect(
      generateBodySchema.safeParse({ projectId: 'proj-1', content: 'a'.repeat(4001) }).success,
    ).toBe(false)
  })

  it('refuses a whitespace-only prompt, after trimming', () => {
    expect(generateBodySchema.safeParse({ projectId: 'proj-1', content: '   ' }).success).toBe(
      false,
    )
  })

  it('accepts an id at the 64-character limit', () => {
    const projectId = 'a'.repeat(64)

    expect(generateBodySchema.safeParse({ projectId, content: 'hi' }).success).toBe(true)
  })

  /*
   * `content` is now accepted and validated; everything else a chat payload
   * tends to carry is still the server's. `role` and `uid` are refused for the
   * reasons Slice 4 recorded — `uid` doubly so, since a uid in a payload is a
   * second, forgeable source of identity, and `messages` and `model` because
   * the transcript and the model are the server's to decide.
   */
  it.each(['role', 'uid', 'prompt', 'messages', 'model'])(
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
