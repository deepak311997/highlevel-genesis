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
 * re-authorise, which is why the full list — the four "worth adding cheaply"
 * entries included — was taken up front (PRD D18).
 */
export const HL_SCOPES = [
  'locations.readonly',
  'contacts.readonly',
  'contacts.write',
  'conversations.readonly',
  'conversations.write',
  'conversations/message.readonly',
  'conversations/message.write',
  'calendars.readonly',
  'calendars/events.readonly',
  'calendars/events.write',
  'users.readonly',
  'opportunities.readonly',
  'locations/customFields.readonly',
  'locations/tags.readonly',
] as const

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

export function hlClientSecret(): string {
  return required('HL_CLIENT_SECRET')
}

/**
 * The redirect URI, which must be one identical string in three places: the
 * marketplace app's Redirect URL field, the authorize URL, and the token
 * exchange. Read from here everywhere so those three cannot drift.
 */
export function hlRedirectUri(): string {
  return required('HL_REDIRECT_URI')
}

export function hlAuthorizeBase(): string {
  return baseUrl('HL_AUTHORIZE_BASE', DEFAULT_AUTHORIZE_BASE)
}

export function hlApiBase(): string {
  return baseUrl('HL_API_BASE', DEFAULT_API_BASE)
}
