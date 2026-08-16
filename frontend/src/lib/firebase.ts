import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app'
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore'

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

const config: FirebaseOptions = {
  apiKey: required('VITE_FIREBASE_API_KEY', env.VITE_FIREBASE_API_KEY),
  authDomain: required('VITE_FIREBASE_AUTH_DOMAIN', env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: required('VITE_FIREBASE_PROJECT_ID', env.VITE_FIREBASE_PROJECT_ID),
  ...(env.VITE_FIREBASE_STORAGE_BUCKET && {
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  }),
  ...(env.VITE_FIREBASE_MESSAGING_SENDER_ID && {
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  }),
  ...(env.VITE_FIREBASE_APP_ID && { appId: env.VITE_FIREBASE_APP_ID }),
}

/**
 * Firestore lives in a *named* database, not `(default)`.
 *
 * `getFirestore(app)` would silently connect to `(default)`, so the id is
 * passed explicitly here and mirrored by `database` in firebase.json (which is
 * what `firebase deploy --only firestore:rules` targets) and by
 * FIRESTORE_DATABASE_ID in the functions runtime.
 */
const databaseId = required('VITE_FIREBASE_DATABASE_ID', env.VITE_FIREBASE_DATABASE_ID)

export const app: FirebaseApp = initializeApp(config)
export const auth: Auth = getAuth(app)
export const db: Firestore = getFirestore(app, databaseId)

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
  connectFirestoreEmulator(db, '127.0.0.1', Number(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT))

  // A marker the e2e suite checks before it does anything. Playwright will
  // happily reuse whatever dev server is already on the port, and a
  // development-mode server talks to *real* Firebase — so without this the
  // suite silently creates accounts on the live project and reports a
  // confusing failure rather than the true one. Statically eliminated in
  // every other mode, like the block it sits in.
  document.documentElement.dataset['genesisEmulator'] = 'true'
}
