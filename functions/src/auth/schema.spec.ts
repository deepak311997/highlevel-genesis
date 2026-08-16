import { describe, expect, it } from 'vitest'

import { emailOnlySchema, PASSWORD_MAX, PASSWORD_MIN, registerSchema } from './schema'

const VALID = { email: 'alice@example.test', password: 'Correct-Horse-9' }

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

  // Length bounds. The maximum mirrors the console cap, not a considered limit.
  it('rejects a password one character below the minimum', () => {
    const password = `Aa1!${'x'.repeat(PASSWORD_MIN - 5)}`

    expect(password).toHaveLength(PASSWORD_MIN - 1)
    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(false)
  })

  it('accepts a password exactly at the minimum', () => {
    const password = `Aa1!${'x'.repeat(PASSWORD_MIN - 4)}`

    expect(password).toHaveLength(PASSWORD_MIN)
    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(true)
  })

  it('accepts a password at the maximum', () => {
    const password = `Aa1!${'x'.repeat(PASSWORD_MAX - 4)}`

    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(true)
  })

  it('rejects one character past the maximum, matching the console cap', () => {
    const password = `Aa1!${'x'.repeat(PASSWORD_MAX - 3)}`

    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(false)
  })

  /**
   * Composition rules, mirroring the Identity Platform policy on the project.
   *
   * Each case is long enough to clear the minimum and misses exactly one rule,
   * so a failure here names the rule that broke rather than "something".
   */
  it.each([
    ['no uppercase', 'correct-horse-9'],
    ['no lowercase', 'CORRECT-HORSE-9'],
    ['no digit', 'Correct-Horse-x'],
    ['no symbol', 'CorrectHorse9x'],
    ['none of them', 'abcdefghijkl'],
    ['a bare passphrase', 'correct horse battery staple'],
  ])('rejects a password with %s', (_label, password) => {
    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(false)
  })

  it.each([
    ['a symbol other than a dash', 'Correct_Horse9'],
    ['punctuation', 'Correct.Horse9'],
    ['a space as the symbol', 'Correct Horse9'],
    ['unicode alongside the required classes', 'Aa1!日本語パスワード'],
  ])('accepts %s', (_label, password) => {
    expect(registerSchema.safeParse({ ...VALID, password }).success).toBe(true)
  })

  /**
   * One message for every failure mode. Itemised feedback would tell anyone
   * probing the endpoint which rules a candidate password already satisfies.
   */
  it('gives the same message whichever rule was missed', () => {
    const messages = [
      'correct-horse-9',
      'CORRECT-HORSE-9',
      'Correct-Horse-x',
      'CorrectHorse9x',
    ].map((password) => registerSchema.safeParse({ ...VALID, password }).error?.issues[0]?.message)

    expect(new Set(messages).size).toBe(1)
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
