import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ANTHROPIC_API_KEY, openStream } from './client'

/**
 * Which stream `openStream` opens, and what happens when the key is missing.
 *
 * The real branch cannot be exercised here — it would call Anthropic, which the
 * testing rule forbids in every automated test — so what is asserted is the two
 * things that decide *whether* it is taken: the emulator gate, and the explicit
 * key check in front of it.
 *
 * The key check is worth a test because of how it fails otherwise.
 * `SecretParam.value()` answers `''` for a secret the function was not granted,
 * with only a `warn` in the log, so a missing binding would surface as an opaque
 * 401 from Anthropic on every request — a long way from the deploy that forgot
 * it. Answering with a message that names the secret and the command that sets
 * it turns half an hour into a minute.
 */

const REAL_EMULATOR = process.env['FUNCTIONS_EMULATOR']
const REAL_KEY = process.env['ANTHROPIC_API_KEY']

const PARAMS = {
  model: 'claude-opus-5',
  max_tokens: 64_000,
  messages: [{ role: 'user' as const, content: 'build a contact dashboard' }],
}

/** Narrow, so `delete` names a literal key rather than a computed one. */
function restore(
  name: 'FUNCTIONS_EMULATOR' | 'ANTHROPIC_API_KEY',
  value: string | undefined,
): void {
  if (value !== undefined) {
    process.env[name] = value
    return
  }
  // Literal keys in brackets: `noPropertyAccessFromIndexSignature` requires the
  // brackets, and `no-dynamic-delete` requires the literal.
  if (name === 'FUNCTIONS_EMULATOR') delete process.env['FUNCTIONS_EMULATOR']
  else delete process.env['ANTHROPIC_API_KEY']
}

beforeEach(() => {
  // `SecretParam.value()` logs a warning for an unset secret, which is correct
  // behaviour and noise in a suite that is asserting on exactly that case.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  restore('FUNCTIONS_EMULATOR', REAL_EMULATOR)
  restore('ANTHROPIC_API_KEY', REAL_KEY)
  vi.restoreAllMocks()
})

describe('openStream', () => {
  /* D20. The gate is `isEmulator()` and nothing else — no config value, no flag
   * of our own that a deploy could carry. */
  it('takes the fake path under the emulator, without a key', async () => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'
    delete process.env['ANTHROPIC_API_KEY']

    const stream = await openStream(PARAMS)

    expect(typeof stream.abort).toBe('function')
    expect(typeof stream[Symbol.asyncIterator]).toBe('function')
  })

  it('refuses with a message naming the secret when there is no key', async () => {
    delete process.env['FUNCTIONS_EMULATOR']
    delete process.env['ANTHROPIC_API_KEY']

    await expect(openStream(PARAMS)).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  /* A key of spaces is a key somebody pasted wrong, not a key. */
  it('treats a blank key as missing', async () => {
    delete process.env['FUNCTIONS_EMULATOR']
    process.env['ANTHROPIC_API_KEY'] = '   '

    await expect(openStream(PARAMS)).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  it('names the command that sets it, not just the variable', async () => {
    delete process.env['FUNCTIONS_EMULATOR']
    delete process.env['ANTHROPIC_API_KEY']

    await expect(openStream(PARAMS)).rejects.toThrow(/functions:secrets:set/)
  })
})

describe('ANTHROPIC_API_KEY', () => {
  /*
   * Declared with `defineSecret` rather than read from `functions/.env` (D19):
   * everything in that file is uploaded as a plain environment variable on the
   * Cloud Run service and is readable by anyone with Viewer on the project.
   */
  it('is a secret parameter named ANTHROPIC_API_KEY', () => {
    expect(ANTHROPIC_API_KEY.name).toBe('ANTHROPIC_API_KEY')
    // `SecretParam.type` is the static marker firebase-functions reads when it
    // builds the deployment spec; `toSpec()` is internal and untyped.
    expect((ANTHROPIC_API_KEY.constructor as { type?: string }).type).toBe('secret')
  })
})
