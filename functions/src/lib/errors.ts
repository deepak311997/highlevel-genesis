import type { Request, RequestHandler, Response, NextFunction } from 'express'

import { describeError } from './log'

/**
 * An error with an HTTP status that is safe to show a user.
 *
 * `detail` is the narrowest field: **upstream's own text about the request**,
 * never ours about our internals. A proxied HighLevel failure carries their
 * message so a generated app can act on it; nothing else should use it.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Wrap an async route so its rejections reach the error handler. Express 4 calls
 * handlers synchronously and ignores the returned promise, so a rejection inside a
 * bare `async` handler becomes an unhandled rejection and the request hangs.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next)
  }
}

/**
 * The terminal error handler, and the one JSON envelope every route answers with.
 * Known `HttpError`s are surfaced verbatim; anything else becomes a generic 500.
 *
 * `/generate` reaches this too — it is an Express app rather than a hand-rolled
 * wrapper precisely so its refusals before the flush are byte-identical to every
 * other route's. Express identifies an error handler by its four-argument
 * signature, so `next` must stay even though nothing reads it.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    // Spread rather than assignment: `exactOptionalPropertyTypes` distinguishes an
    // absent key from an explicit `undefined`, and the wire shape should agree.
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.detail === undefined ? {} : { detail: err.detail }),
    })
    return
  }

  // Redacted, not serialised whole: Firebase errors carry the failing request on
  // the object, so `console.error(err)` can put a plaintext password in a log.
  console.error('Unhandled error', describeError(err))
  res.status(500).json({ error: 'Internal error', code: 'internal' })
}
