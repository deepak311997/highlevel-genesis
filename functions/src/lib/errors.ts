import type { Request, RequestHandler, Response, NextFunction } from 'express'

import { describeError } from './log'

/** An error with an HTTP status that is safe to show a user. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Wrap an async route so its rejections reach the error handler.
 *
 * Express 4 calls handlers synchronously and ignores the returned promise, so a
 * rejection inside a bare `async` handler becomes an unhandled rejection and the
 * request hangs until it times out. Wrapping is the fix; a try/catch in every
 * route is the same fix written many times.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next)
  }
}

/**
 * The JSON envelope, extracted so a non-Express handler can answer with it too.
 *
 * `/generate` is an `onRequest` function rather than a route on the `api` Express
 * app, so it has no error-handling middleware to fall through to — but its
 * refusals have to be byte-identical to every other route's, or a client would
 * need two ways to read a failure. One function, two callers.
 *
 * Known `HttpError`s are surfaced verbatim; anything else becomes a generic 500
 * so an internal message never reaches a client.
 */
export function sendHttpError(err: unknown, res: Response): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return
  }

  // Redacted, not serialised whole. Firebase errors carry the failing request
  // on the error object, so `console.error(err)` on a rejected Admin SDK call
  // is enough to put a plaintext password into Cloud Logging.
  console.error('Unhandled error', describeError(err))
  res.status(500).json({ error: 'Internal error', code: 'internal' })
}

/**
 * Terminal error handler — the Express adapter for {@link sendHttpError}.
 *
 * Express identifies an error handler by its four-argument signature, so `next`
 * must stay in the list even though nothing reads it.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  sendHttpError(err, res)
}
