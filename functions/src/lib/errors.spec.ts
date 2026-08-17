import type { NextFunction, Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { errorHandler, HttpError, sendHttpError } from './errors'

/**
 * Returns the spies alongside the response so assertions read them directly.
 * Asserting on `res.status` instead trips `unbound-method` — the rule is right
 * that a method plucked off an object loses its receiver.
 */
function mockResponse() {
  const status = vi.fn(() => res)
  const json = vi.fn(() => res)
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

/**
 * The envelope, without Express.
 *
 * `/generate` is an `onRequest` function rather than a route on the `api` app,
 * so it has no error-handling middleware to fall through to — and its refusals
 * still have to be byte-identical to every other route's, or a client would need
 * two ways to read a failure. These cases assert the sharing rather than
 * assuming it.
 */
describe('sendHttpError', () => {
  it('answers an HttpError with its own status and code', () => {
    const { res, status, json } = mockResponse()

    sendHttpError(new HttpError(404, 'That project no longer exists.', 'not_found'), res)

    expect(status).toHaveBeenCalledWith(404)
    expect(json).toHaveBeenCalledWith({
      error: 'That project no longer exists.',
      code: 'not_found',
    })
  })

  it('reduces anything else to a generic 500', () => {
    const { res, status, json } = mockResponse()

    sendHttpError(new Error('connection string: postgres://user:pw@host'), res)

    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({ error: 'Internal error', code: 'internal' })
  })

  /* One implementation, so the two callers cannot drift. */
  it('is what errorHandler answers with', () => {
    const direct = mockResponse()
    const viaExpress = mockResponse()

    sendHttpError(new HttpError(409, 'Too many.', 'message_limit'), direct.res)
    errorHandler(new HttpError(409, 'Too many.', 'message_limit'), req, viaExpress.res, next)

    expect(direct.json.mock.calls).toEqual(viaExpress.json.mock.calls)
    expect(direct.status.mock.calls).toEqual(viaExpress.status.mock.calls)
  })
})
