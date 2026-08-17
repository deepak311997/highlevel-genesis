import type { Request, RequestHandler, Response, NextFunction } from 'express'

import { describeError } from './log'

/**
 * An error with an HTTP status that is safe to show a user.
 *
 * `detail` is the fourth field and the narrowest: **upstream's own text about
 * the request**, never ours about our internals (D19). A proxied HighLevel
 * failure carries their message so the preview can say what was actually wrong
 * with the call, and a generated app can act on it. Nothing else should use it —
 * an internal message belongs in a log, not on the wire.
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
 * The terminal error handler, and the one JSON envelope every route answers with.
 *
 * Known `HttpError`s are surfaced verbatim; anything else becomes a generic 500
 * so an internal message never reaches a client.
 *
 * `/generate` reaches this too. It is a separate `onRequest` function, but it is
 * an Express app rather than a hand-rolled wrapper precisely so that it can
 * mount this — its refusals before the flush are byte-identical to every other
 * route's, and a client needs one way to read a failure rather than two.
 * `terminalErrorHandler` in `generate.ts` delegates here and only takes over
 * once the headers are gone and the status line is spent.
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
  if (err instanceof HttpError) {
    // Spread rather than assignment: `exactOptionalPropertyTypes` distinguishes
    // an absent key from an explicit `undefined`, and the wire shape should
    // agree — a client reads `detail` as a string or as nothing, never as null.
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.detail === undefined ? {} : { detail: err.detail }),
    })
    return
  }

  // Redacted, not serialised whole. Firebase errors carry the failing request
  // on the error object, so `console.error(err)` on a rejected Admin SDK call
  // is enough to put a plaintext password into Cloud Logging.
  console.error('Unhandled error', describeError(err))
  res.status(500).json({ error: 'Internal error', code: 'internal' })
}
