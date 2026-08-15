import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app'
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore'

const env = import.meta.env

// Optional keys are spread in only when present. Under
// exactOptionalPropertyTypes, `{ appId: undefined }` is a type error where
// omitting the key entirely is fine — and it is also what the SDK expects.
const config: FirebaseOptions = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? 'demo-genesis.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'demo-genesis',
  ...(env.VITE_FIREBASE_STORAGE_BUCKET && {
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  }),
  ...(env.VITE_FIREBASE_MESSAGING_SENDER_ID && {
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  }),
  ...(env.VITE_FIREBASE_APP_ID && { appId: env.VITE_FIREBASE_APP_ID }),
}

export const app: FirebaseApp = initializeApp(config)
export const auth: Auth = getAuth(app)
export const db: Firestore = getFirestore(app)

// Emulators are the default in a dev build. Opting *out* has to be explicit,
// because the failure mode of the opposite default is a dev machine silently
// talking to production Firebase — which is both dangerous and, for a project
// id like `demo-genesis`, confusing to diagnose.
const useEmulators = import.meta.env.DEV
  ? env.VITE_USE_EMULATORS !== 'false'
  : env.VITE_USE_EMULATORS === 'true'

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
}
