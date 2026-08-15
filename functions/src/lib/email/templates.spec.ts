import { describe, expect, it } from 'vitest'

import { activationEmail, alreadyRegisteredEmail, passwordResetEmail } from './templates'

const LINK = 'https://app.example.test/auth/action?mode=verifyEmail&oobCode=ABC123'
const RESET_LINK = 'https://app.example.test/auth/action?mode=resetPassword&oobCode=XYZ789'

describe('activationEmail', () => {
  const mail = activationEmail(LINK)

  it('carries the link in both bodies', () => {
    expect(mail.textBody).toContain(LINK)
    expect(mail.htmlBody).toContain('ABC123')
  })

  /**
   * D18c. Anyone can trigger this email at someone else's address, so it has to
   * tell the reader that clicking is what completes an account they may not
   * have asked for. Without this line the message is an invitation to verify a
   * stranger's registration.
   */
  it('warns the reader if they did not request it', () => {
    expect(mail.textBody.toLowerCase()).toContain("didn't create this account")
    expect(mail.htmlBody?.toLowerCase()).toContain("didn't create this account")
  })

  it('does not imply an account already existed', () => {
    expect(mail.textBody.toLowerCase()).not.toContain('already have an account')
  })

  it('has a subject that says what to do', () => {
    expect(mail.subject.toLowerCase()).toContain('verify')
  })
})

describe('alreadyRegisteredEmail', () => {
  const mail = alreadyRegisteredEmail(RESET_LINK)

  it('offers a reset link, because the reader already has an account', () => {
    expect(mail.textBody).toContain(RESET_LINK)
    expect(mail.textBody.toLowerCase()).toContain('already have an account')
  })

  /**
   * The whole point of the branch. Sending an activation link here would let
   * whoever triggered it verify an account they do not control.
   */
  it('offers no way to verify or activate anything', () => {
    expect(mail.textBody).not.toContain('mode=verifyEmail')
    expect(mail.htmlBody).not.toContain('mode=verifyEmail')
  })
})

describe('passwordResetEmail', () => {
  const mail = passwordResetEmail(RESET_LINK)

  it('carries the reset link', () => {
    expect(mail.textBody).toContain(RESET_LINK)
    expect(mail.subject.toLowerCase()).toContain('password')
  })
})

describe('every template', () => {
  const all = [
    activationEmail(LINK),
    alreadyRegisteredEmail(RESET_LINK),
    passwordResetEmail(RESET_LINK),
  ]

  it('ships a plain-text body as well as HTML', () => {
    for (const mail of all) {
      expect(mail.textBody.length).toBeGreaterThan(0)
      expect(mail.htmlBody?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('escapes the link so it cannot break out of the href attribute', () => {
    const hostile = 'https://app.example.test/a?x=1"><script>alert(1)</script>&y=2'

    for (const build of [activationEmail, alreadyRegisteredEmail, passwordResetEmail]) {
      const html = build(hostile).htmlBody ?? ''
      expect(html).not.toContain('<script>')
      expect(html).toContain('&amp;')
    }
  })
})
