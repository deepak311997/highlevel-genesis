import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hlUpstreamTimeoutMs, UPSTREAM_TIMEOUT_MS } from './config'

/**
 * The upstream timeout, and why it is read the way it is.
 *
 * `HL_ALLOW_MESSAGE_SEND` is *not* read here. The live check is `isRouteEnabled(row, env)` in
 * `routes.ts`, which takes the environment as an argument so the allowlist stays pure and Slice
 * 9 can import the table without dragging `process.env` in — and its "exactly `true`" table
 * lives beside it, in `routes.spec.ts`. A second reader here would be the same policy in two
 * places with only one of them wired up, which is how a guard on a route that spends money comes
 * to be tested and not enforced.
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
