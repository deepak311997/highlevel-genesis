import type { Request, Response } from 'express'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'

import { CONNECTIONS } from './connection'
import {
  exchangeCode,
  exchangeForLocationToken,
  fetchLocationName,
  listInstalledLocations,
} from './exchange'
import { getDb } from '../lib/firebase'
import { describeError, logAuthEvent } from '../lib/log'
import { openState } from './state'
import type { TokenResponse } from './schema'

/**
 * `GET /api/oauth/callback` — where HighLevel sends the browser back.
 *
 * **Unauthenticated, and it cannot be otherwise.** This is a top-level
 * navigation initiated by another company's server; there is no ID token, no
 * session cookie and nothing App Check could attest. The encrypted `state` is
 * the entire authorisation: it names the Firebase uid this connection belongs
 * to, and it cannot be forged without the key.
 *
 * **Every path answers with a 302 and never a body.** Rendering an error here
 * would dead-end the user on an unstyled page outside the SPA, and would put
 * error copy in a second place. Instead the outcome travels as a code that the
 * dashboard turns into an Alert beside the button that retries it.
 */

/** Every way this can end. The SPA has copy for each. */
export type CallbackOutcome =
  | 'connected'
  | 'denied'
  | 'invalid_state'
  | 'exchange_failed'
  | 'wrong_account_type'

/**
 * Relative on purpose. Through the Hosting rewrite the function and the SPA are
 * one origin, so this resolves against the app in production; under the
 * emulator `HL_REDIRECT_URI` points at the Vite dev server, whose proxy
 * forwards `/api` here, so it resolves there too. One string, both places, no
 * base-URL variable to keep in sync.
 */
function redirectTo(res: Response, outcome: CallbackOutcome): void {
  const target =
    outcome === 'connected'
      ? '/hl/callback?status=connected'
      : `/hl/callback?status=error&code=${outcome}`

  logAuthEvent('hl.callback', { outcome: outcome === 'connected' ? 'ok' : 'invalid', detail: outcome })
  res.redirect(302, target)
}

/**
 * Reduce whatever the install produced to a single location-scoped token.
 *
 * A per-location install hands one back directly. The marketplace's own install
 * button installs agency-wide instead, which yields a `Company` token with no
 * `locationId` — usable, but only after asking which sub-accounts it covers and
 * trading it for a location token.
 *
 * **Exactly one, or nothing.** An agency install spanning several sub-accounts
 * has no answer to "which location did the user mean", and picking the first
 * would silently bind someone's Genesis project to an arbitrary client's CRM.
 * That is the tenant-isolation mistake this slice exists to avoid, so the
 * ambiguous case is refused rather than guessed.
 */
async function resolveLocationToken(token: TokenResponse): Promise<TokenResponse | null> {
  if (token.userType === 'Location') return token

  const installed = await listInstalledLocations(token.access_token, token.companyId)
  const only = installed.locations.length === 1 ? installed.locations[0] : undefined
  if (only === undefined) return null

  const derived = await exchangeForLocationToken(token.access_token, token.companyId, only._id)
  return derived.userType === 'Location' ? derived : null
}

/**
 * A query parameter as a string, or empty.
 *
 * Express types `req.query` values as `string | string[] | ParsedQs |
 * ParsedQs[]`, so `String(...)` on one can yield `"[object Object]"` — and
 * `?state[]=a&state[]=b` is a request anyone can make. Narrowing here means a
 * hostile shape becomes an empty string and takes the rejection path, rather
 * than becoming a plausible-looking value.
 */
function queryParam(req: Request, name: string): string {
  const value = req.query[name]
  return typeof value === 'string' ? value : ''
}

export async function handleCallback(req: Request, res: Response): Promise<void> {
  // HighLevel reports a refusal as a query parameter on an otherwise ordinary
  // redirect, so this is checked before anything else is trusted.
  if (queryParam(req, 'error') !== '') {
    redirectTo(res, 'denied')
    return
  }

  let uid: string
  try {
    uid = openState(queryParam(req, 'state')).uid
  } catch {
    // Forged, tampered, expired and absent are one answer. Distinguishing them
    // would tell whoever is probing which half of the check they had beaten.
    redirectTo(res, 'invalid_state')
    return
  }

  const code = queryParam(req, 'code')
  if (code === '') {
    redirectTo(res, 'exchange_failed')
    return
  }

  let token: TokenResponse
  try {
    token = await exchangeCode(code)
  } catch (err) {
    /*
     * Logged, not just redirected.
     *
     * The user gets one code — `exchange_failed` — because telling them which
     * of a dozen upstream conditions occurred helps nobody and hands a prober a
     * signal. But *we* need to know, and without this line a failing
     * integration in production leaves only "it failed": no status, no
     * upstream message, nothing to act on. `describeError` reduces the throw to
     * a code and a message, and every value here goes through the redaction
     * pass, so an authorization code cannot ride along.
     *
     * This is also the replay path: HighLevel consumes a code on first use, so
     * a re-sent callback URL fails here rather than at the state check.
     */
    logAuthEvent('hl.callback.exchange_failed', {
      outcome: 'invalid',
      detail: describeError(err),
    })
    redirectTo(res, 'exchange_failed')
    return
  }

  let located: TokenResponse | null
  try {
    located = await resolveLocationToken(token)
  } catch (err) {
    // The bulk-install path: `installedLocations` or `locationToken` refused.
    // Distinguished from the exchange in the log, though not to the user.
    logAuthEvent('hl.callback.resolve_failed', {
      outcome: 'invalid',
      detail: describeError(err),
    })
    redirectTo(res, 'exchange_failed')
    return
  }

  if (located?.userType !== 'Location') {
    redirectTo(res, 'wrong_account_type')
    return
  }

  // Best effort, and deliberately after the point of no return: a missing name
  // costs a nicer label, not a connection.
  const locationName = await fetchLocationName(located.access_token, located.locationId)

  await getDb()
    .doc(`${CONNECTIONS}/${uid}`)
    .set({
      accessToken: located.access_token,
      refreshToken: located.refresh_token,
      expiresAt: Timestamp.fromMillis(Date.now() + located.expires_in * 1000),
      locationId: located.locationId,
      locationName,
      companyId: located.companyId,
      hlUserId: located.userId ?? null,
      scope: located.scope,
      needsReconnect: false,
      connectedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

  redirectTo(res, 'connected')
}
