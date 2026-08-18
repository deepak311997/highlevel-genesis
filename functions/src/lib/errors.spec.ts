import type { NextFunction, Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { errorHandler, HttpError } from './errors'

/**
 * Returns the spies alongside the response so assertions read them directly.
 * Asserting on `res.status` instead trips `unbound-method` — the rule is right
 * that a method plucked off an object loses its receiver.
 */
function mockResponse() {
  const status = vi.fn(() => res)
  // Typed with its argument so a test can assert on the exact body, keys and
  // all — `toHaveBeenCalledWith` treats an explicit `undefined` value as absent,
  // which is precisely the distinction `detail` turns on.
  const json = vi.fn((_body: unknown) => res)
  const res = { status, json } as unknown as Response
  return { res, status, json }
}

const req = {} as Request
const next = (() => undefined) as unknown as NextFunction

describe('errorHandler', () => {
  let error: ReturnType<typeof vi.fn>

  beforeEach(() => {
    error = vi.fn()
    vi.stubGlobal('console', { ...console, error, info: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('surfaces a known HttpError verbatim', () => {
    const { res, status, json } = mockResponse()

    errorHandler(new HttpError(429, 'Too many attempts', 'throttled'), req, res, next)

    expect(status).toHaveBeenCalledWith(429)
    expect(json).toHaveBeenCalledWith({ error: 'Too many attempts', code: 'throttled' })
  })

  /*
   * `detail` is upstream's own text about the *request* — HighLevel's message on a proxied call.
   */
  it('includes a detail when the error carries one', () => {
    const { res, json } = mockResponse()

    errorHandler(
      new HttpError(
        404,
        'HighLevel could not find that record.',
        'hl_not_found',
        'Contact not found',
      ),
      req,
      res,
      next,
    )

    expect(json).toHaveBeenCalledWith({
      error: 'HighLevel could not find that record.',
      code: 'hl_not_found',
      detail: 'Contact not found',
    })
  })

  /*
   * The key is absent, not `null`. `exactOptionalPropertyTypes` distinguishes
   * the two in the type, and the wire shape should agree: a client reading
   * `detail` gets a string or nothing, never a null to special-case.
   */
  it('omits the key entirely when the error carries no detail', () => {
    const { res, json } = mockResponse()

    errorHandler(new HttpError(403, 'Not allowed.', 'route_not_allowed'), req, res, next)

    expect(json.mock.lastCall).toStrictEqual([{ error: 'Not allowed.', code: 'route_not_allowed' }])
  })

  it('reduces an unknown error to a generic 500 for the client', () => {
    const { res, status, json } = mockResponse()

    errorHandler(new Error('connection string: postgres://user:pw@host'), req, res, next)

    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({ error: 'Internal error', code: 'internal' })
  })

  // The registration endpoint hands a plaintext password to the Admin SDK, and
  // Firebase errors carry the failing request on the error object. Logging the
  // error whole is what puts that password in Cloud Logging.
  it('does not log the payload carried by a rejected Admin SDK call', () => {
    const err = Object.assign(new Error('Request failed'), {
      code: 'auth/internal-error',
      response: { body: { password: 'hunter2', oobCode: 'ABC123' } },
    })

    errorHandler(err, req, mockResponse().res, next)

    const logged = JSON.stringify(error.mock.calls)
    expect(logged).not.toContain('hunter2')
    expect(logged).not.toContain('ABC123')
    expect(logged).toContain('auth/internal-error')
  })
})
