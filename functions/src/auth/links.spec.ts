import { afterEach, describe, expect, it, vi } from 'vitest'

import { appActionLink, extractOobCode } from './links'

const FIREBASE_LINK =
  'https://demo-genesis.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=ABC-123_xyz&apiKey=AIza&continueUrl=http%3A%2F%2Flocalhost%3A5173'

describe('extractOobCode', () => {
  it('pulls the code out of a Firebase-generated link', () => {
    expect(extractOobCode(FIREBASE_LINK)).toBe('ABC-123_xyz')
  })

  it.each([
    ['a link with no code', 'https://example.test/__/auth/action?mode=verifyEmail'],
    ['an empty code', 'https://example.test/__/auth/action?oobCode='],
    ['not a URL at all', 'nonsense'],
    ['an empty string', ''],
  ])('throws for %s rather than minting a broken link', (_label, link) => {
    expect(() => extractOobCode(link)).toThrow()
  })
})

describe('appActionLink', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds a link to our own action route, not the Firebase-hosted handler', () => {
    vi.stubEnv('APP_BASE_URL', 'https://app.example.test')

    const link = appActionLink('verifyEmail', 'ABC-123_xyz')

    expect(link).toBe('https://app.example.test/auth/action?mode=verifyEmail&oobCode=ABC-123_xyz')
  })

  it('tolerates a trailing slash on the configured base', () => {
    vi.stubEnv('APP_BASE_URL', 'https://app.example.test/')

    expect(appActionLink('resetPassword', 'X')).toContain('https://app.example.test/auth/action?')
  })

  it('percent-encodes the code so it cannot inject another parameter', () => {
    vi.stubEnv('APP_BASE_URL', 'https://app.example.test')

    const link = appActionLink('verifyEmail', 'a&mode=resetPassword')

    expect(link).toContain('oobCode=a%26mode%3DresetPassword')
    expect(link.match(/mode=/g)).toHaveLength(1)
  })

  it('fails loudly when the base URL is unset, rather than emailing a relative link', () => {
    vi.stubEnv('APP_BASE_URL', '')

    expect(() => appActionLink('verifyEmail', 'X')).toThrow(/APP_BASE_URL/)
  })
})
