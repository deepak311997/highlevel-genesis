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
export const DATABASE_ID = 'hl-genesis'

/**
 * The emulator strips the function name from the path, so the Express app sees
 * `/auth/register` and matches its `/` mount — the same router the Hosting
 * rewrite reaches at `/api/auth/register`.
 */
/**
 * The suite runs the emulators on a second set of ports, so it does not fight a
 * development session for 5001. `npm run test:*` sets this; the default is the
 * ordinary port, for anyone driving vitest by hand.
 */
const FUNCTIONS_PORT = process.env['FUNCTIONS_EMULATOR_PORT'] ?? '5001'

export const API_BASE = `http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/${REGION}/api`

/**
 * `/generate` is its **own function**, not a route on `api` (D1).
 *
 * It needs a 540-second timeout and 512 MiB, which the CRUD endpoints must not
 * pay for, so it is reached at `.../generate` rather than `.../api/generate`.
 * Pointing this at `API_BASE` would 404 against `api`'s terminal catch-all and
 * the failure would read like a missing route.
 */
export const GENERATE_URL = `http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/${REGION}/generate`

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

/**
 * A real Firebase ID token for a seeded user.
 *
 * The authenticated endpoints verify the token with the Admin SDK and read
 * `email_verified` off it, so a hand-made JWT would not do — the emulator has
 * to mint it. Signing in through the client SDK is the only way to get one.
 */
export async function idTokenFor(email: string, password: string): Promise<string> {
  const auth = clientAuth()
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password)
    return await credential.user.getIdToken(true)
  } finally {
    await signOut(auth).catch(() => undefined)
  }
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
  /**
   * Response headers, lower-cased by `fetch`.
   *
   * Here because the proxy's contract includes headers it did not invent —
   * HighLevel's five `X-RateLimit-*` values are copied across (D18), and a
   * suite that could only see the body would call that shipped without ever
   * having looked at it.
   */
  headers: Headers
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

  return toJsonResponse(res)
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

export async function getJson(
  path: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(`${API_BASE}${path}`, { headers })
  return toJsonResponse(res)
}

export async function putJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return toJsonResponse(res)
}

export async function patchJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return toJsonResponse(res)
}

export async function deleteJson(
  path: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers })
  return toJsonResponse(res)
}

/**
 * Follow no redirects, so a 302 is observable.
 *
 * The OAuth callback answers only in `Location` headers — every outcome, success
 * and failure alike — so a test that followed the redirect would assert against
 * the SPA's HTML instead of the thing under test.
 */
export async function fetchNoRedirect(path: string): Promise<{ status: number; location: string }> {
  const res = await fetch(`${API_BASE}${path}`, { redirect: 'manual' })
  return { status: res.status, location: res.headers.get('location') ?? '' }
}

async function toJsonResponse(res: Response): Promise<JsonResponse> {
  const raw = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = raw
  }
  return { status: res.status, body: parsed, raw, headers: res.headers }
}

/**
 * One parsed SSE frame. A comment frame carries neither an event nor data.
 *
 * `event` defaults to `'message'` per the SSE spec, which nothing here emits —
 * a frame arriving with that name means the server wrote `data:` with no
 * `event:`, and the tests should see that rather than silently coerce it.
 */
export interface SseFrame {
  event: string
  data: unknown
  comment: string | null
}

/**
 * Parse a whole SSE body into frames.
 *
 * Deliberately simple and deliberately *not* the client's parser: this is the
 * oracle those tests are checked against, so sharing an implementation would let
 * one bug agree with itself. Frames are separated by a blank line; within a
 * frame, `data:` lines join with a newline and a leading `:` is a comment.
 */
export function readSseFrames(raw: string): SseFrame[] {
  return raw
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split('\n')
      const comment = lines.find((line) => line.startsWith(':'))
      if (comment !== undefined) {
        return { event: '', data: undefined, comment: comment.slice(1).trim() }
      }

      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim()
      const payload = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n')

      let data: unknown
      try {
        data = JSON.parse(payload)
      } catch {
        data = payload
      }
      return { event: event ?? 'message', data, comment: null }
    })
}

export interface GenerateResponse {
  status: number
  contentType: string
  raw: string
  /** The parsed JSON body, for the refusals that never become a stream (D9). */
  body: unknown
  frames: SseFrame[]
}

/**
 * `POST /generate`, read to completion.
 *
 * Both channels are returned every time, because the assertion that matters for
 * a refusal is not only the status: it is that the response is **JSON and not an
 * event stream**. Once headers are flushed the status line is spent, so a
 * handler that opened the stream too early would answer 200 with an `error`
 * frame — which a status-code assertion alone cannot see (D9, R6).
 */
export async function postGenerate(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<GenerateResponse> {
  const res = await fetch(GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  const raw = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = raw
  }

  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    raw,
    body: parsed,
    frames: readSseFrames(raw),
  }
}

/** Every frame carrying the given event name, in order. */
export function framesOf(frames: SseFrame[], event: string): SseFrame[] {
  return frames.filter((frame) => frame.event === event)
}
