import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { defineSecret } from 'firebase-functions/params'

/**
 * The OAuth `state` parameter — an encrypted, stateless token.
 *
 * `state` has one job: carry the Firebase uid across a callback that cannot be
 * authenticated. There is no session, no cookie and no ID token on that request.
 *
 * **Encrypted rather than signed**, because a signed token's payload is readable
 * by whoever holds it, and this one travels in a URL to another company — the uid
 * would land in HighLevel's logs, the browser's history and any `Referer` sent
 * onward. AES-GCM authenticates too, so the tag does an HMAC's job.
 *
 * **Stateless rather than stored.** Replay protection achieves nothing here: the
 * callback also carries an authorization code HighLevel consumes on first use. And
 * the CSRF attack `state` exists to stop is defeated by binding the uid *into* the
 * token, since the connection then lands on the attacker's own account.
 *
 * Wire format is `base64url(iv ‖ ciphertext ‖ authTag)`, with a fresh IV per seal —
 * which is also why the payload needs no nonce of its own.
 */

/** How long a connect attempt stays valid. */
export const STATE_TTL_MS = 5 * 60_000

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/** Domain separation, so this key can never collide with another HKDF use. */
const HKDF_INFO = 'genesis-oauth-state'

/**
 * Every rejection, whatever the cause. One error type on purpose: the caller
 * redirects with a single code and must not be able to tell a forgery from an
 * expiry, which would signal which half of the check had been beaten.
 */
export class InvalidStateError extends Error {
  constructor() {
    super('The connection link is not valid.')
    this.name = 'InvalidStateError'
  }
}

/**
 * Derived per secret rather than once, so a test that swaps the environment gets a
 * different key and a rotated secret takes effect on the next call.
 */
const keyCache = new Map<string, Buffer>()

/**
 * The key material, from Secret Manager.
 *
 * `functions/.env` is uploaded as plain Cloud Run environment, and what that would
 * disclose here is the key every `state` is sealed under — whoever holds it can
 * mint a state naming any uid and have the callback attach a HighLevel location to
 * that account. It is the one value in this file whose disclosure defeats
 * everything the file is for.
 */
export const OAUTH_STATE_SECRET = defineSecret('OAUTH_STATE_SECRET')

function getKey(): Buffer {
  /*
   * Validated explicitly: `value()` answers `''` for a secret the function was not
   * granted, and HKDF would happily derive a key from the empty string — a
   * *working* cipher under a key an attacker can guess.
   */
  const secret = OAUTH_STATE_SECRET.value().trim()
  if (secret === '') {
    throw new Error(
      'Missing OAUTH_STATE_SECRET. Set it with `firebase functions:secrets:set ' +
        'OAUTH_STATE_SECRET` — see functions/.env.example.',
    )
  }

  const cached = keyCache.get(secret)
  if (cached) return cached

  // HKDF rather than the secret directly, so the configured value may be any
  // sufficiently random string instead of exactly 32 bytes.
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
 * Decrypt, then check the expiry — in that order. Decryption verifies the GCM tag,
 * so nothing about the payload is trusted until the token is known to be ours.
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
