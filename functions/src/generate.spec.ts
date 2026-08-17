import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { keepAliveMs, logGeneration } from './generate'

/**
 * The two pieces of `/generate` that are pure enough to test without an emulator.
 *
 * `logGeneration` is the whole of F3.4 for this slice (D25) and the one place a
 * message could leak into a log sink, so its contents are asserted rather than
 * trusted — including the negative, which is the assertion that matters: **the
 * reply's text appears nowhere in the line.** A message is the user's own prose
 * and, from here on, the model's; a log sink is a disclosure channel like any
 * other.
 *
 * `keepAliveMs` is `hl/config.ts`'s `emulatorOverride` pattern, and it has a test
 * for the same reason that one does: the override must be honoured **only** under
 * the emulator, or a deployed function's keep-alive interval becomes settable by
 * whoever can set an environment variable.
 */

const OUTCOME = {
  model: 'claude-opus-5',
  stopReason: 'end_turn',
  truncated: false,
  durationMs: 4210,
  inputTokens: 214,
  outputTokens: 638,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 11,
}

const REAL_EMULATOR = process.env['FUNCTIONS_EMULATOR']
const REAL_OVERRIDE = process.env['GENERATE_TEST_KEEPALIVE_MS']

describe('logGeneration', () => {
  let info: ReturnType<typeof vi.fn>

  beforeEach(() => {
    info = vi.fn()
    vi.stubGlobal('console', { ...console, info, error: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** AC-5. One line per turn, on every path. */
  it('emits exactly one console.info line, parseable as JSON', () => {
    logGeneration(OUTCOME)

    expect(info).toHaveBeenCalledTimes(1)
    expect(() => {
      JSON.parse(String(info.mock.calls[0]?.[0]))
    }).not.toThrow()
  })

  it('names the event generation.complete', () => {
    logGeneration(OUTCOME)

    const line = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(line['event']).toBe('generation.complete')
  })

  /*
   * The model, the stop reason and all four token counts.
   * `cacheReadInputTokens` is the one worth naming: it is how D16's declared
   * no-op becomes observable in production once Slice 9 makes caching real, and
   * a reviewer reading `0` today should be reading a fact rather than a bug.
   */
  it.each([
    ['model', 'claude-opus-5'],
    ['stopReason', 'end_turn'],
    ['truncated', false],
    ['inputTokens', 214],
    ['outputTokens', 638],
    ['cacheCreationInputTokens', 0],
    ['cacheReadInputTokens', 11],
  ])('carries %s', (key, value) => {
    logGeneration(OUTCOME)

    const line = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(line[key]).toEqual(value)
  })

  it('carries how long the turn took', () => {
    logGeneration(OUTCOME)

    const line = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(line['durationMs']).toBe(4210)
  })

  /*
   * **The assertion that matters.** The reply is the user's prompt answered, and
   * the transcript is the LLM's context, so putting either in Cloud Logging
   * would make the log sink a copy of every conversation on the platform.
   *
   * The context is built from an `LlmEvent`, which *carries* the reply's `text` —
   * one `...event` spread at the call site is all it would take. So the field
   * list is projected rather than passed through, and this case forces an extra
   * key in at runtime to prove the projection is real rather than relying on the
   * type alone.
   */
  it('puts no part of the reply in the line, even when handed one', () => {
    const secret = 'the reply text nobody should ever find in a log'

    logGeneration({ ...OUTCOME, text: secret } as never)

    expect(String(info.mock.calls[0]?.[0])).not.toContain(secret)
    expect(Object.keys(JSON.parse(String(info.mock.calls[0]?.[0])) as object).sort()).toEqual([
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'durationMs',
      'event',
      'inputTokens',
      'model',
      'outputTokens',
      'stopReason',
      'truncated',
    ])
  })
})

describe('keepAliveMs', () => {
  afterEach(() => {
    if (REAL_EMULATOR === undefined) delete process.env['FUNCTIONS_EMULATOR']
    else process.env['FUNCTIONS_EMULATOR'] = REAL_EMULATOR
    if (REAL_OVERRIDE === undefined) delete process.env['GENERATE_TEST_KEEPALIVE_MS']
    else process.env['GENERATE_TEST_KEEPALIVE_MS'] = REAL_OVERRIDE
  })

  /** D28. Fifteen seconds, which is well inside what an intermediary tolerates. */
  it('is 15 seconds by default', () => {
    delete process.env['FUNCTIONS_EMULATOR']
    delete process.env['GENERATE_TEST_KEEPALIVE_MS']

    expect(keepAliveMs()).toBe(15_000)
  })

  it('honours the override under the emulator', () => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'
    process.env['GENERATE_TEST_KEEPALIVE_MS'] = '250'

    expect(keepAliveMs()).toBe(250)
  })

  /*
   * The point of the pattern. Deployed, the interval is not settable by anyone
   * who can set an environment variable — the same reasoning `hl/config.ts`'s
   * `emulatorOverride` records, and the same reasoning that gates the fake.
   */
  it('ignores the override when not under the emulator', () => {
    delete process.env['FUNCTIONS_EMULATOR']
    process.env['GENERATE_TEST_KEEPALIVE_MS'] = '250'

    expect(keepAliveMs()).toBe(15_000)
  })

  it.each(['', 'soon', '0', '-5'])('falls back to the default for the override %s', (value) => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'
    process.env['GENERATE_TEST_KEEPALIVE_MS'] = value

    expect(keepAliveMs()).toBe(15_000)
  })
})
