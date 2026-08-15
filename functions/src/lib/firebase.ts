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

export const db: Firestore = getFirestore()
