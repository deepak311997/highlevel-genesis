import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { InvalidStateError, openState, sealState, STATE_TTL_MS } from './state'

/**
 * The OAuth `state` parameter.
 *
 * The callback is unauthenticated — HighLevel redirects a browser to it and
 * there is no session to read — so this token is the only link back to a
 * Firebase user. Two properties matter and both are tested here:
 *
 *  - **Unforgeable.** Anyone who could mint a state could have a connection
 *    written against a uid of their choosing.
 *  - **Opaque.** The token travels in a URL to a third party, so a *signed*
 *    token would put the uid in HighLevel's request logs and the user's
 *    history in readable base64. Encryption is what stops that, and
 *    `does not disclose the uid` is the test that proves it.
 */

const SECRET = 'test-secret-not-a-real-key-0123456789'
const OTHER_SECRET = 'a-completely-different-secret-9876543210'
const UID = 'PZ9kQxLm3nR7vB2t'

let saved: string | undefined

beforeEach(() => {
  saved = process.env['OAUTH_STATE_SECRET']
  process.env['OAUTH_STATE_SECRET'] = SECRET
})

afterEach(() => {
  if (saved === undefined) delete process.env['OAUTH_STATE_SECRET']
  else process.env['OAUTH_STATE_SECRET'] = saved
})

/** Flip one bit at `offset` of the decoded token and re-encode it. */
function corruptAt(token: string, offset: number): string {
  const raw = Buffer.from(token, 'base64url')
  const byte = raw[offset]
  if (byte === undefined) throw new Error(`token has no byte at ${String(offset)}`)
  raw[offset] = byte ^ 0x01
  return raw.toString('base64url')
}

describe('sealState / openState', () => {
  it('round trips the uid', () => {
    expect(openState(sealState(UID)).uid).toBe(UID)
  })

  it('does not disclose the uid — the whole reason it is encrypted, not signed', () => {
    const raw = Buffer.from(sealState(UID), 'base64url')
    expect(raw.includes(Buffer.from(UID, 'utf8'))).toBe(false)
  })

  it('produces a different token every time, so two connects never collide', () => {
    const now = 1_700_000_000_000
    expect(sealState(UID, now)).not.toBe(sealState(UID, now))
  })

  it('accepts a token one millisecond before it expires', () => {
    const issued = 1_700_000_000_000
    const token = sealState(UID, issued)
    expect(openState(token, issued + STATE_TTL_MS - 1).uid).toBe(UID)
  })

  it('rejects a token one millisecond after it expires', () => {
    const issued = 1_700_000_000_000
    const token = sealState(UID, issued)
    expect(() => openState(token, issued + STATE_TTL_MS + 1)).toThrow(InvalidStateError)
  })

  it('expires five minutes after issue', () => {
    expect(STATE_TTL_MS).toBe(5 * 60_000)
  })

  // One case per region of the wire format, because a decrypt that ignored any
  // of the three would still pass a round-trip test.
  it.each([
    ['iv', 0],
    ['ciphertext', 12],
    ['auth tag', -1],
  ])('rejects a token whose %s has been altered', (_region, offset) => {
    const token = sealState(UID)
    const at = offset === -1 ? Buffer.from(token, 'base64url').length - 1 : offset
    expect(() => openState(corruptAt(token, at))).toThrow(InvalidStateError)
  })

  it.each([
    ['empty', ''],
    ['not base64url', '!!!not-base64!!!'],
    ['too short to hold an iv and a tag', Buffer.alloc(8).toString('base64url')],
  ])('rejects a token that is %s', (_why, token) => {
    expect(() => openState(token)).toThrow(InvalidStateError)
  })

  it('rejects a token sealed under a different secret', () => {
    const token = sealState(UID)
    process.env['OAUTH_STATE_SECRET'] = OTHER_SECRET
    expect(() => openState(token)).toThrow(InvalidStateError)
  })

  it('fails loudly when the secret is not configured', () => {
    delete process.env['OAUTH_STATE_SECRET']
    expect(() => sealState(UID)).toThrow(/OAUTH_STATE_SECRET/)
  })
})
