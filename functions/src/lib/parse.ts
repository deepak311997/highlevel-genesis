import type { Request } from 'express'
import type { ZodType } from 'zod'

import { HttpError } from './errors'

/**
 * Parse a request body, or refuse the request.
 *
 * One place, so a new route inherits the error shape rather than inventing one: a
 * 400 carrying `invalid_body` and Zod's own message, which is the part that names
 * the offending field. The return value is the *narrowed* data, so a handler
 * cannot go on reading the raw body it was handed.
 */
export function parseBody<T>(schema: ZodType<T>, req: Request): T {
  /*
   * `?? {}` relaxes nothing: `express.json()` already yields `{}` for a bodyless
   * request whose content-type it does not match, and a `.strict()` schema still
   * rejects every unknown key.
   */
  const parsed = schema.safeParse(req.body ?? {})

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? 'Check the details and try again.',
      'invalid_body',
    )
  }

  return parsed.data
}
