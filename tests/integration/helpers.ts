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
 * HighLevel and the LLM are stubbed everywhere; here the third party that
 * matters is SMTP2GO, and it is never called: `FUNCTIONS_EMULATOR` selects
 * DevMailTransport, which records into Firestore. Reading that collection is
 * how these tests assert *which* email a branch sent, which is the only
 * observable difference between the register branches — the HTTP response is
 * identical by design.
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

export const DEV_MAIL_COLLECTION = '_devMail'

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

export interface RecordedMail {
  to: string
  subject: string
  textBody: string
  htmlBody: string | null
}

/** Every message the fake transport recorded, oldest first. */
export async function recordedMail(): Promise<RecordedMail[]> {
  const snapshot = await adminDb().collection(DEV_MAIL_COLLECTION).get()
  return snapshot.docs
    .map((d) => d.data() as RecordedMail & { createdAt: string })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** The single message sent, failing loudly if the count is not exactly one. */
export async function onlyMail(): Promise<RecordedMail> {
  const all = await recordedMail()
  if (all.length !== 1) {
    throw new Error(`expected exactly one email, found ${String(all.length)}`)
  }
  const [first] = all
  if (first === undefined) throw new Error('unreachable')
  return first
}

/** Pull the action link out of a recorded message. */
export function linkFrom(mail: RecordedMail): string {
  const match = /https?:\/\/\S+/.exec(mail.textBody)
  if (match === null) throw new Error('no link in the recorded email')
  return match[0]
}

/** The one-time code carried by an action link. */
export function codeFrom(link: string): string {
  const code = new URL(link).searchParams.get('oobCode')
  if (code === null || code === '') throw new Error('no oobCode in the link')
  return code
}

/** Delete recorded mail so a second request's message can be read on its own. */
export async function clearMail(): Promise<void> {
  const snapshot = await adminDb().collection(DEV_MAIL_COLLECTION).get()
  await Promise.all(snapshot.docs.map((d) => d.ref.delete()))
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
