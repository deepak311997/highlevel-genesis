import { describe, expect, it } from 'vitest'

import { emailOnlySchema, PASSWORD_MAX, PASSWORD_MIN, registerSchema } from './schema'

const VALID = { email: 'alice@example.test', password: 'correct-horse' }

describe('registerSchema', () => {
  it('accepts a well-formed email and password', () => {
    const result = registerSchema.safeParse(VALID)

    expect(result.success).toBe(true)
  })

  it('normalises the email so casing and stray spaces cannot fork an account', () => {
    const result = registerSchema.safeParse({ ...VALID, email: '  Alice@Example.TEST  ' })

    expect(result.success).toBe(true)
    expect(result.data?.email).toBe('alice@example.test')
  })

  it.each([
    ['missing an @', 'not-an-email'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['no domain', 'alice@'],
    ['no local part', '@example.test'],
  ])('rejects an email that is %s', (_label, email) => {
    expect(registerSchema.safeParse({ ...VALID, email }).success).toBe(false)
  })

  // NIST SP 800-63B: length is the control that matters. One below the floor
  // fails, the floor itself passes.
  it('rejects a password one character below the minimum', () => {
    const password = 'a'.repeat(PASSWORD_MIN - 1)

    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(false)
  })

  it('accepts a password exactly at the minimum', () => {
    const password = 'a'.repeat(PASSWORD_MIN)

    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(true)
  })

  it('accepts a long passphrase — at least 64 characters, per NIST', () => {
    expect(registerSchema.safeParse({ ...VALID, password: 'a'.repeat(64) }).success).toBe(true)
    expect(registerSchema.safeParse({ ...VALID, password: 'a'.repeat(PASSWORD_MAX) }).success).toBe(
      true,
    )
  })

  it('bounds the password so an absurd input cannot be a cost vector', () => {
    const password = 'a'.repeat(PASSWORD_MAX + 1)

    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(false)
  })

  // The point of the policy: no composition rules. A long lowercase passphrase
  // is stronger than "P@ss1", and rules that reject it push users to the latter.
  it.each([
    ['all lowercase letters', 'abcdefghijkl'],
    ['a passphrase with spaces', 'correct horse battery staple'],
    ['no digits or symbols', 'oneidlemorning'],
    ['unicode', 'ｐａｓｓｗｏｒｄ日本語'],
  ])('imposes no composition rule — accepts %s', (_label, password) => {
    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(true)
  })

  it.each([
    ['a missing password', { email: VALID.email }],
    ['a missing email', { password: VALID.password }],
    ['a non-string password', { email: VALID.email, password: 12345678 }],
    ['a null body', null],
    ['a non-object body', 'nope'],
  ])('rejects %s', (_label, body) => {
    expect(registerSchema.safeParse(body).success).toBe(false)
  })

  it('drops unknown keys rather than passing them through to the Admin SDK', () => {
    const result = registerSchema.safeParse({ ...VALID, emailVerified: true, uid: 'attacker' })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ email: VALID.email, password: VALID.password })
  })
})

describe('emailOnlySchema', () => {
  it('accepts and normalises an email', () => {
    const result = emailOnlySchema.safeParse({ email: 'Bob@Example.TEST' })

    expect(result.success).toBe(true)
    expect(result.data?.email).toBe('bob@example.test')
  })

  it('rejects a malformed email', () => {
    expect(emailOnlySchema.safeParse({ email: 'nope' }).success).toBe(false)
  })
})
