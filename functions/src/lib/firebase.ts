import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

/**
 * Initialise the Admin SDK exactly once per container.
 *
 * Cloud Functions reuses warm instances, so a bare `initializeApp()` at module
 * scope throws on the second invocation in the same process.
 */
if (getApps().length === 0) {
  initializeApp()
}

let cached: Firestore | undefined

/**
 * Firestore handle for the project's *named* database.
 *
 * Two things this deliberately does not do:
 *
 * 1. It does not call `getFirestore()` with no argument, which would connect to
 *    `(default)` — a database this project does not keep its data in. The id is
 *    mirrored by `database` in firebase.json and VITE_FIREBASE_DATABASE_ID in
 *    the frontend.
 * 2. It does not read the environment at module scope. `firebase deploy` loads
 *    and analyses the module before injecting functions/.env, so a top-level
 *    throw fails the deploy rather than the request. Resolving on first use
 *    also keeps it off the cold-start path until something needs Firestore.
 */
export function getDb(): Firestore {
  if (cached) return cached

  const databaseId = process.env['FIRESTORE_DATABASE_ID']?.trim()
  if (databaseId === undefined || databaseId === '') {
    throw new Error(
      'Missing FIRESTORE_DATABASE_ID. Set it in functions/.env — see functions/.env.example.',
    )
  }

  cached = getFirestore(databaseId)
  return cached
}
