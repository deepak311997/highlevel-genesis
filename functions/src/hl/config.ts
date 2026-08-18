import { defineSecret } from 'firebase-functions/params'

import { baseUrl, emulatorNumber, emulatorOverride, requiredSecret } from '../lib/env'

/**
 * HighLevel configuration, resolved per call rather than at module scope — for
 * `getDb()`'s reason: `firebase deploy` analyses every module before injecting
 * `functions/.env`, so a top-level read bakes in an empty environment and a
 * top-level throw fails the deploy rather than the request.
 */

/** Where the marketplace serves `/oauth/chooselocation`. */
const DEFAULT_AUTHORIZE_BASE = 'https://marketplace.gohighlevel.com'

/** Where `/oauth/token` and `/locations/{id}` both live — one host, one variable. */
const DEFAULT_API_BASE = 'https://services.leadconnectorhq.com'

/**
 * Every scope the marketplace app is configured with.
 *
 * **This list and the app's OAuth Scopes are one contract with two halves, and
 * this repo can only see one of them.** Adding a scope here without adding it
 * there yields an authorisation page that grants less than the code expects, and
 * adding one *after* installs exist forces every user to re-authorise — which is
 * why the list is taken in full up front.
 *
 * Five more were requested and refused with `invalid_scope`; none is required.
 * `conversations.write` governs conversation *records*, where "send a message" is
 * `conversations/message.write`, which is present.
 */
export const HL_SCOPES = [
  'locations.readonly',
  'contacts.readonly',
  'contacts.write',
  'conversations.readonly',
  'conversations/message.readonly',
  'conversations/message.write',
  'calendars.readonly',
  'calendars/events.readonly',
  'calendars/events.write',
] as const

/**
 * The marketplace app's client id.
 *
 * In Secret Manager not because it is a credential — it is half of a public pair —
 * but because `functions/.env` is uploaded as plain Cloud Run environment *and*
 * had to be synthesised by the deploy, which on a public repository meant printing
 * it into a world-readable log.
 */
export const HL_CLIENT_ID = defineSecret('HL_CLIENT_ID')

export function hlClientId(): string {
  return requiredSecret(HL_CLIENT_ID, 'HL_CLIENT_ID')
}

/**
 * The app **version** the consent screen should honour.
 *
 * Required by the v2 authorize endpoint, and its absence is not a soft failure:
 * HighLevel answers `No integration found with the id: <app id>`, which reads like
 * a broken client id and sends you to regenerate keys that were never the problem.
 *
 * It happens to equal the segment of the client id before the hyphen, but it is
 * configured separately, because that equality is not a contract HighLevel offers.
 */
export const HL_VERSION_ID = defineSecret('HL_VERSION_ID')

export function hlVersionId(): string {
  return requiredSecret(HL_VERSION_ID, 'HL_VERSION_ID')
}

/**
 * The marketplace app's client secret, from Secret Manager: `functions/.env` is
 * uploaded as plain Cloud Run environment, and HighLevel displays this exactly
 * once at creation — so a leak here is not a rotation, it is a re-issue.
 *
 * Bound to `api` alone; `generate` never exchanges an authorization code. Under
 * the emulator `value()` reads `process.env`, so only the deployed endpoint can
 * tell the difference — which is why the binding is asserted structurally.
 */
export const HL_CLIENT_SECRET = defineSecret('HL_CLIENT_SECRET')

export function hlClientSecret(): string {
  return requiredSecret(HL_CLIENT_SECRET, 'HL_CLIENT_SECRET')
}

/**
 * The redirect URI, which must be one identical string in three places: the
 * marketplace app's Redirect URL field, the authorize URL, and the token
 * exchange. Read from here everywhere so those three cannot drift.
 */
export const HL_REDIRECT_URI = defineSecret('HL_REDIRECT_URI')

export function hlRedirectUri(): string {
  return (
    emulatorOverride('HL_TEST_REDIRECT_URI') ?? requiredSecret(HL_REDIRECT_URI, 'HL_REDIRECT_URI')
  )
}

export function hlAuthorizeBase(): string {
  return (
    emulatorOverride('HL_TEST_AUTHORIZE_BASE') ??
    baseUrl('HL_AUTHORIZE_BASE', DEFAULT_AUTHORIZE_BASE)
  )
}

export function hlApiBase(): string {
  return emulatorOverride('HL_TEST_API_BASE') ?? baseUrl('HL_API_BASE', DEFAULT_API_BASE)
}

/**
 * How long a proxied upstream call may take before it is aborted. The `api`
 * function's own timeout is 60 s, so an unbounded call would burn the whole
 * request budget and answer nothing.
 */
export const UPSTREAM_TIMEOUT_MS = 20_000

/**
 * The same emulator-only override the keep-alive uses, for the same reason: a
 * twenty-second case in a suite that runs on every push is a case people delete.
 * Outside the emulator it is ignored outright, so no deploy can shorten the real
 * timeout.
 */
export function hlUpstreamTimeoutMs(): number {
  return emulatorNumber('HL_TEST_UPSTREAM_TIMEOUT_MS', UPSTREAM_TIMEOUT_MS)
}
