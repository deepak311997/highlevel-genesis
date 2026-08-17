import type { Request } from 'express'
import type { ZodType } from 'zod'

import { HttpError } from './errors'

/**
 * Parse a request body, or refuse the request.
 *
 * The API's data-access rule has two halves: a route scopes every query by the
 * uid **from the token**, and it parses its payload with Zod. This is the second
 * half, in one place, so that a new route inherits the error shape rather than
 * inventing one — a 400 carrying `invalid_body` and Zod's own message, which is
 * the part that names the offending field.
 *
 * Parse, don't validate: the return value is the *narrowed* data, so a handler
 * cannot accidentally go on reading the raw body it was handed.
 */
export function parseBody<T>(schema: ZodType<T>, req: Request): T {
  /*
   * `?? {}` is deliberate, and it relaxes nothing.
   *
   * `express.json()` already yields `{}` for a bodyless request whose
   * content-type it does not match; the substitution covers the remaining case,
   * where the middleware never ran at all. A `.strict()` schema still rejects
   * every unknown key, so the only body this admits is one with no keys.
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
