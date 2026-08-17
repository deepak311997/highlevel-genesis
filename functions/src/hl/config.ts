import { isEmulator } from '../lib/env'

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
 * A value the *test scripts* can force, which `.env` cannot overrule.
 *
 * The functions emulator loads `.env` and `.env.local` into the runtime and
 * those values **beat anything the shell exported** — which is the precedence
 * that once sent the local OAuth flow to the deployed site. It has a sharper
 * consequence for the suite: `.env.local` can be switched to the real
 * HighLevel for manual checks, and if tests inherited that they would exchange
 * real authorization codes against the live API with real credentials.
 *
 * These names appear in neither `.env` nor `.env.local`, so a shell value
 * survives, and they are honoured only under the emulator. That makes the suite
 * independent of whatever mode a developer happens to be in.
 */
function emulatorOverride(name: string): string | undefined {
  if (!isEmulator()) return undefined
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}. Set it in functions/.env — see functions/.env.example.`)
  }
  return value
}

/** Trailing slashes are stripped so callers can always join with a leading one. */
function baseUrl(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return (value === undefined || value === '' ? fallback : value).replace(/\/+$/, '')
}

export function hlClientId(): string {
  return required('HL_CLIENT_ID')
}

/**
 * The app **version** the consent screen should honour.
 *
 * Required by the v2 authorize endpoint, and its absence is not a soft failure:
 * without it HighLevel answers `No integration found with the id: <app id>`,
 * naming the app it could not resolve, which reads like a broken client id and
 * sends you to regenerate keys that were never the problem.
 *
 * The value is the app id — the segment of `HL_CLIENT_ID` before the hyphen —
 * but it is configured separately rather than derived, because "they happen to
 * be equal today" is not a contract HighLevel has offered.
 */
export function hlVersionId(): string {
  return required('HL_VERSION_ID')
}

export function hlClientSecret(): string {
  return required('HL_CLIENT_SECRET')
}

/**
 * The redirect URI, which must be one identical string in three places: the
 * marketplace app's Redirect URL field, the authorize URL, and the token
 * exchange. Read from here everywhere so those three cannot drift.
 */
export function hlRedirectUri(): string {
  return emulatorOverride('HL_TEST_REDIRECT_URI') ?? required('HL_REDIRECT_URI')
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
