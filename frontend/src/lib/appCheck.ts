import {
  getToken,
  initializeAppCheck,
  ReCaptchaV3Provider,
  type AppCheck,
} from 'firebase/app-check'

import { app } from './firebase'

/**
 * App Check attestation for calls to our own HTTP functions.
 *
 * The Firebase SDK attaches App Check tokens automatically to *Firebase*
 * services — Firestore, Storage, callable functions. `/api/auth/register` is a
 * plain `onRequest` endpoint reached with `fetch`, so nothing attaches anything
 * for us and the header has to be set by hand.
 *
 * The site key is public by design: it is compiled into the bundle and readable
 * by any visitor, which is fine for a reCAPTCHA *site* key and fatal for a
 * secret key. What makes it a control is that reCAPTCHA scores the browser, and
 * the token it mints is verified server-side against Google.
 */
const SITE_KEY = (import.meta.env.VITE_GOOGLE_RECAPTCHA_V3_KEY ?? '').trim()

/**
 * Memoised because `initializeAppCheck` throws if called twice for one app.
 *
 * Holding the promise rather than the handle also collapses concurrent first
 * calls — two forms submitting at once would otherwise race into two
 * initialisations, and the loser throws.
 */
let handle: Promise<AppCheck> | undefined

function appCheck(): Promise<AppCheck> {
  handle ??= Promise.resolve(
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(SITE_KEY),
      // Refresh in the background so a token is warm when a form is submitted;
      // fetching one cold adds a visible pause to the first sign-up.
      isTokenAutoRefreshEnabled: true,
    }),
  )
  return handle
}

/**
 * The App Check header for a request, or nothing.
 *
 * Never throws and never blocks the request. Two cases return `{}`:
 *
 * 1. **No site key** — the emulator build, which has no App Check service to
 *    mint against. The backend bypasses verification under `FUNCTIONS_EMULATOR`
 *    for the same reason, so the two halves agree.
 * 2. **Attestation failed** — reCAPTCHA unreachable, or a browser that refuses
 *    it. The server is the enforcement point and answers 401 with copy the user
 *    can act on; failing here instead would put a reCAPTCHA-shaped error on a
 *    sign-up form, which tells the user nothing about what to do next.
 */
export async function appCheckHeader(): Promise<Record<string, string>> {
  if (SITE_KEY === '') return {}

  try {
    const { token } = await getToken(await appCheck(), /* forceRefresh */ false)
    return { 'X-Firebase-AppCheck': token }
  } catch {
    return {}
  }
}
