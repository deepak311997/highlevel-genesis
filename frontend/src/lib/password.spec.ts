import { describe, expect, it } from 'vitest'

import { PASSWORD_MAX, PASSWORD_MIN, PASSWORD_POLICY_MESSAGE, passwordProblem } from './password'

describe('passwordProblem', () => {
  it.each([
    ['a compliant password', 'Correct-Horse-9'],
    ['a symbol other than a dash', 'Correct_Horse9'],
    ['punctuation', 'Correct.Horse9'],
    ['a space as the symbol', 'Correct Horse9'],
    ['unicode alongside the required classes', 'Aa1!日本語パスワード'],
  ])('accepts %s', (_label, value) => {
    expect(passwordProblem(value)).toBeNull()
  })

  it.each([
    ['no uppercase', 'correct-horse-9'],
    ['no lowercase', 'CORRECT-HORSE-9'],
    ['no digit', 'Correct-Horse-x'],
    ['no symbol', 'CorrectHorse9x'],
    ['a bare passphrase', 'correct horse battery staple'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(passwordProblem(value)).toBe(PASSWORD_POLICY_MESSAGE)
  })

  it('rejects one character below the minimum and accepts the minimum', () => {
    expect(passwordProblem(`Aa1!${'x'.repeat(PASSWORD_MIN - 5)}`)).not.toBeNull()
    expect(passwordProblem(`Aa1!${'x'.repeat(PASSWORD_MIN - 4)}`)).toBeNull()
  })

  it('accepts the maximum and rejects one past it', () => {
    expect(passwordProblem(`Aa1!${'x'.repeat(PASSWORD_MAX - 4)}`)).toBeNull()
    expect(passwordProblem(`Aa1!${'x'.repeat(PASSWORD_MAX - 3)}`)).not.toBeNull()
  })

  /**
   * These bounds mirror an Identity Platform policy configured in the Firebase console, which no
   * test in this repo can read.
   */
  it('matches the console policy it mirrors', () => {
    expect(PASSWORD_MIN).toBe(8)
    expect(PASSWORD_MAX).toBe(50)
  })
})
