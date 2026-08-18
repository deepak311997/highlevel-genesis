import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isSealed, openToken, sealToken } from './tokenCrypto'

/**
 * The HighLevel tokens, at rest.
 *
 * Firestore encrypts everything at rest already, which defends the disks and
 * nothing else: anything holding a Firestore read — a leaked `datastore.viewer`
 * key, an export sitting in a bucket, an over-broad IAM grant — reads a plaintext
 * access token and a refresh token good for six months. Sealing them moves that
 * bar to Secret Manager, so reading the collection is no longer enough.
 *
 * What it does **not** defend is a compromised function, which holds the key and
 * the data both. That is the honest limit, and the reason this is one layer under
 * the rules rather than a replacement for them.
 */

const SECRET = 'test-token-secret-not-a-real-key-0123456789'
const OTHER_SECRET = 'a-completely-different-token-secret-987654'

/** A shape close to the real thing: HighLevel issues JWTs. */
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJsb2NhdGlvbl9pZCI6ImFiYyJ9.c2lnbmF0dXJl'

let saved: string | undefined

beforeEach(() => {
  saved = process.env['HL_TOKEN_SECRET']
  process.env['HL_TOKEN_SECRET'] = SECRET
})

afterEach(() => {
  if (saved === undefined) delete process.env['HL_TOKEN_SECRET']
  else process.env['HL_TOKEN_SECRET'] = saved
})

describe('sealToken / openToken', () => {
  it('round-trips a token', () => {
    expect(openToken(sealToken(TOKEN))).toBe(TOKEN)
  })

  it('does not disclose the token', () => {
    const sealed = sealToken(TOKEN)

    expect(sealed).not.toContain(TOKEN)
    // Not even a fragment: a JWT's payload segment is the readable half.
    expect(sealed).not.toContain('eyJsb2NhdGlvbl9pZCI6ImFiYyJ9')
  })

  /*
   * A fresh IV per seal, which is what stops a reader learning that two
   * connections hold the same token — and, under AES-GCM, is not optional.
   */
  it('produces a different ciphertext every time', () => {
    expect(sealToken(TOKEN)).not.toBe(sealToken(TOKEN))
  })

  it('refuses a value whose ciphertext was altered', () => {
    const sealed = sealToken(TOKEN)
    const raw = Buffer.from(sealed.slice('v1:'.length), 'base64url')
    const byte = raw[14]
    if (byte === undefined) throw new Error('sealed value is too short to corrupt')
    raw[14] = byte ^ 0x01

    expect(() => openToken(`v1:${raw.toString('base64url')}`)).toThrow()
  })

  it('refuses a value sealed under another secret', () => {
    const sealed = sealToken(TOKEN)
    process.env['HL_TOKEN_SECRET'] = OTHER_SECRET

    expect(() => openToken(sealed)).toThrow()
  })

  /*
   * The migration, and the reason reads accept two shapes. The connection written
   * before this existed holds a bare token; it keeps working and is sealed by the
   * next rotation, so nobody has to reconnect.
   */
  it('passes a legacy plaintext value through unchanged', () => {
    expect(openToken(TOKEN)).toBe(TOKEN)
  })

  it('tells the two apart', () => {
    expect(isSealed(sealToken(TOKEN))).toBe(true)
    expect(isSealed(TOKEN)).toBe(false)
  })

  /*
   * `value()` answers '' for a secret the function was not granted, and HKDF
   * would derive a perfectly working key from the empty string — a cipher under a
   * key anyone can guess. state.ts makes the same check for the same reason.
   */
  it('refuses to work without a secret', () => {
    process.env['HL_TOKEN_SECRET'] = '   '

    expect(() => sealToken(TOKEN)).toThrow(/HL_TOKEN_SECRET/)
  })
})
