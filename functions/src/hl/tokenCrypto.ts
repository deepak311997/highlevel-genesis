import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { defineSecret } from 'firebase-functions/params'

/**
 * The HighLevel access and refresh tokens, sealed for storage.
 *
 * **What this defends, precisely.** Firestore encrypts at rest already, which
 * protects the disks. It does nothing against anything holding a Firestore
 * *read* — a leaked `datastore.viewer` key, an export left in a bucket, an IAM
 * grant one role too wide. Those all read a live access token and a refresh
 * token good for months. Sealing moves the bar to Secret Manager: the collection
 * alone is no longer enough.
 *
 * **What it does not defend** is a compromised function, which holds the key and
 * the ciphertext both. That is the honest limit. This sits under the rules that
 * deny every client outright, not in place of them.
 *
 * **Its own secret, not the OAuth state key.** The two protect different things
 * on different clocks — rotating the state key should not invalidate every stored
 * connection — and one compromise should not be two.
 *
 * The scheme is `state.ts`'s, deliberately: AES-256-GCM, a key derived through
 * HKDF so the configured secret may be any random string rather than exactly 32
 * bytes, a fresh IV per seal, and the GCM tag doing an HMAC's job.
 */

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/** Domain separation, so this key can never collide with another HKDF use. */
const HKDF_INFO = 'genesis-hl-token'

/**
 * The marker that says "this value is sealed", and the whole of the migration.
 *
 * A read accepts both shapes: a value carrying this prefix is decrypted, and
 * anything else is a token written before this existed and is returned as it is.
 * The connection keeps working and the next rotation writes it back sealed, so no
 * user is asked to reconnect for a change they cannot see.
 *
 * Unambiguous because HighLevel issues JWTs, whose three base64url segments
 * cannot contain a `:`. The version is in the prefix so a second scheme can be
 * introduced later without guessing at what is already stored.
 */
const PREFIX = 'v1:'

/**
 * The key material, from Secret Manager.
 *
 * `functions/.env` is uploaded as plain Cloud Run environment and readable by
 * anyone with Viewer — which for this value would hand over every stored
 * connection, defeating the point of sealing them.
 */
export const HL_TOKEN_SECRET = defineSecret('HL_TOKEN_SECRET')

/** Derived per secret, so a test that swaps the environment gets a different key. */
const keyCache = new Map<string, Buffer>()

function getKey(): Buffer {
  /*
   * Checked explicitly: `value()` answers `''` for a secret the function was not
   * granted, and HKDF would derive a *working* key from the empty string — a
   * cipher every stored token is readable under by anyone who notices.
   */
  const secret = HL_TOKEN_SECRET.value().trim()
  if (secret === '') {
    throw new Error(
      'Missing HL_TOKEN_SECRET. Set it with `firebase functions:secrets:set ' +
        'HL_TOKEN_SECRET` — see functions/.env.example.',
    )
  }

  const cached = keyCache.get(secret)
  if (cached) return cached

  const key = Buffer.from(hkdfSync('sha256', secret, '', HKDF_INFO, KEY_BYTES))
  keyCache.set(secret, key)
  return key
}

/** Whether a stored value has already been sealed — the legacy read's one branch. */
export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX)
}

/** `v1:base64url(iv ‖ ciphertext ‖ authTag)`. */
export function sealToken(token: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])

  return PREFIX + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url')
}

/**
 * The stored value as a usable token.
 *
 * Throws on a sealed value that will not open — a wrong key, a truncated
 * document, a tampered one. The caller turns that into "no connection", which is
 * the truthful answer: reconnecting overwrites the document, so it is also the
 * fix.
 */
export function openToken(stored: string): string {
  if (!isSealed(stored)) return stored

  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url')
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('Stored token is malformed.')

  const iv = raw.subarray(0, IV_BYTES)
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES)
  const tag = raw.subarray(raw.length - TAG_BYTES)

  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
