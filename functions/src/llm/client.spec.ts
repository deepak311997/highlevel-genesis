import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ANTHROPIC_API_KEY, LOCAL_REAL_LLM, openStream, PLACEHOLDER_KEY } from './client'

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
const REAL_LOCAL_LLM = process.env['GENESIS_LOCAL_REAL_LLM']

const PARAMS = {
  model: 'claude-opus-5',
  max_tokens: 64_000,
  messages: [{ role: 'user' as const, content: 'build a contact dashboard' }],
}

/** Narrow, so `delete` names a literal key rather than a computed one. */
function restore(
  name: 'FUNCTIONS_EMULATOR' | 'ANTHROPIC_API_KEY' | 'GENESIS_LOCAL_REAL_LLM',
  value: string | undefined,
): void {
  if (value !== undefined) {
    process.env[name] = value
    return
  }
  // Literal keys in brackets: `noPropertyAccessFromIndexSignature` requires the
  // brackets, and `no-dynamic-delete` requires the literal.
  if (name === 'FUNCTIONS_EMULATOR') delete process.env['FUNCTIONS_EMULATOR']
  else if (name === 'ANTHROPIC_API_KEY') delete process.env['ANTHROPIC_API_KEY']
  else delete process.env['GENESIS_LOCAL_REAL_LLM']
}

beforeEach(() => {
  // `SecretParam.value()` logs a warning for an unset secret, which is correct
  // behaviour and noise in a suite that is asserting on exactly that case.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  // Every existing case predates the opt-in and assumes it is off. Cleared here
  // rather than in each test, so a developer who exports it in their own shell
  // does not turn this suite green for the wrong reason.
  delete process.env['GENESIS_LOCAL_REAL_LLM']
})

afterEach(() => {
  restore('FUNCTIONS_EMULATOR', REAL_EMULATOR)
  restore('ANTHROPIC_API_KEY', REAL_KEY)
  restore('GENESIS_LOCAL_REAL_LLM', REAL_LOCAL_LLM)
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

describe('openStream — the local real-model opt-in', () => {
  /*
   * The whole point of the switch: under the emulator, with it on, the fake is
   * *not* taken. The real branch cannot be exercised here — it would call
   * Anthropic, which the testing rule forbids — so the assertion is that control
   * reaches the key check in front of it, which with no key is a refusal naming
   * the secret. A fake stream would have resolved instead.
   */
  it('skips the fake under the emulator when the opt-in is on', async () => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'
    process.env[LOCAL_REAL_LLM] = '1'
    delete process.env['ANTHROPIC_API_KEY']

    await expect(openStream(PARAMS)).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  /*
   * The default is what every automated suite runs under, and it must stay the
   * fake however the rest of the environment looks — CLAUDE.md's "the LLM is
   * always stubbed in automated tests" is this assertion.
   */
  it.each([undefined, '0', 'false'])('keeps the fake when the opt-in is %o', async (value) => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'
    if (value === undefined) delete process.env['GENESIS_LOCAL_REAL_LLM']
    else process.env[LOCAL_REAL_LLM] = value
    delete process.env['ANTHROPIC_API_KEY']

    const stream = await openStream(PARAMS)

    expect(typeof stream.abort).toBe('function')
  })

  /*
   * D20 survives the new switch. `emulatorFlag` is honoured only under
   * FUNCTIONS_EMULATOR, so a deployed build with this variable set behaves
   * exactly as it did before — which is the property that made a flag of our own
   * acceptable here at all.
   */
  it('changes nothing outside the emulator', async () => {
    delete process.env['FUNCTIONS_EMULATOR']
    process.env[LOCAL_REAL_LLM] = '1'
    delete process.env['ANTHROPIC_API_KEY']

    await expect(openStream(PARAMS)).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  /*
   * The failure this switch would otherwise create. `.secret.local` ships from
   * its committed example carrying a placeholder, so the first thing a developer
   * who flips the switch has is a non-blank key that Anthropic answers 401 to —
   * an opaque mid-stream failure a long way from the file that caused it.
   */
  it('refuses the shipped placeholder by name', async () => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'
    process.env[LOCAL_REAL_LLM] = '1'
    process.env['ANTHROPIC_API_KEY'] = PLACEHOLDER_KEY

    await expect(openStream(PARAMS)).rejects.toThrow(/\.secret\.local/)
  })

  it('says the placeholder is a placeholder, not that the key is missing', async () => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'
    process.env[LOCAL_REAL_LLM] = '1'
    process.env['ANTHROPIC_API_KEY'] = PLACEHOLDER_KEY

    await expect(openStream(PARAMS)).rejects.toThrow(/placeholder/i)
  })
})

describe('PLACEHOLDER_KEY', () => {
  /*
   * A regression guard, not an argument. The constant is only useful while it
   * equals what `functions/.secret.local.example` actually ships — and the two
   * live in different files, in different languages, edited for different
   * reasons. Drift would be silent: the refusal simply stops firing, and the
   * placeholder goes to Anthropic as a key again, which is the exact 401 this
   * whole check exists to prevent.
   */
  it('is the value functions/.secret.local.example ships', () => {
    const example = readFileSync(
      resolve(__dirname, '..', '..', '.secret.local.example'),
      'utf8',
    )
    const assigned = /^ANTHROPIC_API_KEY=(.*)$/m.exec(example)?.[1]?.trim()

    expect(assigned).toBe(PLACEHOLDER_KEY)
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
