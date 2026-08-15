import { beforeEach, describe, expect, it } from 'vitest'

import {
  adminAuth,
  applyPasswordReset,
  applyVerification,
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
const PASSWORD = 'correct-horse-battery'
const OTHER_PASSWORD = 'a-completely-different-one'

beforeEach(async () => {
  await resetEmulators()
})

describe('POST /auth/register — address not registered', () => {
  it('accepts the registration and reports nothing about the address', async () => {
    const res = await postJson('/auth/register', { email: EMAIL, password: PASSWORD })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('creates the account unverified, so the session gate has something to hold', async () => {
    await postJson('/auth/register', { email: EMAIL, password: PASSWORD })

    const user = await adminAuth().getUserByEmail(EMAIL)
    expect(user.emailVerified).toBe(false)
  })

  it('sends exactly one activation email, to that address', async () => {
    await postJson('/auth/register', { email: EMAIL, password: PASSWORD })

    const mail = await onlyMail()
    expect(mail.to).toBe(EMAIL)
    expect(mail.subject.toLowerCase()).toContain('verify')
    expect(mail.textBody).toContain('/auth/action?')
    expect(mail.textBody).toContain('mode=verifyEmail')
  })

  it('normalises the address, so casing cannot fork one account into two', async () => {
    await postJson('/auth/register', { email: '  Alice@Example.TEST ', password: PASSWORD })

    const user = await adminAuth().getUserByEmail(EMAIL)
    expect(user.email).toBe(EMAIL)
    expect(await recordedMail()).toHaveLength(1)
  })
})

describe('POST /auth/register — address already registered and verified', () => {
  /**
   * The criterion the whole server-side design exists for. If these two
   * responses differ in any observable way — status, body, even byte length —
   * the endpoint is an account-existence oracle and the rest of the flow is
   * decoration.
   */
  it('responds byte-identically to a registration for an unknown address', async () => {
    const fresh = await postJson('/auth/register', {
      email: 'nobody@example.test',
      password: PASSWORD,
    })

    await seedUser(EMAIL, PASSWORD, true)
    const existing = await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    expect(existing.status).toBe(fresh.status)
    expect(existing.raw).toBe(fresh.raw)
  })

  it('leaves the existing password alone', async () => {
    await seedUser(EMAIL, PASSWORD, true)

    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    expect(await canSignIn(EMAIL, PASSWORD)).toBe(true)
    expect(await canSignIn(EMAIL, OTHER_PASSWORD)).toBe(false)
  })

  it('does not create a second account', async () => {
    await seedUser(EMAIL, PASSWORD, true)

    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    const { users } = await adminAuth().listUsers()
    expect(users.filter((u) => u.email === EMAIL)).toHaveLength(1)
  })

  it('emails a reset link instead, and never a way to verify', async () => {
    await seedUser(EMAIL, PASSWORD, true)

    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    const mail = await onlyMail()
    expect(mail.to).toBe(EMAIL)
    expect(mail.textBody.toLowerCase()).toContain('already have an account')
    expect(mail.textBody).toContain('mode=resetPassword')
    // An activation link here would let whoever submitted the form verify an
    // account they do not control.
    expect(mail.textBody).not.toContain('mode=verifyEmail')
  })
})

/**
 * D18 — account pre-hijacking, and an amendment to how it is mitigated.
 *
 * An attacker can register a victim's address before the victim does. The
 * account existing is not the danger — Firestore rules deny an unverified token
 * everything. The danger is the victim later clicking "verify" and thereby
 * activating an account whose password the attacker chose.
 *
 * The plan called for replacing the password on a repeat registration and
 * issuing a fresh link that retires the old one. **Firebase does not retire
 * outstanding codes** — measured below — so that mitigation is not available.
 *
 * The rule instead is simpler and stronger: a registration request never
 * changes anything about an account that already exists. It only ever mails a
 * reset link, which lets whoever holds the mailbox take control of the
 * password. Both orderings then end safely:
 *
 *   attacker first — victim registers, gets a reset link, sets their own
 *   password; the attacker's password is gone before any link can verify it.
 *
 *   victim first — the attacker's registration changes nothing, and the reset
 *   link goes to the victim's mailbox, which the attacker does not hold.
 */
describe('POST /auth/register — address registered but never verified', () => {
  it('never changes the password of an account that already exists', async () => {
    await seedUser(EMAIL, PASSWORD, false)

    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    expect(await canSignIn(EMAIL, PASSWORD)).toBe(true)
    expect(await canSignIn(EMAIL, OTHER_PASSWORD)).toBe(false)
  })

  it('does not create a second account', async () => {
    await seedUser(EMAIL, PASSWORD, false)

    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    const { users } = await adminAuth().listUsers()
    expect(users.filter((u) => u.email === EMAIL)).toHaveLength(1)
  })

  /**
   * A reset link, not an activation link. An activation link here would let
   * whoever submitted this form activate an account whose password someone else
   * set — which is the pre-hijacking attack itself.
   */
  it('emails a reset link, never a fresh activation link', async () => {
    await seedUser(EMAIL, PASSWORD, false)

    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    const mail = await onlyMail()
    expect(mail.textBody).toContain('mode=resetPassword')
    expect(mail.textBody).not.toContain('mode=verifyEmail')
  })

  it('lets the mailbox holder take control through that link', async () => {
    await seedUser(EMAIL, PASSWORD, false)
    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })
    const code = codeFrom(linkFrom(await onlyMail()))

    expect(await applyPasswordReset(code, 'a-third-password')).toBe(true)
    expect(await canSignIn(EMAIL, 'a-third-password')).toBe(true)
    expect(await canSignIn(EMAIL, PASSWORD)).toBe(false)
  })

  it('responds identically to the other branches', async () => {
    const fresh = await postJson('/auth/register', {
      email: 'nobody@example.test',
      password: PASSWORD,
    })
    await seedUser(EMAIL, PASSWORD, false)

    const repeat = await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    expect(repeat.status).toBe(fresh.status)
    expect(repeat.raw).toBe(fresh.raw)
  })
})

/**
 * Pins the platform behaviour the design now works around, so that if Firebase
 * ever starts retiring superseded codes this test fails and someone re-reads
 * the reasoning above rather than inheriting it as folklore.
 */
describe('platform behaviour: verification codes are not superseded', () => {
  it('keeps an earlier verification link live after a later registration', async () => {
    await postJson('/auth/register', { email: EMAIL, password: PASSWORD })
    const firstCode = codeFrom(linkFrom(await onlyMail()))
    await clearMail()

    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    // Still live — which is safe only because the second registration left the
    // password alone, so this link can only ever verify the first registrant's
    // own account.
    expect(await applyVerification(firstCode)).toBe(true)
    expect(await canSignIn(EMAIL, PASSWORD)).toBe(true)
  })
})
