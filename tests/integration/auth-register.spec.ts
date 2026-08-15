import { beforeEach, describe, expect, it } from 'vitest'

import { adminAuth, onlyMail, postJson, recordedMail, resetEmulators } from './helpers'

const EMAIL = 'alice@example.test'
const PASSWORD = 'correct-horse-battery'

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
