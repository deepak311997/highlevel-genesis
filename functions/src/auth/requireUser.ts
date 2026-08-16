import type { Request, Response } from 'express'

import { getAdminAuth } from '../lib/firebase'
import { HttpError } from '../lib/errors'

/**
 * Authenticate a request and prove the address behind it.
 *
 * **Both halves matter, and the second is the one that gets skipped.** Slice 1
 * holds unverified accounts behind a router guard and behind Firestore rules; a
 * router guard stops a browser and stops nobody calling the API directly with a
 * valid token, and Firestore rules say nothing about a Cloud Function's own
 * surface. So `email_verified` is read from the decoded token here, on every
 * authenticated endpoint. That is Slice 1's D26, recorded there precisely
 * because this slice would be the first to inherit the gap.
 *
 * ## Why a wrapper rather than middleware
 *
 * The uid has to reach the handler. Middleware would have to leave it on
 * `req` or `res.locals`, which under `noPropertyAccessFromIndexSignature` is
 * untyped at every call site and, worse, is ambient: a handler that forgot to
 * check would still compile and would read `undefined` as a uid. Passing it as
 * an argument makes the dependency impossible to overlook and impossible to
 * mistype.
 */
export type VerifiedHandler = (req: Request, res: Response, uid: string) => Promise<void>

const BEARER = /^Bearer (.+)$/

/**
 * Returns an **async** handler, mounted with `asyncHandler` at the route — the
 * same shape `requireAppCheck` uses. Returning a promise rather than swallowing
 * one keeps rejections on a path the error handler already owns, and lets a
 * test await the decision instead of racing a microtask.
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
      // The reason is deliberately not surfaced. Expired, malformed and forged
      // are the same answer to the caller; telling them which is a tuning
      // signal and nothing else.
      throw new HttpError(401, 'Sign in and try again.', 'unauthenticated')
    }

    // Absent is treated as false, not as "probably fine". A token minted before
    // the claim existed must fail closed.
    if (decoded.email_verified !== true) {
      throw new HttpError(403, 'Verify your email address first.', 'email_unverified')
    }

    await handler(req, res, decoded.uid)
  }
}
