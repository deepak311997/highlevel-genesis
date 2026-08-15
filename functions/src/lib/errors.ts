import type { Request, RequestHandler, Response, NextFunction } from 'express'

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
 * Terminal error handler.
 *
 * Known `HttpError`s are surfaced verbatim; anything else becomes a generic 500
 * so an internal message never reaches a client. Express identifies an error
 * handler by its four-argument signature, so `next` must stay in the list.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return
  }

  console.error('Unhandled error', err)
  res.status(500).json({ error: 'Internal error', code: 'internal' })
}
