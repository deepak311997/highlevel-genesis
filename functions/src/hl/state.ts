import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * The OAuth `state` parameter — an encrypted, stateless token.
 *
 * `state` has one job: carry the Firebase uid across a callback that cannot be
 * authenticated. HighLevel redirects a browser to `/api/oauth/callback` and
 * there is no session, no cookie and no ID token on that request, so this token
 * is the only thing tying the response back to a user.
 *
 * **Encrypted rather than signed, and stateless rather than stored.** Both are
 * deliberate reversals recorded in the PRD (D3, D4):
 *
 *  - *Encrypted.* A signed token's payload is readable by whoever holds it, and
 *    this one travels in a URL to another company — so a signed state would put
 *    the uid in HighLevel's request logs, the user's browser history, and any
 *    `Referer` sent onward from the authorize page. AES-GCM also authenticates,
 *    so the tag does the job a separate HMAC would have done and tampering is
 *    caught before any plaintext is trusted.
 *  - *Stateless.* An earlier design stored single-use documents in Firestore for
 *    replay protection. Replay achieves nothing: the callback also carries an
 *    authorization code that HighLevel itself consumes on first use, so a
 *    replayed URL fails at the exchange. And the CSRF attack `state` exists to
 *    stop — feeding a victim the attacker's code — is defeated by binding the
 *    uid *into* the token, since the connection then lands on the attacker's own
 *    account. The collection was buying protection two other mechanisms already
 *    provided.
 *
 * Wire format is `base64url(iv ‖ ciphertext ‖ authTag)`. The IV is fresh per
 * seal, which is also what makes two connects by one user in the same
 * millisecond produce different tokens — so the payload needs no nonce of its
 * own.
 */

/** How long a connect attempt stays valid. */
export const STATE_TTL_MS = 5 * 60_000

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/** Domain separation, so this key can never collide with another HKDF use. */
const HKDF_INFO = 'genesis-oauth-state'

/**
 * Every rejection, whatever the cause.
 *
 * One error type on purpose: the caller redirects with a single
 * `invalid_state` code and must not be able to tell a forgery from an expiry.
 * Distinguishing them would hand anyone probing the endpoint a signal about
 * which half of the check they had already beaten.
 */
export class InvalidStateError extends Error {
  constructor() {
    super('The connection link is not valid.')
    this.name = 'InvalidStateError'
  }
}

/**
 * Derived per secret rather than once, so a test that swaps the environment
 * gets a different key — and so a rotated secret takes effect on the next call
 * rather than at the next cold start.
 */
const keyCache = new Map<string, Buffer>()

function getKey(): Buffer {
  const secret = process.env['OAUTH_STATE_SECRET']?.trim()
  if (secret === undefined || secret === '') {
    throw new Error(
      'Missing OAUTH_STATE_SECRET. Set it in functions/.env — see functions/.env.example.',
    )
  }

  const cached = keyCache.get(secret)
  if (cached) return cached

  // HKDF rather than using the secret directly, so the configured value may be
  // any sufficiently random string instead of exactly 32 bytes.
  const key = Buffer.from(hkdfSync('sha256', secret, '', HKDF_INFO, KEY_BYTES))
  keyCache.set(secret, key)
  return key
}

interface StatePayload {
  uid: string
  exp: number
}

export function sealState(uid: string, now = Date.now()): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const payload: StatePayload = { uid, exp: now + STATE_TTL_MS }

  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])

  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url')
}

/**
 * Decrypt, then check the expiry — in that order.
 *
 * Decryption verifies the GCM tag, so nothing about the payload is trusted
 * until the token is known to be ours. Checking `exp` first would mean parsing
 * attacker-controlled bytes before authenticating them.
 */
export function openState(token: string, now = Date.now()): { uid: string } {
  const raw = Buffer.from(token, 'base64url')
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new InvalidStateError()

  const iv = raw.subarray(0, IV_BYTES)
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES)
  const tag = raw.subarray(raw.length - TAG_BYTES)

  let plaintext: string
  try {
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv)
    decipher.setAuthTag(tag)
    plaintext = decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
  } catch {
    // A bad tag, a wrong key, a mangled IV — all the same answer.
    throw new InvalidStateError()
  }

  let payload: StatePayload
  try {
    payload = JSON.parse(plaintext) as StatePayload
  } catch {
    throw new InvalidStateError()
  }

  if (typeof payload.uid !== 'string' || payload.uid === '') throw new InvalidStateError()
  if (typeof payload.exp !== 'number' || now > payload.exp) throw new InvalidStateError()

  return { uid: payload.uid }
}
