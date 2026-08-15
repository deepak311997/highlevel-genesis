import { beforeEach, describe, expect, it } from 'vitest'

import {
  adminAuth,
  applyPasswordReset,
  canSignIn,
  clearMail,
  codeFrom,
  linkFrom,
  onlyMail,
  postJson,
  recordedMail,
  resetEmulators,
  seedUser,
} from './helpers'

const EMAIL = 'alice@example.test'
const UNKNOWN = 'nobody@example.test'
const PASSWORD = 'Correct-Horse-9'

beforeEach(async () => {
  await resetEmulators()
})

describe('POST /auth/password-reset', () => {
  /**
   * The reason this endpoint exists at all rather than the client SDK's
   * `sendPasswordResetEmail`. Both answers must be indistinguishable, or the
   * forgot-password form becomes the account-existence oracle that registration
   * refuses to be.
   */
  it('answers identically for a known and an unknown address', async () => {
    await seedUser(EMAIL, PASSWORD, true)

    const known = await postJson('/auth/password-reset', { email: EMAIL })
    const unknown = await postJson('/auth/password-reset', { email: UNKNOWN })

    expect(known.status).toBe(unknown.status)
    expect(known.raw).toBe(unknown.raw)
    expect(known.status).toBe(200)
  })

  it('mails a reset link when the account exists', async () => {
    await seedUser(EMAIL, PASSWORD, true)

    await postJson('/auth/password-reset', { email: EMAIL })

    const mail = await onlyMail()
    expect(mail.to).toBe(EMAIL)
    expect(mail.subject.toLowerCase()).toContain('password')
    expect(mail.textBody).toContain('mode=resetPassword')
  })

  it('mails nothing at all when the account does not exist', async () => {
    await postJson('/auth/password-reset', { email: UNKNOWN })

    expect(await recordedMail()).toHaveLength(0)
  })

  it('sets the new password through that link and retires the old one', async () => {
    await seedUser(EMAIL, PASSWORD, true)
    await postJson('/auth/password-reset', { email: EMAIL })
    const code = codeFrom(linkFrom(await onlyMail()))

    expect(await applyPasswordReset(code, 'Brand-New-5')).toBe(true)
    expect(await canSignIn(EMAIL, 'Brand-New-5')).toBe(true)
    expect(await canSignIn(EMAIL, PASSWORD)).toBe(false)
  })

  it('rejects a malformed address', async () => {
    expect((await postJson('/auth/password-reset', { email: 'nope' })).status).toBe(400)
  })
})

describe('POST /auth/resend', () => {
  it('answers identically whether the address is unknown, unverified, or verified', async () => {
    const unknown = await postJson('/auth/resend', { email: UNKNOWN })

    await seedUser(EMAIL, PASSWORD, false)
    const unverified = await postJson('/auth/resend', { email: EMAIL })

    await adminAuth().updateUser((await adminAuth().getUserByEmail(EMAIL)).uid, {
      emailVerified: true,
    })
    const verified = await postJson('/auth/resend', { email: EMAIL })

    expect(unverified.raw).toBe(unknown.raw)
    expect(verified.raw).toBe(unknown.raw)
    expect(unknown.status).toBe(200)
  })

  it('re-issues a verification link for an account awaiting verification', async () => {
    await seedUser(EMAIL, PASSWORD, false)

    await postJson('/auth/resend', { email: EMAIL })

    const mail = await onlyMail()
    expect(mail.to).toBe(EMAIL)
    expect(mail.textBody).toContain('mode=verifyEmail')
  })

  it('sends nothing for an address with no account', async () => {
    await postJson('/auth/resend', { email: UNKNOWN })

    expect(await recordedMail()).toHaveLength(0)
  })

  it('sends nothing for an account that is already verified', async () => {
    await seedUser(EMAIL, PASSWORD, true)
    await clearMail()

    await postJson('/auth/resend', { email: EMAIL })

    expect(await recordedMail()).toHaveLength(0)
  })
})
