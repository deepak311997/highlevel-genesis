import { EventEmitter } from 'node:events'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readProject = vi.hoisted(() => vi.fn())
const readTranscript = vi.hoisted(() => vi.fn())
const appendAssistantMessage = vi.hoisted(() => vi.fn())
const openStream = vi.hoisted(() => vi.fn())
const getDb = vi.hoisted(() => vi.fn())

/*
 * The originals are spread back in, because these modules are also reached
 * transitively: `./api` mounts both routers, so a mock that returned only the
 * three functions under test would break every route the app registers at
 * import time — a long way from anything this file is about.
 */
vi.mock('./projects/handlers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readProject,
}))
vi.mock('./messages/handlers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTranscript,
  appendAssistantMessage,
}))
vi.mock('./llm', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openStream,
}))
/*
 * The database itself, rather than `files/handlers`: `planFileWrites` calls
 * `readFilePaths` directly inside its own module, so a module mock would not be
 * seen. `planFileWrites` and `validateFileOps` are therefore the real ones —
 * what this file is about is which of them the handler reaches, and with what.
 */
vi.mock('./lib/firebase', () => ({ getDb }))

import { handleGenerate, keepAliveMs, logGeneration } from './generate'
import { HttpError } from './lib/errors'
import type { LlmStream } from './llm'
import { MESSAGE_LIMIT } from './messages/schema'

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

/**
 * A scripted `LlmStream` whose `abort()` really stops production.
 *
 * The delay is what makes a disconnect land *mid*-stream: without it the whole
 * script is delivered in one microtask turn and there is no middle to interrupt.
 */
function scriptedStream(texts: readonly string[]): LlmStream & { aborted: boolean } {
  const stream = {
    aborted: false,
    abort(): void {
      stream.aborted = true
    },
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'message_start',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as never

      for (const text of texts) {
        await new Promise((done) => setTimeout(done, 5))
        if (stream.aborted) return
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        } as never
      }

      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 20 },
      } as never
    },
  }
  return stream
}

/**
 * Just enough of an Express response to drive the handler, as an `EventEmitter`
 * so `close` can be delivered the way Node delivers it.
 */
function fakeResponse() {
  const frames: string[] = []
  let disconnectAt: number | null = null
  let tokens = 0

  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    status: () => res,
    set: () => res,
    flushHeaders: () => {
      res.headersSent = true
    },
    write: (chunk: string) => {
      frames.push(chunk)
      if (chunk.startsWith('event: token')) tokens += 1
      if (disconnectAt !== null && tokens >= disconnectAt) {
        disconnectAt = null
        // What Cloud Run does when the client goes: the socket dies, and the
        // response emits `close` while it is still writable.
        res.destroyed = true
        res.emit('close')
      }
      return true
    },
    end: () => {
      res.writableEnded = true
      res.emit('close')
      return res
    },
  })

  return {
    frames,
    express: res as unknown as Response,
    /** Disconnect once this many token frames have been written. */
    disconnectAfterTokens(count: number): void {
      disconnectAt = count
      if (count === 0) {
        res.destroyed = true
        res.emit('close')
      }
    },
  }
}

const fakeRequest = (): Request => ({ body: { projectId: 'proj-1' } }) as unknown as Request

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

/**
 * The client disconnect (D21, AC-17, AC-18) — **driven at L1, because the
 * functions emulator cannot deliver the signal.**
 *
 * This was verified rather than assumed. Instrumenting `req.on('close')`,
 * `req.on('aborted')`, `res.on('aborted')` and `res.on('close')` and then
 * aborting a real `fetch` two tokens into a `__slow` stream produces: no `req`
 * event at all, no `aborted` event at all, the generation running to completion
 * (`stopReason: 'end_turn'`, `durationMs: 1213`), and `res close` firing only
 * afterwards with `writableEnded: true`. The emulator terminates the client
 * connection at its own proxy and never propagates it to the function runtime.
 *
 * On Cloud Run the response *does* emit `close` on a premature client close,
 * which is what the handler listens for. What can be proven here is the half we
 * own: given the signal, the stream is aborted, the partial is persisted marked
 * `truncated`, and **nothing is written to the dead socket**. The other half —
 * that the platform delivers it — is a Slice 13 hand-check, alongside R2's.
 */
describe('handleGenerate — the client goes away', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    readProject.mockResolvedValue({ id: 'proj-1' })
    // The project holds no files yet, so every write is a creation.
    getDb.mockReturnValue({
      collection: () => ({
        limit: () => ({ select: () => ({ get: () => Promise.resolve({ docs: [] }) }) }),
      }),
    })
    readTranscript.mockResolvedValue([
      {
        id: 'm1',
        role: 'user',
        content: 'build a contact dashboard',
        createdAt: '',
        truncated: false,
      },
    ])
    appendAssistantMessage.mockImplementation((_uid, _projectId, content, truncated) =>
      Promise.resolve({ id: 'a1', role: 'assistant', content, createdAt: '', truncated }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /*
   * AC-17. The partial is the whole point (F8.2): a user who closed the tab
   * mid-reply comes back to what had been written, not to a prompt with no
   * answer. Aborting rather than letting it run is the other half — an orphaned
   * generation still bills.
   */
  it('aborts the stream, persists the partial as truncated, and writes no frame', async () => {
    const stream = scriptedStream(['one ', 'two ', 'three ', 'four '])
    openStream.mockResolvedValue(stream)
    const res = fakeResponse()
    // Disconnect once the client has seen two tokens, which is what a user
    // navigating away mid-reply produces.
    res.disconnectAfterTokens(2)

    await handleGenerate(fakeRequest(), res.express, 'alice')

    expect(stream.aborted).toBe(true)
    expect(appendAssistantMessage).toHaveBeenCalledTimes(1)
    /*
     * `'one two'` and not `'one two '`: from Slice 6 the collector is the single
     * producer of the chat text, and D16 trims it at both ends **in the emitted
     * stream**. The persisted content is still byte-identical to the token frames
     * the client received, which is the invariant that actually matters (D7).
     */
    expect(appendAssistantMessage.mock.calls[0]?.[2]).toBe('one two')
    expect(appendAssistantMessage.mock.calls[0]?.[3]).toBe(true)
    // Nobody is listening, so nothing is written to the dead socket.
    expect(res.frames.filter((frame) => frame.startsWith('event: done'))).toHaveLength(0)
    expect(res.frames.filter((frame) => frame.startsWith('event: error'))).toHaveLength(0)
  })

  /** AC-18. Nothing was produced, so there is nothing to preserve. */
  it('writes nothing when the disconnect arrives before any token', async () => {
    const stream = scriptedStream(['one ', 'two '])
    openStream.mockResolvedValue(stream)
    const res = fakeResponse()
    res.disconnectAfterTokens(0)

    await handleGenerate(fakeRequest(), res.express, 'alice')

    expect(stream.aborted).toBe(true)
    expect(appendAssistantMessage).not.toHaveBeenCalled()
  })

  /**
   * D10, and the one case where the message's flag and the file decision differ.
   *
   * The client left, so the message is marked `truncated`. But the stream itself
   * ended cleanly — the fake stops producing when aborted rather than throwing —
   * so the model's completed blocks are a complete app, and **the files are still
   * written**. They belong to the project, not to the connection.
   *
   * This is only assertable at L1: the functions emulator never propagates a
   * client disconnect to the function runtime (see the note above).
   */
  it('still writes the files of a turn whose blocks closed before the client left', async () => {
    const stream = scriptedStream([
      'Here it is.\n\n<genesis:file path="app.js">\nconst a = 1\n</genesis:file>\n',
      'more prose ',
      'and more ',
    ])
    openStream.mockResolvedValue(stream)
    const res = fakeResponse()
    res.disconnectAfterTokens(1)

    await handleGenerate(fakeRequest(), res.express, 'alice')

    expect(stream.aborted).toBe(true)
    const call = appendAssistantMessage.mock.calls[0] ?? []
    expect(call[2]).toBe('Here it is.\n\n[file: app.js]')
    expect(call[3]).toBe(true)
    expect(call[4]).toEqual([{ path: 'app.js', content: 'const a = 1\n', size: 12, exists: false }])
    // And still nothing on the dead socket.
    expect(res.frames.filter((frame) => frame.startsWith('event: done'))).toHaveLength(0)
  })

  /*
   * The guard that makes the other two mean anything. Node emits `close` on a
   * response that finished normally too, so without `writableEnded` every
   * successful turn would be recorded as an abandonment — and every reply in the
   * product would carry an "interrupted" marker.
   */
  it('does not treat a completed turn as an abandonment', async () => {
    openStream.mockResolvedValue(scriptedStream(['one ', 'two ']))
    const res = fakeResponse()

    await handleGenerate(fakeRequest(), res.express, 'alice')

    expect(appendAssistantMessage.mock.calls[0]?.[3]).toBe(false)
    expect(res.frames.filter((frame) => frame.startsWith('event: done'))).toHaveLength(1)
    // `close` after `end()` must change nothing.
    res.express.emit('close')
    expect(appendAssistantMessage).toHaveBeenCalledTimes(1)
  })
})

/**
 * The 200-message cap, on the endpoint that also writes into the collection.
 *
 * `POST /api/projects/:projectId/messages` refuses at 199 so the reply it is
 * about to trigger has room — but **`/generate` writes an assistant message
 * without going through that route**, and Retry re-opens it with no new user
 * message at all (D26). A transcript already at the cap therefore grows past it,
 * once per Retry, and `transcriptQuery`'s own `limit(200)` then hides every
 * document written after the two-hundredth: the reply arrives on screen, and is
 * gone on the next load. D34 leans on this cap to bound a project's spend
 * absolutely, so the endpoint that spends has to honour it too.
 */
describe('handleGenerate — the message cap', () => {
  function transcriptOf(count: number): unknown[] {
    return Array.from({ length: count }, (_unused, index) => ({
      id: `m${String(index)}`,
      // Ending on a user turn, so nothing here is D6's trailing-assistant drop.
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${String(index)}`,
      createdAt: '',
      truncated: false,
    }))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    readProject.mockResolvedValue({ id: 'proj-1' })
    openStream.mockResolvedValue(scriptedStream(['one ']))
    appendAssistantMessage.mockResolvedValue({
      id: 'a1',
      role: 'assistant',
      content: 'one ',
      createdAt: '',
      truncated: false,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refuses a transcript already at the cap, with the message route’s answer', async () => {
    readTranscript.mockResolvedValue(transcriptOf(MESSAGE_LIMIT))

    await expect(handleGenerate(fakeRequest(), fakeResponse().express, 'alice')).rejects.toThrow(
      HttpError,
    )
  })

  it('refuses with 409 message_limit, before the LLM is called or anything written', async () => {
    readTranscript.mockResolvedValue(transcriptOf(MESSAGE_LIMIT))

    const err = await handleGenerate(fakeRequest(), fakeResponse().express, 'alice').catch(
      (thrown: unknown) => thrown,
    )

    expect(err).toMatchObject({ status: 409, code: 'message_limit' })
    expect((err as HttpError).message).toBe(
      `This project has reached its limit of ${String(MESSAGE_LIMIT)} messages.`,
    )
    // The refusal is cheap and it is a JSON one: it happens before `flushHeaders`,
    // so it still gets a real status line rather than an `error` frame (D9).
    expect(openStream).not.toHaveBeenCalled()
    expect(appendAssistantMessage).not.toHaveBeenCalled()
  })

  /* The boundary: one short of the cap is exactly the turn the cap leaves room for. */
  it('generates from a transcript one message short of the cap', async () => {
    readTranscript.mockResolvedValue(transcriptOf(MESSAGE_LIMIT - 1))

    await handleGenerate(fakeRequest(), fakeResponse().express, 'alice')

    expect(openStream).toHaveBeenCalledTimes(1)
    expect(appendAssistantMessage).toHaveBeenCalledTimes(1)
  })
})
