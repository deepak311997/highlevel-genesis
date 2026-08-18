import { getApps, initializeApp } from 'firebase-admin/app'
import { getAppCheck, type AppCheck } from 'firebase-admin/app-check'
import { getAuth, type Auth } from 'firebase-admin/auth'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

import { required } from './env'

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
 *    mirrored by `database` in firebase.json. There is no frontend counterpart
 *    any more: the browser has no Firestore handle, because every read and
 *    write goes through a route on this side.
 * 2. It does not read the environment at module scope. `firebase deploy` loads
 *    and analyses the module before injecting functions/.env, so a top-level
 *    throw fails the deploy rather than the request. Resolving on first use
 *    also keeps it off the cold-start path until something needs Firestore.
 */
/**
 * Admin Auth handle.
 *
 * Unlike Firestore there is nothing to configure — but it still goes through
 * this module so that importing it is what guarantees `initializeApp()` above
 * has run. A bare `getAuth()` at a call site works only by accident of import
 * order.
 */
export function getAdminAuth(): Auth {
  return getAuth()
}

/**
 * Admin App Check handle, for verifying tokens minted by the browser SDK.
 *
 * Routed through this module for the same reason as {@link getAdminAuth}, and
 * named `getAppCheckService` rather than re-exporting `getAppCheck` so the
 * middleware's test can substitute it without also stubbing the Admin SDK's
 * app initialisation.
 */
export function getAppCheckService(): AppCheck {
  return getAppCheck()
}

export function getDb(): Firestore {
  if (cached) return cached

  cached = getFirestore(required('FIRESTORE_DATABASE_ID'))
  return cached
}
