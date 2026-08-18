import { defineSecret } from 'firebase-functions/params'

import { baseUrl, emulatorNumber, emulatorOverride, requiredSecret } from '../lib/env'

/**
 * HighLevel configuration, resolved per call rather than at module scope.
 *
 * Lazy for the same reason `getDb()` is: `firebase deploy` loads and analyses
 * every module *before* injecting functions/.env, so a top-level read would
 * bake in an empty environment and a top-level throw would fail the deploy
 * rather than the request.
 */

/** Where the marketplace serves `/oauth/chooselocation`. */
const DEFAULT_AUTHORIZE_BASE = 'https://marketplace.gohighlevel.com'

/** Where `/oauth/token` and `/locations/{id}` both live — one host, one variable. */
const DEFAULT_API_BASE = 'https://services.leadconnectorhq.com'

/**
 * Every scope the marketplace app is configured with.
 *
 * **This list and the app's Advanced Settings → Auth → OAuth Scopes are one
 * contract with two halves, and this repo can only see one of them.** Adding a
 * scope here without adding it there yields an authorisation page that grants
 * less than the code expects; adding it there without here is harmless but
 * misleading. Adding one *after* installs exist forces every user to
 * re-authorise, which is why the list is taken in full up front (PRD D18).
 *
 * **Five scopes were requested and refused**, with `invalid_scope` naming each:
 * `conversations.write`, `users.readonly`, `opportunities.readonly`,
 * `locations/customFields.readonly` and `locations/tags.readonly`. None is
 * required by the spec — F7.1 asks for Contacts, Conversations and Calendars,
 * and all three surfaces are covered here. In particular `conversations.write`
 * governs conversation *records*; F7.1's "send" is `conversations/message.write`,
 * which is present. The rest were the "worth adding cheaply" extras from
 * HIGHLEVEL_PLATFORM.md §4, and they cost us nothing.
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
 * A Secret Manager value rather than a `functions/.env` line, and not because it
 * is a credential — it is half of a public pair, and it travels in every
 * authorize URL. It is here because `functions/.env` is uploaded as plain Cloud
 * Run environment *and* has to be synthesised by the deploy, which on a public
 * repository meant printing it into a world-readable log. Secret Manager removes
 * the file, and with it the step that leaked.
 */
export const HL_CLIENT_ID = defineSecret('HL_CLIENT_ID')

export function hlClientId(): string {
  return requiredSecret(HL_CLIENT_ID, 'HL_CLIENT_ID')
}

/**
 * The marketplace app's client secret, from Secret Manager.
 *
 * `defineSecret` rather than `required()`, for the reason `ANTHROPIC_API_KEY` is
 * one (D19): everything left in `functions/.env` is uploaded as a plain
 * environment variable on the Cloud Run service and is readable by anyone with
 * Viewer on the project. This is half of the app's credentials and HighLevel
 * displays it exactly once, at creation — so a leak here is not a rotation, it is
 * a re-issue.
 *
 * Bound to `api` alone in `index.ts`. `generate` never exchanges an
 * authorization code, so it is never granted this.
 *
 * Under the emulator `SecretParam.value()` reads `process.env`, which
 * `functions/.env.local` populates with a fake — so the whole suite is unaffected
 * by the move, and only the deployed endpoint can tell the difference. That is
 * why `index.spec.ts` asserts the binding structurally.
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
 * How long a proxied upstream call may take before it is aborted (D27).
 *
 * The `api` function's own timeout is 60 s, so an unbounded upstream call would
 * burn the whole request budget and answer nothing.
 */
export const UPSTREAM_TIMEOUT_MS = 20_000

/**
 * The same emulator-only override `keepAliveMs()` uses, for the same reason: a
 * twenty-second case in a suite that runs on every push is a case people
 * delete. The name appears in no `.env` file, so a shell value survives the
 * emulator's `.env` precedence — and outside the emulator it is ignored
 * outright, so no deploy can shorten the real timeout.
 */
export function hlUpstreamTimeoutMs(): number {
  return emulatorNumber('HL_TEST_UPSTREAM_TIMEOUT_MS', UPSTREAM_TIMEOUT_MS)
}
