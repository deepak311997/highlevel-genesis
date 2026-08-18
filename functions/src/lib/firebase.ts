import { getApps, initializeApp } from 'firebase-admin/app'
import { getAppCheck, type AppCheck } from 'firebase-admin/app-check'
import { getAuth, type Auth } from 'firebase-admin/auth'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

import { required } from './env'

/**
 * Initialise the Admin SDK exactly once per container: Cloud Functions reuses warm
 * instances, so a bare `initializeApp()` throws on the second invocation.
 */
if (getApps().length === 0) {
  initializeApp()
}

let cached: Firestore | undefined

/**
 * Admin Auth handle. Nothing to configure, but it goes through this module so
 * importing it guarantees `initializeApp()` above has run — a bare `getAuth()` at
 * a call site works only by accident of import order.
 */
export function getAdminAuth(): Auth {
  return getAuth()
}

/**
 * Admin App Check handle. Routed through this module for {@link getAdminAuth}'s
 * reason, and named separately so the middleware's test can substitute it without
 * stubbing the SDK's app initialisation.
 */
export function getAppCheckService(): AppCheck {
  return getAppCheck()
}

/**
 * Firestore handle for the project's **named** database.
 *
 * Not `getFirestore()` with no argument, which would connect to `(default)` — a
 * database this project keeps no data in. And the environment is read on first use
 * rather than at module scope, because `firebase deploy` analyses the module
 * before injecting it, so a top-level throw would fail the deploy rather than the
 * request.
 */
export function getDb(): Firestore {
  if (cached) return cached

  cached = getFirestore(required('FIRESTORE_DATABASE_ID'))
  return cached
}
