import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { describeError, logAuthEvent, redact, REDACTED } from './log'

describe('redact', () => {
  it.each([
    'password',
    'newPassword',
    'oobCode',
    'idToken',
    'refreshToken',
    'accessToken',
    'apiKey',
    'authorization',
    'cookie',
  ])('replaces the value of a %s field', (key) => {
    const out = redact({ [key]: 'super-secret' }) as Record<string, unknown>

    expect(out[key]).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain('super-secret')
  })

  it('matches field names case-insensitively', () => {
    const out = redact({ Password: 'p', OOBCODE: 'o', 'X-Api-Key': 'k' })

    expect(JSON.stringify(out)).not.toContain('"p"')
    expect(JSON.stringify(out)).not.toContain('"o"')
    expect(JSON.stringify(out)).not.toContain('"k"')
  })

  it('reaches into nested objects and arrays', () => {
    const out = redact({
      body: { user: { password: 'nested-secret' } },
      attempts: [{ oobCode: 'array-secret' }],
    })

    const json = JSON.stringify(out)
    expect(json).not.toContain('nested-secret')
    expect(json).not.toContain('array-secret')
  })

  // An action link is a bearer credential: whoever holds it can verify the
  // address or set the password. It must never reach a log sink.
  it.each([
    'https://app.example.test/auth/action?mode=verifyEmail&oobCode=ABC123',
    'https://app.example.test/auth/action?oobcode=abc123&mode=resetPassword',
  ])('redacts a whole string that carries an action code', (link) => {
    const out = redact({ note: link }) as Record<string, unknown>

    expect(out['note']).toBe(REDACTED)
  })

  it('keeps fields that carry no secret, so the log stays useful', () => {
    const out = redact({ status: 429, branch: 'existing_unverified', emailHash: 'a1b2' })

    expect(out).toEqual({ status: 429, branch: 'existing_unverified', emailHash: 'a1b2' })
  })

  it('survives a circular reference rather than throwing inside a catch block', () => {
    const circular: Record<string, unknown> = { status: 500 }
    circular['self'] = circular

    expect(() => redact(circular)).not.toThrow()
  })
})

describe('describeError', () => {
  it('reports a Firebase error code without its payload', () => {
    const err = Object.assign(new Error('Request failed'), {
      code: 'auth/email-already-exists',
      response: { body: { password: 'leaked-in-the-error' } },
    })

    const described = describeError(err)

    expect(described).toContain('auth/email-already-exists')
    expect(described).not.toContain('leaked-in-the-error')
  })

  it('reports a plain Error by message only', () => {
    expect(describeError(new Error('boom'))).toContain('boom')
  })

  it.each([
    ['a string', 'just a string'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('degrades safely for %s', (_label, value) => {
    expect(() => describeError(value)).not.toThrow()
    expect(typeof describeError(value)).toBe('string')
  })

  it('redacts a message that itself embeds a credential', () => {
    const err = new Error('failed for password=hunter2 oobCode=ABC')

    expect(describeError(err)).not.toContain('hunter2')
  })
})

describe('logAuthEvent', () => {
  let info: ReturnType<typeof vi.fn>

  beforeEach(() => {
    info = vi.fn()
    vi.stubGlobal('console', { ...console, info, error: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes one line carrying the event code and its safe context', () => {
    logAuthEvent('register.sent', { emailHash: 'a1b2c3', branch: 'new' })

    expect(info).toHaveBeenCalledTimes(1)
    const line = JSON.stringify(info.mock.calls[0])
    expect(line).toContain('register.sent')
    expect(line).toContain('a1b2c3')
  })

  it('redacts a secret that reaches it despite the typed context', () => {
    // Callers are typed, but an `unknown` from a catch block is not — the
    // helper must not depend on discipline it cannot enforce.
    logAuthEvent('register.failed', { password: 'hunter2' } as never)

    expect(JSON.stringify(info.mock.calls[0])).not.toContain('hunter2')
  })
})
