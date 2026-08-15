import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

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
