import { afterEach, describe, expect, it, vi } from 'vitest'

import { DevMailTransport } from './devMail'
import { getTransport } from './index'
import { Smtp2GoTransport } from './smtp2go'

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Config the real transport needs; irrelevant to the fake. */
function stubRealConfig(): void {
  vi.stubEnv('SMTP2GO_API_KEY', 'api-key')
  vi.stubEnv('MAIL_FROM_EMAIL', 'no-reply@example.test')
  vi.stubEnv('MAIL_FROM_NAME', 'Genesis')
}

describe('getTransport', () => {
  it('uses the recording fake inside the emulator', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true')

    expect(getTransport()).toBeInstanceOf(DevMailTransport)
  })

  it('uses SMTP2GO when not running under the emulator', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '')
    stubRealConfig()

    expect(getTransport()).toBeInstanceOf(Smtp2GoTransport)
  })

  /**
   * The fake writes live action links into Firestore. If any ordinary
   * configuration value could select it, one misconfigured deploy would put
   * real password-reset links in a database. Only the emulator's own marker
   * counts, and production never sets it.
   */
  it.each([
    ['NODE_ENV', 'test'],
    ['EMAIL_TRANSPORT', 'dev'],
    ['USE_FAKE_EMAIL', 'true'],
    ['GENESIS_ENV', 'development'],
    ['FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099'],
  ])('cannot be switched to the fake by %s', (name, value) => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '')
    stubRealConfig()
    vi.stubEnv(name, value)

    expect(getTransport()).toBeInstanceOf(Smtp2GoTransport)
  })

  it('treats any value other than the exact emulator marker as production', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'TRUE')
    stubRealConfig()

    expect(getTransport()).toBeInstanceOf(Smtp2GoTransport)
  })

  it('fails loudly when the real transport is unconfigured', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '')
    vi.stubEnv('SMTP2GO_API_KEY', '')

    expect(() => getTransport()).toThrow(/SMTP2GO_API_KEY/)
  })

  it('does not require mail credentials to run under the emulator', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true')
    vi.stubEnv('SMTP2GO_API_KEY', '')

    expect(() => getTransport()).not.toThrow()
  })
})
