import { initializeApp as initClientApp, type FirebaseApp } from 'firebase/app'
import {
  applyActionCode,
  confirmPasswordReset,
  connectAuthEmulator,
  getAuth as getClientAuth,
  signInWithEmailAndPassword,
  signOut,
  type Auth as ClientAuth,
} from 'firebase/auth'
import { getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth, type Auth } from 'firebase-admin/auth'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

/**
 * L4 harness — Cloud Functions end to end against the emulators.
 *
 * No third-party mail provider is involved: Firebase sends verification and
 * reset email itself, and the Auth emulator exposes the codes it generates at
 * `/emulator/v1/projects/{id}/oobCodes`. That endpoint is how these tests read
 * a verification link without a mailbox.
 */

export const PROJECT_ID = 'demo-genesis'
export const REGION = 'asia-south1'
export const DATABASE_ID = 'highlevel-genesis'

/**
 * The emulator strips the function name from the path, so the Express app sees
 * `/auth/register` and matches its `/` mount — the same router the Hosting
 * rewrite reaches at `/api/auth/register`.
 */
export const API_BASE = `http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/api`

function emulatorHost(name: 'FIREBASE_AUTH_EMULATOR_HOST' | 'FIRESTORE_EMULATOR_HOST'): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Integration tests must run under \`firebase emulators:exec\` — ` +
        'use `npm run test:integration`, which also builds functions first.',
    )
  }
  return value
}

let app: App | undefined

function adminApp(): App {
  if (app) return app
  // Asserted before initialising: without these the Admin SDK silently reaches
  // for real credentials, and a test suite that quietly talks to production is
  // worse than one that fails.
  emulatorHost('FIREBASE_AUTH_EMULATOR_HOST')
  emulatorHost('FIRESTORE_EMULATOR_HOST')

  app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID })
  return app
}

export function adminAuth(): Auth {
  return getAuth(adminApp())
}

export function adminDb(): Firestore {
  return getFirestore(adminApp(), DATABASE_ID)
}

let clientApp: FirebaseApp | undefined

/**
 * A real client SDK pointed at the Auth emulator.
 *
 * Needed because "was the password left alone?" is only answerable by trying to
 * sign in with it — the Admin SDK exposes no way to read or compare a password,
 * which is the point of it.
 */
function clientAuth(): ClientAuth {
  clientApp ??= initClientApp({ apiKey: 'fake-api-key', projectId: PROJECT_ID }, 'integration')
  const auth = getClientAuth(clientApp)
  connectAuthEmulator(auth, `http://${emulatorHost('FIREBASE_AUTH_EMULATOR_HOST')}`, {
    disableWarnings: true,
  })
  return auth
}

/** Whether these credentials are currently valid. */
export async function canSignIn(email: string, password: string): Promise<boolean> {
  const auth = clientAuth()
  try {
    await signInWithEmailAndPassword(auth, email, password)
    return true
  } catch {
    return false
  } finally {
    await signOut(auth).catch(() => undefined)
  }
}

/** Create an account directly, bypassing the endpoint under test. */
export async function seedUser(
  email: string,
  password: string,
  emailVerified: boolean,
): Promise<string> {
  const user = await adminAuth().createUser({ email, password, emailVerified })
  return user.uid
}

/** Wipe both emulators so each test starts from a known, empty state. */
export async function resetEmulators(): Promise<void> {
  const auth = emulatorHost('FIREBASE_AUTH_EMULATOR_HOST')
  const firestore = emulatorHost('FIRESTORE_EMULATOR_HOST')

  await Promise.all([
    fetch(`http://${auth}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: 'DELETE' }),
    fetch(
      `http://${firestore}/emulator/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`,
      { method: 'DELETE' },
    ),
  ])
}

export interface JsonResponse {
  status: number
  body: unknown
  /** Raw text, for asserting two responses are byte-identical. */
  raw: string
}

export async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  const raw = await res.text()
  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = raw
  }

  return { status: res.status, body: parsed, raw }
}

export interface OobCode {
  email: string
  requestType: 'VERIFY_EMAIL' | 'PASSWORD_RESET' | string
  oobCode: string
  oobLink: string
}

/** Every out-of-band code the Auth emulator has generated, oldest first. */
export async function oobCodes(): Promise<OobCode[]> {
  const host = emulatorHost('FIREBASE_AUTH_EMULATOR_HOST')
  const res = await fetch(`http://${host}/emulator/v1/projects/${PROJECT_ID}/oobCodes`)
  const body = (await res.json()) as { oobCodes?: OobCode[] }
  return body.oobCodes ?? []
}

/** The latest code of a given type for an address, or undefined. */
export async function latestCodeFor(
  email: string,
  requestType: OobCode['requestType'],
): Promise<OobCode | undefined> {
  const all = await oobCodes()
  return all.filter((c) => c.email === email && c.requestType === requestType).at(-1)
}

/** Whether a verification code is still live. */
export async function applyVerification(oobCode: string): Promise<boolean> {
  try {
    await applyActionCode(clientAuth(), oobCode)
    return true
  } catch {
    return false
  }
}

/** Whether a reset code is still live, setting the password if it is. */
export async function applyPasswordReset(oobCode: string, newPassword: string): Promise<boolean> {
  try {
    await confirmPasswordReset(clientAuth(), oobCode, newPassword)
    return true
  } catch {
    return false
  }
}
