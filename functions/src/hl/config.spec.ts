import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hlAllowMessageSend, hlUpstreamTimeoutMs, UPSTREAM_TIMEOUT_MS } from './config'

/**
 * The two proxy settings, and why each is read the way it is.
 *
 * `HL_ALLOW_MESSAGE_SEND` guards a route that sends a real SMS or email — it
 * costs money and reaches a real person (D5, R5) — so the default must be off
 * and the *only* value that turns it on must be an explicit `true`. Anything
 * looser and a stray `HL_ALLOW_MESSAGE_SEND=0` in someone's shell enables it.
 *
 * `HL_TEST_UPSTREAM_TIMEOUT_MS` follows `keepAliveMs()`'s precedent exactly, for
 * exactly its reason: a twenty-second case in a suite that runs on every push is
 * a case people delete. The override is honoured only under the emulator, and
 * the real default is asserted here rather than being taken on trust.
 */

const KEYS = ['HL_ALLOW_MESSAGE_SEND', 'HL_TEST_UPSTREAM_TIMEOUT_MS', 'FUNCTIONS_EMULATOR'] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) Reflect.deleteProperty(process.env, key)
})

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

describe('hlAllowMessageSend', () => {
  it('is off when the variable is unset', () => {
    expect(hlAllowMessageSend()).toBe(false)
  })

  it.each(['', '   ', 'false', '0', 'no', 'TRUE', 'yes'])('is off for %o', (value) => {
    process.env['HL_ALLOW_MESSAGE_SEND'] = value

    expect(hlAllowMessageSend()).toBe(false)
  })

  it('is on only for an explicit true', () => {
    process.env['HL_ALLOW_MESSAGE_SEND'] = 'true'

    expect(hlAllowMessageSend()).toBe(true)
  })
})

describe('hlUpstreamTimeoutMs', () => {
  // AC-33's real number, asserted where a twenty-second test cannot.
  it('is twenty seconds', () => {
    expect(UPSTREAM_TIMEOUT_MS).toBe(20_000)
    expect(hlUpstreamTimeoutMs()).toBe(20_000)
  })

  it('ignores the test override outside the emulator', () => {
    process.env['HL_TEST_UPSTREAM_TIMEOUT_MS'] = '2000'

    expect(hlUpstreamTimeoutMs()).toBe(20_000)
  })

  it('honours the test override under the emulator', () => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'
    process.env['HL_TEST_UPSTREAM_TIMEOUT_MS'] = '2000'

    expect(hlUpstreamTimeoutMs()).toBe(2000)
  })

  it.each(['nonsense', '0', '-1', 'Infinity'])(
    'falls back to the default for the unusable override %o',
    (value) => {
      process.env['FUNCTIONS_EMULATOR'] = 'true'
      process.env['HL_TEST_UPSTREAM_TIMEOUT_MS'] = value

      expect(hlUpstreamTimeoutMs()).toBe(20_000)
    },
  )
})
