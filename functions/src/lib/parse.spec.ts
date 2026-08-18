import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { HttpError } from './errors'
import { parseBody } from './parse'

/**
 * The Zod half of the API boundary.
 *
 * The architecture decision has two halves — "scopes every query by the uid from the token" and
 * "parses the payload with Zod" — and this is the second. What is worth testing is not that Zod
 * works but that a rejection arrives as an `HttpError` the terminal handler already knows how to
 * render, with a code a client can branch on and a message that names the offending field.
 */

const schema = z.object({ displayName: z.string().max(5).nullable().optional() }).strict()

/** Only `body` is read, so only `body` is supplied. */
function request(body: unknown): Request {
  return { body } as Request
}

describe('parseBody', () => {
  it('returns the parsed data on a valid body', () => {
    expect(parseBody(schema, request({ displayName: 'Alice' }))).toEqual({ displayName: 'Alice' })
  })

  /*
   * `.strict()` is what turns the trap into an assertion: a body carrying a key
   * the route does not own is refused outright, rather than silently dropped and
   * then assumed never to have arrived.
   */
  it('throws HttpError 400 with code invalid_body on an unknown key', () => {
    try {
      parseBody(schema, request({ uid: 'someone-else' }))
      expect.unreachable('an unknown key must not parse')
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).status).toBe(400)
      expect((err as HttpError).code).toBe('invalid_body')
    }
  })

  it("carries Zod's own message so the caller learns which field", () => {
    expect(() => parseBody(schema, request({ displayName: 'far too long' }))).toThrow(
      /5 characters/i,
    )
  })

  /*
   * `express.json()` yields `{}` for a bodyless request whose content-type it does not match,
   * and `undefined` when the middleware never ran at all.
   */
  it('treats an absent body as {}', () => {
    expect(parseBody(schema, request(undefined))).toEqual({})
  })

  it('rejects a value of the wrong type', () => {
    expect(() => parseBody(schema, request({ displayName: 42 }))).toThrow(HttpError)
  })
})
