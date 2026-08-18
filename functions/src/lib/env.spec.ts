import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  baseUrl,
  emulatorFlag,
  emulatorNumber,
  emulatorOverride,
  isEmulator,
  list,
  required,
  requiredSecret,
} from './env'

/**
 * The one module that reads `process.env`.
 *
 * Before it existed the same three shapes were hand-rolled across four files:
 * `required()` appeared verbatim in both `hl/config.ts` and `lib/firebase.ts`,
 * the emulator-only override appeared in `hl/config.ts` and again in
 * `generate.ts` — whose comment said outright that it was "`hl/config.ts`'s
 * `emulatorOverride` pattern exactly" — and `api/index.ts` parsed a
 * comma-separated list its own way. Four copies is four places for the trim to
 * be forgotten, and the empty-string case is the one that gets forgotten: an
 * unset variable and one set to `''` are the same absence, and only one of them
 * is falsy in the way people expect.
 *
 * The secret *declarations* stay beside their readers — `defineSecret` in
 * `llm/client.ts`, `hl/config.ts` and `hl/state.ts`. That is not an oversight and
 * not an inconsistency with this module: `client.ts` records the reason, which is
 * that a binding declared a file away from the code that reads it is a binding a
 * refactor of the wrong file silently drops. What belongs here is the *mechanics*
 * of reading a value, not the decision about where a value lives.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isEmulator', () => {
  it('is true for exactly the marker the emulator sets', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true')
    expect(isEmulator()).toBe(true)
  })

  /*
   * Compared strictly, and this is the case that matters: this flag gates
   * behaviour that must not exist in a deployed build, so every near-miss has to
   * read as "not the emulator" rather than as a truthy string.
   */
  it.each(['TRUE', '1', 'yes', '', 'false'])('is false for %o', (value) => {
    vi.stubEnv('FUNCTIONS_EMULATOR', value)
    expect(isEmulator()).toBe(false)
  })

  it('is false when unset', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', undefined)
    expect(isEmulator()).toBe(false)
  })
})

describe('required', () => {
  it('returns the value, trimmed', () => {
    vi.stubEnv('GENESIS_TEST_VALUE', '  hello  ')
    expect(required('GENESIS_TEST_VALUE')).toBe('hello')
  })

  /*
   * Blank is absent. A variable named in a `.env` file with nothing after the
   * `=` is the single most common way to half-configure a deployment, and it is
   * indistinguishable from a typo in the name — so both have to throw.
   */
  it.each([undefined, '', '   '])('throws for %o', (value) => {
    vi.stubEnv('GENESIS_TEST_VALUE', value)
    expect(() => required('GENESIS_TEST_VALUE')).toThrow(/Missing GENESIS_TEST_VALUE/)
  })

  /* The message has to say where to put it, or it costs someone a search. */
  it('names functions/.env in the message', () => {
    vi.stubEnv('GENESIS_TEST_VALUE', undefined)
    expect(() => required('GENESIS_TEST_VALUE')).toThrow(/functions\/\.env/)
  })
})

describe('requiredSecret', () => {
  it('returns the value, trimmed', () => {
    expect(requiredSecret({ value: () => '  s3cret  ' }, 'GENESIS_TEST_SECRET')).toBe('s3cret')
  })

  /*
   * `SecretParam.value()` answers `''` for a secret the function was never
   * granted, and only `warn`s about it. That is the whole reason this exists
   * rather than a bare `.value()` at each call site: unchecked, the failure
   * surfaces a long way downstream — as an upstream `invalid_client`, or worse,
   * as a cipher that works under a key derived from the empty string.
   */
  it('throws for the empty string an ungranted secret answers with', () => {
    expect(() => requiredSecret({ value: () => '' }, 'GENESIS_TEST_SECRET')).toThrow(
      /Missing GENESIS_TEST_SECRET/,
    )
  })

  /*
   * A different message from `required`'s, on purpose. Telling someone to set a
   * Secret Manager value in `functions/.env` is telling them to put a secret in
   * the one file that is uploaded as plain Cloud Run environment.
   */
  it('points at functions:secrets:set, not at functions/.env', () => {
    const fail = (): string => requiredSecret({ value: () => '' }, 'GENESIS_TEST_SECRET')

    expect(fail).toThrow(/functions:secrets:set GENESIS_TEST_SECRET/)
    expect(fail).not.toThrow(/Set it in functions\/\.env/)
  })
})

describe('baseUrl', () => {
  it('falls back when unset or blank', () => {
    vi.stubEnv('GENESIS_TEST_URL', undefined)
    expect(baseUrl('GENESIS_TEST_URL', 'https://fallback.example')).toBe('https://fallback.example')

    vi.stubEnv('GENESIS_TEST_URL', '   ')
    expect(baseUrl('GENESIS_TEST_URL', 'https://fallback.example')).toBe('https://fallback.example')
  })

  /*
   * Stripped so every caller can join with a leading slash and none of them has
   * to think about it. `//locations/x` is a different path from `/locations/x`
   * to a strict router, and the difference is one invisible character in a
   * config file.
   */
  it.each([
    ['https://api.example/', 'https://api.example'],
    ['https://api.example///', 'https://api.example'],
    ['  https://api.example/  ', 'https://api.example'],
  ])('strips trailing slashes: %o', (given, want) => {
    vi.stubEnv('GENESIS_TEST_URL', given)
    expect(baseUrl('GENESIS_TEST_URL', 'https://fallback.example')).toBe(want)
  })

  /* The fallback is a configured value too, and gets the same treatment. */
  it('strips the fallback as well', () => {
    vi.stubEnv('GENESIS_TEST_URL', undefined)
    expect(baseUrl('GENESIS_TEST_URL', 'https://fallback.example/')).toBe(
      'https://fallback.example',
    )
  })
})

describe('list', () => {
  it('splits on commas and trims each entry', () => {
    vi.stubEnv('GENESIS_TEST_LIST', 'https://a.example, https://b.example ,https://c.example')
    expect(list('GENESIS_TEST_LIST', ['https://fallback.example'])).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ])
  })

  /*
   * A trailing comma is a configured list, not an empty entry — and an empty
   * entry in an origin allowlist would be an entry that matches an empty Origin
   * header.
   */
  it('drops empty entries a stray comma leaves behind', () => {
    vi.stubEnv('GENESIS_TEST_LIST', 'https://a.example,,  ,')
    expect(list('GENESIS_TEST_LIST', ['https://fallback.example'])).toEqual(['https://a.example'])
  })

  it.each([undefined, '', '  ,  ,'])('falls back when the list is empty: %o', (value) => {
    vi.stubEnv('GENESIS_TEST_LIST', value)
    expect(list('GENESIS_TEST_LIST', ['https://fallback.example'])).toEqual([
      'https://fallback.example',
    ])
  })
})

describe('emulatorOverride', () => {
  it('returns the value under the emulator', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true')
    vi.stubEnv('GENESIS_TEST_OVERRIDE', 'http://127.0.0.1:5101')
    expect(emulatorOverride('GENESIS_TEST_OVERRIDE')).toBe('http://127.0.0.1:5101')
  })

  /*
   * The point of the whole mechanism. These names appear in no `.env` file, and
   * a deploy must not be able to reach them however the environment is set —
   * `HL_TEST_API_BASE` outside the emulator would point the live proxy at a fake.
   */
  it('is undefined outside the emulator, however the variable is set', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', undefined)
    vi.stubEnv('GENESIS_TEST_OVERRIDE', 'http://127.0.0.1:5101')
    expect(emulatorOverride('GENESIS_TEST_OVERRIDE')).toBeUndefined()
  })

  it.each([undefined, '', '   '])('is undefined for %o under the emulator', (value) => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true')
    vi.stubEnv('GENESIS_TEST_OVERRIDE', value)
    expect(emulatorOverride('GENESIS_TEST_OVERRIDE')).toBeUndefined()
  })
})

describe('emulatorNumber', () => {
  it('returns the override under the emulator', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true')
    vi.stubEnv('GENESIS_TEST_MS', '250')
    expect(emulatorNumber('GENESIS_TEST_MS', 15_000)).toBe(250)
  })

  /* No deploy may shorten a real timeout, which is the reason for the gate. */
  it('returns the fallback outside the emulator', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', undefined)
    vi.stubEnv('GENESIS_TEST_MS', '250')
    expect(emulatorNumber('GENESIS_TEST_MS', 15_000)).toBe(15_000)
  })

  /*
   * Zero and negative are rejected rather than honoured: a keep-alive of 0 ms is
   * a busy loop and a timeout of -1 aborts before it starts, so a fat-fingered
   * value has to degrade to the default rather than to a hang.
   */
  it.each(['0', '-1', 'soon', '', undefined, 'NaN', 'Infinity'])('falls back for %o', (value) => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true')
    vi.stubEnv('GENESIS_TEST_MS', value)
    expect(emulatorNumber('GENESIS_TEST_MS', 15_000)).toBe(15_000)
  })
})

describe('emulatorFlag', () => {
  /*
   * The switch that lets a *human* dev session reach the real model while every
   * automated suite keeps the fake. It is built on `emulatorOverride` for that
   * primitive's reason: the name appears in no `.env` file, so a shell value
   * survives the emulator's own precedence, and no deploy can reach it however
   * its environment is set.
   */
  it.each(['1', 'true', 'TRUE', 'True'])('is true for %o under the emulator', (value) => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true')
    vi.stubEnv('GENESIS_TEST_FLAG', value)
    expect(emulatorFlag('GENESIS_TEST_FLAG')).toBe(true)
  })

  /*
   * `0` and `no` are the shapes somebody writes when they mean *off*, and a
   * presence check would read every one of them as on. That is the whole reason
   * this is not `emulatorOverride(name) !== undefined` at the call site.
   */
  it.each([undefined, '', '   ', '0', 'no', 'false', 'yes'])(
    'is false for %o under the emulator',
    (value) => {
      vi.stubEnv('FUNCTIONS_EMULATOR', 'true')
      vi.stubEnv('GENESIS_TEST_FLAG', value)
      expect(emulatorFlag('GENESIS_TEST_FLAG')).toBe(false)
    },
  )

  it('is false outside the emulator, however the variable is set', () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', undefined)
    vi.stubEnv('GENESIS_TEST_FLAG', 'true')
    expect(emulatorFlag('GENESIS_TEST_FLAG')).toBe(false)
  })
})
