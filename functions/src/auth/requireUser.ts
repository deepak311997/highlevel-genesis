import type { Request, Response } from 'express'

import { getAdminAuth } from '../lib/firebase'
import { HttpError } from '../lib/errors'

/**
 * Authenticate a request and prove the address behind it.
 *
 * **Both halves matter, and the second is the one that gets skipped.** A router
 * guard stops a browser and stops nobody calling the API directly with a valid
 * token, and Firestore rules say nothing about a Cloud Function's surface — so
 * `email_verified` is read from the decoded token here, on every authenticated
 * endpoint.
 *
 * A wrapper rather than middleware, because the uid has to reach the handler.
 * Middleware would leave it on `req` or `res.locals`: untyped at every call site,
 * and ambient — a handler that forgot to check would still compile and read
 * `undefined` as a uid.
 */
export type VerifiedHandler = (req: Request, res: Response, uid: string) => Promise<void>

const BEARER = /^Bearer (.+)$/

/**
 * Returns an **async** handler, mounted with `asyncHandler` at the route, so
 * rejections stay on a path the error handler already owns and a test can await
 * the decision instead of racing a microtask.
 */
export function withVerifiedUser(
  handler: VerifiedHandler,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const header = req.header('authorization')?.trim()
    const token = header === undefined ? null : (BEARER.exec(header)?.[1]?.trim() ?? null)

    if (token === null || token === '') {
      throw new HttpError(401, 'Sign in and try again.', 'unauthenticated')
    }

    let decoded: { uid: string; email_verified?: boolean }
    try {
      decoded = await getAdminAuth().verifyIdToken(token)
    } catch {
      // Expired, malformed and forged are the same answer to the caller; telling
      // them which is a tuning signal and nothing else.
      throw new HttpError(401, 'Sign in and try again.', 'unauthenticated')
    }

    // Absent is treated as false, not "probably fine": a token minted before the
    // claim existed must fail closed.
    if (decoded.email_verified !== true) {
      throw new HttpError(403, 'Verify your email address first.', 'email_unverified')
    }

    await handler(req, res, decoded.uid)
  }
}
