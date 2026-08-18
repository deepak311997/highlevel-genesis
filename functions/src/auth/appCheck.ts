import type { NextFunction, Request, Response } from 'express'

import { isEmulator } from '../lib/env'
import { HttpError } from '../lib/errors'
import { getAppCheckService } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'

/**
 * App Check — attestation that the caller is our app.
 *
 * `register` is public, unauthenticated and creates accounts; the throttle bounds
 * how fast one address or IP can be hit, but an attacker with a proxy pool is
 * bounded only by how many keys they can rotate. App Check answers a different
 * question — not "how often" but "is this our app at all". On `/generate` it is
 * sharper still: an unattested caller there spends against the model bill.
 *
 * **It runs before the throttle**, so a request that cannot prove where it came
 * from is refused before it consumes a Firestore transaction and before it can
 * spend a victim's throttle budget.
 *
 * Applied per route rather than with `router.use`: these routers are mounted at
 * both `/` and `/api`, so router-level middleware would run twice per request.
 */
export async function requireAppCheck(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  /*
   * There is no App Check emulator, so a deployed-style verification cannot be
   * satisfied locally and the whole suite would fail on a control it is not about.
   *
   * Keyed on `FUNCTIONS_EMULATOR` alone, never on a flag of our own: a settable
   * flag would be a remotely-configurable way to switch off a security control.
   */
  if (isEmulator()) {
    next()
    return
  }

  const token = req.header('x-firebase-appcheck')?.trim()
  if (token === undefined || token === '') {
    logAuthEvent('appcheck.missing', { outcome: 'invalid', status: 401 })
    throw new HttpError(
      401,
      'Request could not be verified. Reload the page and try again.',
      'app_check_failed',
    )
  }

  try {
    await getAppCheckService().verifyToken(token)
  } catch {
    // The reason is deliberately not surfaced or logged in detail: a caller
    // learning *why* their forged token failed is being handed a tuning signal.
    logAuthEvent('appcheck.rejected', { outcome: 'invalid', status: 401 })
    throw new HttpError(
      401,
      'Request could not be verified. Reload the page and try again.',
      'app_check_failed',
    )
  }

  next()
}
