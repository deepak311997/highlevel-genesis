import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mapStream, MAX_OUTPUT_BYTES, type LlmEvent } from './stream'
import { buildFakeStream } from './fake'

/**
 * The fake model, and the one thing about it that must never regress.
 *
 * It replaces the model with a script. Deployed, that is not a test double — it
 * is an endpoint that charges nothing and answers nothing, and a user would
 * never know. So the gate is not a config flag or an env var of our own but
 * `FUNCTIONS_EMULATOR`, the one signal an operator cannot set by mistake and a
 * deploy cannot carry — `buildFakeHlRouter`'s exact argument, one slice on (D20).
 *
 * The gate is checked **inside** `buildFakeStream`, not only at the call site, so
 * a stray import cannot reach around it.
 *
 * Behaviour is selected by a marker in the last user message rather than by a
 * control API, which keeps the intent on the page in the test that uses it —
 * `prompt('__fail_midstream')` — and needs no second endpoint to configure.
 */

const REAL = process.env['FUNCTIONS_EMULATOR']

/** A context ending in one user turn, which is all `buildContext` ever produces. */
function context(prompt: string): MessageParam[] {
  return [
    { role: 'user', content: 'an earlier prompt' },
    { role: 'assistant', content: 'an earlier reply' },
    { role: 'user', content: prompt },
  ]
}

async function run(prompt: string): Promise<LlmEvent[]> {
  const out: LlmEvent[] = []
  for await (const event of mapStream(await buildFakeStream({ messages: context(prompt) }))) {
    out.push(event)
  }
  return out
}

const terminal = (events: LlmEvent[]): LlmEvent => {
  const last = events.at(-1)
  if (last === undefined) throw new Error('the fake yielded nothing at all')
  return last
}

const text = (events: LlmEvent[]): string =>
  events
    .filter((event) => event.kind === 'token')
    .map((event) => event.text)
    .join('')

beforeEach(() => {
  process.env['FUNCTIONS_EMULATOR'] = 'true'
})

afterEach(() => {
  if (REAL === undefined) delete process.env['FUNCTIONS_EMULATOR']
  else process.env['FUNCTIONS_EMULATOR'] = REAL
})

describe('the gate', () => {
  /*
   * `hl/fake.spec.ts`'s case, one slice on. The reasoning is identical and the
   * consequence is worse: the HighLevel fake mints tokens, this one replaces the
   * product.
   */
  it('refuses to build a stream outside the emulator', async () => {
    delete process.env['FUNCTIONS_EMULATOR']

    await expect(buildFakeStream({ messages: context('hello') })).rejects.toThrow(/emulator/i)
  })

  it.each(['false', 'TRUE', '1', ''])(
    'refuses when FUNCTIONS_EMULATOR is %s rather than exactly "true"',
    async (value) => {
      process.env['FUNCTIONS_EMULATOR'] = value

      await expect(buildFakeStream({ messages: context('hello') })).rejects.toThrow(/emulator/i)
    },
  )
})

describe('marker selection', () => {
  /** No marker: the recorded happy reply, thinking delta and all. */
  it('replays the recorded reply for an unmarked prompt', async () => {
    const events = await run('build a contact dashboard')

    expect(terminal(events)).toMatchObject({ kind: 'end', truncated: false })
    expect(text(events)).toContain('Here is a contact dashboard.')
    // AC-11 end to end through the fixture: the recorded thinking delta is in
    // `reply.json` and must not have become a token.
    expect(text(events)).not.toContain('The user wants')
  })

  it('fails mid-stream after two text deltas for __fail_midstream', async () => {
    const events = await run('__fail_midstream build a contact dashboard')

    expect(events.filter((event) => event.kind === 'token')).toHaveLength(2)
    expect(terminal(events)).toMatchObject({ kind: 'error', code: 'upstream' })
    expect(text(events)).not.toBe('')
  })

  it('fails before any delta for __fail_upfront', async () => {
    const events = await run('__fail_upfront build a contact dashboard')

    expect(events.filter((event) => event.kind === 'token')).toHaveLength(0)
    expect(terminal(events)).toMatchObject({ kind: 'error', code: 'upstream', text: '' })
  })

  it('declines for __refuse', async () => {
    const events = await run('__refuse do something dubious')

    expect(terminal(events)).toMatchObject({ kind: 'error', code: 'refused', text: '' })
  })

  it('stops at max_tokens for __max_tokens', async () => {
    const events = await run('__max_tokens write me an epic')

    expect(terminal(events)).toMatchObject({ kind: 'end', truncated: true })
    expect(text(events)).not.toBe('')
  })

  /* The volume that makes the byte cap observable end to end. */
  it('produces more than the cap for __long', async () => {
    const events = await run('__long write me everything')

    const outcome = terminal(events)
    expect(outcome).toMatchObject({ kind: 'end', truncated: true })
    expect(Buffer.byteLength(outcome.text, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
    // Not merely at the cap by luck: the fake really did offer more than fits.
    expect(Buffer.byteLength(outcome.text, 'utf8')).toBeGreaterThan(MAX_OUTPUT_BYTES / 2)
  })

  it('replays the ordinary reply for __slow, just later', async () => {
    const events = await run('__slow build a contact dashboard')

    expect(terminal(events)).toMatchObject({ kind: 'end', truncated: false })
    expect(text(events)).toContain('Here is a contact dashboard.')
  })
})

describe('where the marker is read', () => {
  /*
   * The **last user message**, because that is the prompt the user just sent.
   * Reading the whole conversation would make one `__refuse` poison every
   * subsequent turn of that project, which is precisely the shape a Retry test
   * needs not to happen.
   */
  it('ignores a marker in an earlier turn', async () => {
    const messages: MessageParam[] = [
      { role: 'user', content: '__refuse an old prompt' },
      { role: 'assistant', content: 'an old reply' },
      { role: 'user', content: 'build a contact dashboard' },
    ]

    const out: LlmEvent[] = []
    for await (const event of mapStream(await buildFakeStream({ messages }))) out.push(event)

    expect(terminal(out)).toMatchObject({ kind: 'end', truncated: false })
  })

  it('finds a marker anywhere in the last user message', async () => {
    const events = await run('please __refuse this one')

    expect(terminal(events)).toMatchObject({ kind: 'error', code: 'refused' })
  })

  /* An empty context never reaches here — the handler answers 400 first — but the
   * fake must not throw a different error if it ever does. */
  it('replays the ordinary reply when there is no user message at all', async () => {
    const out: LlmEvent[] = []
    for await (const event of mapStream(await buildFakeStream({ messages: [] }))) out.push(event)

    expect(terminal(out)).toMatchObject({ kind: 'end' })
  })
})

describe('abort', () => {
  /* The handler aborts on a client disconnect, and the mapper aborts at the cap.
   * A fake that ignored it would make both look like they worked. */
  it('stops producing events once aborted', async () => {
    const stream = await buildFakeStream({ messages: context('__long everything') })

    const seen: LlmEvent[] = []
    for await (const event of mapStream(stream)) {
      seen.push(event)
      if (seen.length === 2) stream.abort()
    }

    expect(seen.length).toBeLessThan(10)
  })
})
