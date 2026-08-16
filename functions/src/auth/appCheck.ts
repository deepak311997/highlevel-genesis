import type { NextFunction, Request, Response } from 'express'

import { isEmulator } from '../lib/env'
import { HttpError } from '../lib/errors'
import { getAppCheckService } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'

/**
 * App Check on `/auth/register` — attestation that the caller is our app.
 *
 * `register` is the one endpoint that is public, unauthenticated, and creates
 * accounts. The throttle bounds how fast any single address or IP can be hit,
 * but an attacker with a script and a proxy pool is bounded only by how many
 * keys they can rotate. App Check answers a different question from the
 * throttle — not "how often" but "is this our app at all" — which is why
 * discovery called it the strongest control available here (D24).
 *
 * **Ordering matters: this runs before the throttle.** A request that cannot
 * prove it came from our app should be refused before it consumes a Firestore
 * transaction, and before it can spend a victim's throttle budget — otherwise
 * an unattested flood could lock a real user out of registering. It also
 * satisfies AC-50's "before any Auth call" literally.
 *
 * Applied per route rather than with `router.use`, for the same reason as the
 * throttle: this router is mounted at both `/` and `/api`, so router-level
 * middleware would run twice for one request.
 */
export async function requireAppCheck(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  /*
   * There is no App Check emulator. A deployed-style verification cannot be
   * satisfied locally, so without this the entire e2e and integration suite
   * fails on a control that is not what those tests are about — the failure
   * mode R5 was written to anticipate.
   *
   * Keyed on FUNCTIONS_EMULATOR alone, never on a config value or an env flag
   * of our own (D21). A settable flag here would be a remotely-configurable
   * way to switch off a security control, and the one that gates account
   * creation is the last one to leave switchable.
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
