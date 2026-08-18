import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildParams } from './params'
import type { ProjectFile } from './projectState'
import { SYSTEM_PROMPT } from './prompt'
import { mapStream, MAX_OUTPUT_BYTES, type LlmEvent } from './stream'
import { buildFakeStream } from './fake'

/**
 * The fake model, and the one thing about it that must never regress.
 *
 * It replaces the model with a script. Deployed, that is not a test double — it is an endpoint
 * that charges nothing and answers nothing, and a user would never know. So the gate is not a
 * config flag or an env var of our own but `FUNCTIONS_EMULATOR`, the one signal an operator
 * cannot set by mistake and a deploy cannot carry — `buildFakeHlRouter`'s exact argument, one
 * slice on.
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

/**
 * The bytes between one block's delimiters — what the writer would store for that
 * path, and so the only thing a "these two turns differ" claim can be about.
 */
const block = (reply: string, path: string): string => {
  const open = `<genesis:file path="${path}">\n`
  const at = reply.indexOf(open)
  if (at === -1) throw new Error(`the reply has no block for ${path}`)
  const start = at + open.length
  const end = reply.indexOf('\n</genesis:file>', start)
  if (end === -1) throw new Error(`the block for ${path} never closes`)
  return reply.slice(start, end)
}

beforeEach(() => {
  process.env['FUNCTIONS_EMULATOR'] = 'true'
})

afterEach(() => {
  if (REAL === undefined) delete process.env['FUNCTIONS_EMULATOR']
  else process.env['FUNCTIONS_EMULATOR'] = REAL
})

describe('the gate', () => {
  /*
   * `hl/fake.spec.ts`'s case, one slice on. The reasoning is identical and the consequence is
   * worse: the HighLevel fake mints tokens, this one replaces the product.
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

  /*
   * D26's four malformed cases. They are fixtures rather than L1-only inputs
   * because F8.1 is a *user-facing* requirement: the error has to be provable
   * over the wire, and an L1 test of `validateFileOps` asserts intent where what
   * F8.1 needs is the assertion that no document exists.
   */
  it('replies with prose and no file block at all for __no_files', async () => {
    const events = await run('__no_files what can you build')

    expect(terminal(events)).toMatchObject({ kind: 'end', truncated: false })
    expect(text(events)).not.toContain('<genesis:file')
    expect(text(events)).toContain('CRM connection')
  })

  it('writes a path we cannot store for __bad_path', async () => {
    expect(text(await run('__bad_path build a contact dashboard'))).toContain(
      '<genesis:file path="../secrets.js">',
    )
  })

  it('leaves its last block open for __unterminated', async () => {
    const reply = text(await run('__unterminated build a contact dashboard'))

    expect(reply).toContain('<genesis:file path="index.html">')
    expect(reply).not.toContain('</genesis:file>')
  })

  it('writes one path twice for __dup_files', async () => {
    const reply = text(await run('__dup_files build a contact dashboard'))

    expect(reply.split('<genesis:file path="app.js">')).toHaveLength(3)
  })

  it('replays the ordinary reply for __slow, just later', async () => {
    const events = await run('__slow build a contact dashboard')

    expect(terminal(events)).toMatchObject({ kind: 'end', truncated: false })
    expect(text(events)).toContain('Here is a contact dashboard.')
  })
})

/**
 * `reply.json` is the fixture five other suites already depend on (R8).
 *
 * D26 keeps its **prose byte-for-byte** and appends the file blocks, so Slice 5's
 * assertions — progressive text, `truncated`, the accumulated content — are about
 * text that has not moved. This pins that promise rather than trusting it: the
 * five recorded prose deltas are written out here, so a future edit that
 * "tidies" them fails in one obvious place instead of in five suites at once.
 */
describe('the default fixture keeps its prose and grows files', () => {
  const PROSE = [
    'Here is a contact dashboard. ',
    'It lists everyone in your account, ',
    'newest first, with a search box above the list. ',
    "Clicking a row opens that contact's details. ",
    'Every value is read from your CRM account.',
  ]

  it('opens with the five recorded prose deltas, unchanged', async () => {
    const events = await run('build a contact dashboard')
    const spoken = events.filter((event) => event.kind === 'token').map((event) => event.text)

    expect(spoken.slice(0, PROSE.length)).toEqual(PROSE)
  })

  it('goes on to write three files', async () => {
    const reply = text(await run('build a contact dashboard'))

    for (const path of ['index.html', 'styles.css', 'app.js']) {
      expect(reply).toContain(`<genesis:file path="${path}">`)
    }
    expect(reply.split('</genesis:file>')).toHaveLength(4)
  })

  /*
   * The block text is split across several deltas per file, so the streamed path
   * is exercised rather than delivered whole — which is what makes the frame
   * ordering in `generate-files.spec.ts` a real assertion.
   */
  it('splits each block across several deltas', async () => {
    const events = await run('build a contact dashboard')

    expect(events.filter((event) => event.kind === 'token').length).toBeGreaterThan(15)
  })

  /** P6, AC-22: `max-tokens.json` now has an opened block to be cut short in. */
  it('cuts __max_tokens short inside an open block', async () => {
    const reply = text(await run('__max_tokens write me an epic'))

    expect(reply).toContain('<genesis:file path="index.html">')
    expect(reply).not.toContain('</genesis:file>')
  })
})

/**
 * `__alt_files` is Slice 11's second turn.
 *
 * A restore is only observable if two turns leave the project in *different* states, and a fake
 * that replayed `reply.json` every time would make a restore that did nothing indistinguishable
 * from one that worked. So the alternate fixture rewrites `index.html`, adds `about.html`, and —
 * just as deliberately — leaves `styles.css` and `app.js` alone, so the snapshot the second turn
 * takes holds four files of which two were carried over untouched.
 */
describe('the alternate file set', () => {
  /* That the marker is recognised at all — i.e. that it is in `MARKERS` and that
   * its `planFor` case reaches `reply-alt.json` — is exactly what replaying prose
   * the default fixture does not contain proves. */
  it('replays reply-alt.json for __alt_files', async () => {
    const events = await run('__alt_files add an about page')

    expect(terminal(events)).toMatchObject({ kind: 'end', truncated: false })
    expect(text(events)).toContain('Here is the about page you asked for.')
  })

  it('adds about.html', async () => {
    const reply = text(await run('__alt_files add an about page'))

    expect(reply).toContain('<genesis:file path="about.html">')
  })

  it('rewrites index.html to something the default reply never wrote', async () => {
    const second = text(await run('__alt_files add an about page'))
    const first = text(await run('build a contact dashboard'))

    expect(block(second, 'index.html')).not.toBe(block(first, 'index.html'))
  })

  /*
   * Exactly two paths, because the integration test counts: `reply.json`'s three
   * files plus `about.html` is four, and a third path here would move that count
   * for a reason that has nothing to do with snapshots.
   */
  it('writes index.html and about.html and nothing else', async () => {
    const reply = text(await run('__alt_files add an about page'))

    expect(reply.split('</genesis:file>')).toHaveLength(3)
    for (const path of ['styles.css', 'app.js']) {
      expect(reply).not.toContain(`<genesis:file path="${path}">`)
    }
  })
})

describe('where the marker is read', () => {
  /* The **last user message**, because that is the prompt the user just sent. */
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

/**
 * `__context` — how an integration test sees **what was actually sent**.
 *
 * Without it, budget trimming is provable only at L1 and the wiring between `handleGenerate`,
 * the file read and `buildParams` is proven by nothing at all: the three could be connected to
 * each other in any order, or not at all, and every existing test would still pass. So the fake
 * reports the shape of its own input back down the stream, and an L4 test reads it out of a real
 * SSE response.
 */
describe('the __context marker', () => {
  const FILES: readonly ProjectFile[] = [
    { path: 'index.html', content: '<!doctype html>\n<h1>Contacts</h1>\n' },
    { path: 'app.js', content: 'const a = 1\n' },
  ]

  async function reported(files: readonly ProjectFile[]): Promise<Record<string, unknown>> {
    const params = buildParams(context('__context build me something'), files)
    const events: LlmEvent[] = []
    for await (const event of mapStream(await buildFakeStream(params))) events.push(event)
    return JSON.parse(text(events)) as Record<string, unknown>
  }

  it('reports the block count, the message count and the paths it was shown', async () => {
    const seen = await reported(FILES)

    expect(seen['systemBlocks']).toBe(SYSTEM_PROMPT.length + 1)
    // `context()` builds user → assistant → user, and the fake counts what it got.
    expect(seen['messages']).toBe(3)
    // The builder's order, not the caller's: `index.html` first (D14).
    expect(seen['paths']).toEqual(['index.html', 'app.js'])
  })

  /* A project with no files appends no block at all (AC-13), so there is nothing
   * to read paths out of — and the count is the bare prefix. */
  it('reports the bare prefix and no paths for a project holding no files', async () => {
    const seen = await reported([])

    expect(seen['systemBlocks']).toBe(SYSTEM_PROMPT.length)
    expect(seen['paths']).toEqual([])
  })

  /* It is one text delta, so a test can `JSON.parse` the whole token stream. */
  it('answers in a single token and ends cleanly', async () => {
    const params = buildParams(context('__context'), FILES)
    const events: LlmEvent[] = []
    for await (const event of mapStream(await buildFakeStream(params))) events.push(event)

    expect(events.filter((event) => event.kind === 'token')).toHaveLength(1)
    expect(terminal(events)).toMatchObject({ kind: 'end', truncated: false })
  })

  /* The marker is only a marker when it is asked for; an ordinary prompt still
   * gets the recorded reply even with files present. */
  it('leaves an unmarked prompt on the recorded reply', async () => {
    const params = buildParams(context('build a contact dashboard'), FILES)
    const events: LlmEvent[] = []
    for await (const event of mapStream(await buildFakeStream(params))) events.push(event)

    expect(text(events)).toContain('Here is a contact dashboard.')
  })
})
