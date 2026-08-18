import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app'
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth'

const env = import.meta.env

/**
 * Read a required value, failing loudly when it is absent.
 *
 * There are no defaults here on purpose. A placeholder would let the app boot
 * and then fail later against the wrong project — a missing variable should
 * stop startup with a message that names the fix.
 */
function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') {
    throw new Error(
      `Missing ${name}. Copy frontend/.env.example to frontend/.env and fill in ` +
        'the Firebase web config (`firebase apps:sdkconfig WEB`).',
    )
  }
  return trimmed
}

/**
 * What the SDKs this app loads actually read, and nothing else.
 *
 * `firebase apps:sdkconfig WEB` prints six values, and it is tempting to paste
 * all six. But this app imports `firebase/app`, `firebase/auth` and App Check —
 * none of which looks at `storageBucket` or `messagingSenderId`. Those two are
 * for the Storage and Messaging SDKs, which are not here. Carrying them meant
 * two more values in a `.env`, in a repository variable, and in a deploy log,
 * for no behaviour at all.
 *
 * `appId` stays: App Check identifies the registered web app by it.
 */
const config: FirebaseOptions = {
  apiKey: required('VITE_FIREBASE_API_KEY', env.VITE_FIREBASE_API_KEY),
  authDomain: required('VITE_FIREBASE_AUTH_DOMAIN', env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: required('VITE_FIREBASE_PROJECT_ID', env.VITE_FIREBASE_PROJECT_ID),
  ...(env.VITE_FIREBASE_APP_ID && { appId: env.VITE_FIREBASE_APP_ID }),
}

/**
 * Auth and App Check, and deliberately **no Firestore handle**.
 *
 * The frontend never talks to Firestore: every read and write goes through a
 * Cloud Function route that verifies the ID token and scopes the query by the
 * uid inside it, and `firestore.rules` denies every client outright. An exported
 * `db` nobody reads would be an invitation to read it — and removing it
 * entirely is what lets the `firebase/firestore` ban be absolute, with no
 * allowlist to keep current. See CLAUDE.md and
 * docs/slices/02b-api-data-access/.
 */
export const app: FirebaseApp = initializeApp(config)
export const auth: Auth = getAuth(app)

/**
 * Emulators are chosen by **build mode**, never by a runtime flag.
 *
 * `import.meta.env.MODE` is replaced with a literal at build time, so in any
 * other mode this comparison is `'production' === 'emulator'` and the whole
 * block — including the imports it is the only user of — is eliminated. A
 * production bundle cannot reach an emulator even if something at runtime
 * asked it to, which is the property a runtime flag could not give us.
 *
 * Reached by `vite --mode emulator`, which is what the Playwright suite builds.
 * Vitest runs in mode `test`, so unit tests never open a socket.
 */
if (import.meta.env.MODE === 'emulator') {
  // Ports are injected at build time rather than hardcoded, because the test
  // suites run the emulators on a second set so they need not stop a
  // development session first. Defaults are the ordinary ports.
  connectAuthEmulator(auth, `http://127.0.0.1:${import.meta.env.VITE_AUTH_EMULATOR_PORT}`, {
    disableWarnings: true,
  })

  // A marker the e2e suite checks before it does anything. Playwright will
  // happily reuse whatever dev server is already on the port, and a
  // development-mode server talks to *real* Firebase — so without this the
  // suite silently creates accounts on the live project and reports a
  // confusing failure rather than the true one. Statically eliminated in
  // every other mode, like the block it sits in.
  document.documentElement.dataset['genesisEmulator'] = 'true'
}
