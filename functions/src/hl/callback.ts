import type { Request, Response } from 'express'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'

import { hlRedirectUri } from './config'
import { CONNECTIONS } from './connection'
import {
  exchangeCode,
  exchangeForLocationToken,
  fetchLocationName,
  HlRequestError,
  listInstalledLocations,
} from './exchange'
import { getDb } from '../lib/firebase'
import { sealToken } from './tokenCrypto'
import { describeError, logAuthEvent, logHlOAuthEvent } from '../lib/log'
import { openState } from './state'
import type { TokenResponse } from './schema'

/**
 * `GET /api/oauth/callback` — where HighLevel sends the browser back.
 *
 * **Unauthenticated, and it cannot be otherwise**: this is a top-level navigation
 * initiated by another company's server, so there is no ID token, no session
 * cookie and nothing App Check could attest. The encrypted `state` is the entire
 * authorisation.
 *
 * **Every path answers with a 302 and never a body.** Rendering an error here
 * would dead-end the user on an unstyled page outside the SPA; the outcome travels
 * as a code the dashboard turns into an alert beside the button that retries it.
 *
 * **And every path leaves a line behind.** The user is told one thing for half a
 * dozen distinct causes — that asymmetry is deliberate and is also why an install
 * that fails in production cannot be debugged from the outside: there is no
 * request to inspect and no response to read. The log is the only evidence there
 * will ever be, so each step says which upstream call it made, what came back, and
 * what shape the install turned out to be. None of it may carry the code, the
 * state or a token; `logHlOAuthEvent`'s context is typed to make that structural.
 */

/** Every way this can end. The SPA has copy for each. */
export type CallbackOutcome =
  'connected' | 'denied' | 'invalid_state' | 'exchange_failed' | 'wrong_account_type'

/**
 * Relative on purpose: through the Hosting rewrite the function and the SPA are
 * one origin, and under the emulator the dev server's proxy forwards `/api` here.
 * One string, both places, no base-URL variable to keep in sync.
 */
function redirectTo(res: Response, outcome: CallbackOutcome): void {
  const target =
    outcome === 'connected'
      ? '/hl/callback?status=connected'
      : `/hl/callback?status=error&code=${outcome}`

  logAuthEvent('hl.callback', {
    outcome: outcome === 'connected' ? 'ok' : 'invalid',
    detail: outcome,
  })
  res.redirect(302, target)
}

/**
 * The upstream half of a rejection, for a log line that must otherwise guess.
 *
 * Only `HlRequestError` carries a status, so this distinguishes "HighLevel
 * refused us" from "we never got that far" — a missing secret and a 422 are the
 * same redirect and very different bugs.
 */
function upstreamOf(err: unknown): { endpoint: string; status: number } | undefined {
  return err instanceof HlRequestError ? { endpoint: err.endpoint, status: err.status } : undefined
}

/**
 * The configured redirect URI, or empty.
 *
 * Never throws, because this is read to *describe* a request rather than to serve
 * one, and an unbound secret must not turn a diagnosable failure into a 500. An
 * empty value in the log is itself the diagnosis: the secret is not bound.
 */
function configuredRedirectUri(): string {
  try {
    return hlRedirectUri()
  } catch {
    return ''
  }
}

/** What an install resolved to, and the count that explains it if it did not. */
interface Resolution {
  token: TokenResponse | null
  /** Sub-accounts a bulk install covers; `null` when the question never arose. */
  locationCount: number | null
}

/**
 * Reduce whatever the install produced to a single location-scoped token.
 *
 * A per-location install hands one back directly; the marketplace's own button
 * installs agency-wide, which yields a `Company` token with no `locationId`.
 *
 * **Exactly one, or nothing.** An agency install spanning several sub-accounts has
 * no answer to "which location did the user mean", and picking the first would
 * silently bind someone's project to an arbitrary client's CRM.
 */
async function resolveLocationToken(token: TokenResponse): Promise<Resolution> {
  if (token.userType === 'Location') return { token, locationCount: null }

  const installed = await listInstalledLocations(token.access_token, token.companyId)
  const locationCount = installed.locations.length
  const only = locationCount === 1 ? installed.locations[0] : undefined
  if (only === undefined) return { token: null, locationCount }

  const derived = await exchangeForLocationToken(token.access_token, token.companyId, only._id)
  return { token: derived.userType === 'Location' ? derived : null, locationCount }
}

/**
 * A query parameter as a string, or empty. Express types query values loosely
 * enough that `String(...)` can yield `"[object Object]"`, and `?state[]=a` is a
 * request anyone can make — narrowing means a hostile shape takes the rejection
 * path rather than becoming a plausible-looking value.
 */
function queryParam(req: Request, name: string): string {
  const value = req.query[name]
  return typeof value === 'string' ? value : ''
}

export async function handleCallback(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now()
  const code = queryParam(req, 'code')
  const state = queryParam(req, 'state')

  /*
   * The first line, before anything is trusted. Presence rather than value for the
   * two credentials, and the redirect URI **as this deploy has it configured** —
   * the one string that must be identical here, in the authorize URL and in the
   * marketplace app's own field, and the one whose drift is invisible everywhere
   * else.
   */
  logHlOAuthEvent('hl.callback.received', {
    step: 'callback',
    outcome: 'ok',
    hasCode: code !== '',
    hasState: state !== '',
    redirectUri: configuredRedirectUri(),
  })

  // HighLevel reports a refusal as a query parameter on an otherwise ordinary
  // redirect, so this is checked before anything else is trusted.
  if (queryParam(req, 'error') !== '') {
    logHlOAuthEvent('hl.callback.denied', {
      step: 'callback',
      outcome: 'invalid',
      detail: queryParam(req, 'error'),
    })
    redirectTo(res, 'denied')
    return
  }

  let uid: string
  try {
    uid = openState(state).uid
  } catch {
    /*
     * Forged, tampered, expired and absent are one answer *to the user*:
     * distinguishing them there would tell whoever is probing which half of the
     * check they had beaten. The log may separate the two cases it can cheaply
     * tell apart, because nobody probing can read it — and "no state arrived at
     * all" means a broken authorize URL, where "the state was rejected" usually
     * means the five-minute TTL expired on a slow consent screen.
     */
    logHlOAuthEvent('hl.callback.invalid_state', {
      step: 'callback',
      outcome: 'invalid',
      detail: state === '' ? 'absent' : 'rejected',
    })
    redirectTo(res, 'invalid_state')
    return
  }

  if (code === '') {
    // Its own event, not a failed exchange: no call was made, so a line saying
    // "exchange failed" would send the next reader upstream for no reason.
    logHlOAuthEvent('hl.callback.no_code', { step: 'callback', outcome: 'invalid' })
    redirectTo(res, 'exchange_failed')
    return
  }

  let token: TokenResponse
  try {
    token = await exchangeCode(code)
  } catch (err) {
    /*
     * Logged, not just redirected. The user gets one code, because naming which of
     * a dozen upstream conditions occurred helps nobody and hands a prober a
     * signal — but without this line a failing integration leaves only "it failed".
     *
     * This is also the replay path: HighLevel consumes a code on first use, so a
     * re-sent callback URL fails here rather than at the state check.
     */
    logHlOAuthEvent('hl.callback.exchange_failed', {
      step: 'exchange',
      outcome: 'invalid',
      durationMs: Date.now() - startedAt,
      ...upstreamOf(err),
      detail: describeError(err),
    })
    redirectTo(res, 'exchange_failed')
    return
  }

  /*
   * The install shape, recorded *before* the calls that depend on it. Everything
   * after this branches on `userType`, and a `Company` token means the marketplace
   * app's Target User is Agency rather than Sub-account — a setting that lives in
   * HighLevel's console, not in this repo, and that no other line would reveal.
   */
  logHlOAuthEvent('hl.callback.exchanged', {
    step: 'exchange',
    outcome: 'ok',
    durationMs: Date.now() - startedAt,
    userType: token.userType,
  })

  let resolution: Resolution
  try {
    resolution = await resolveLocationToken(token)
  } catch (err) {
    // The bulk-install path: `installedLocations` or `locationToken` refused.
    // Which of the two, and what it said, is the whole value of this line.
    logHlOAuthEvent('hl.callback.resolve_failed', {
      step: 'resolve',
      outcome: 'invalid',
      durationMs: Date.now() - startedAt,
      userType: token.userType,
      ...upstreamOf(err),
      detail: describeError(err),
    })
    redirectTo(res, 'exchange_failed')
    return
  }

  const located = resolution.token
  if (located?.userType !== 'Location') {
    logHlOAuthEvent('hl.callback.wrong_account_type', {
      step: 'resolve',
      outcome: 'invalid',
      userType: token.userType,
      ...(resolution.locationCount === null ? {} : { locationCount: resolution.locationCount }),
    })
    redirectTo(res, 'wrong_account_type')
    return
  }

  // Best effort, and deliberately after the point of no return: a missing name
  // costs a nicer label, not a connection.
  const locationName = await fetchLocationName(located.access_token, located.locationId)

  try {
    await getDb()
      .doc(`${CONNECTIONS}/${uid}`)
      .set({
        accessToken: sealToken(located.access_token),
        refreshToken: sealToken(located.refresh_token),
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
  } catch (err) {
    /*
     * Caught to keep this file's own invariant: every path answers with a 302.
     * Uncaught, a failed write reached the terminal error handler and answered a
     * JSON 500 — on a top-level navigation, which means an unstyled page outside
     * the SPA rather than the alert beside the button that retries.
     */
    logHlOAuthEvent('hl.callback.store_failed', {
      step: 'store',
      outcome: 'invalid',
      durationMs: Date.now() - startedAt,
      detail: describeError(err),
    })
    redirectTo(res, 'exchange_failed')
    return
  }

  logHlOAuthEvent('hl.callback.connected', {
    step: 'store',
    outcome: 'ok',
    durationMs: Date.now() - startedAt,
    userType: located.userType,
    ...(resolution.locationCount === null ? {} : { locationCount: resolution.locationCount }),
  })
  redirectTo(res, 'connected')
}
