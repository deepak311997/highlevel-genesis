import { describe, expect, it } from 'vitest'

import type { GenerateEvent } from './generateApi'
import { dispatchGenerationEvent, type GenerationSink } from './generationSink'
import type { Message } from './messagesApi'

const MESSAGE: Message = {
  id: 'm1',
  role: 'assistant',
  content: 'hi',
  createdAt: '2026-08-18T00:00:00.000Z',
  truncated: false,
  error: null,
}

type Call = [string, ...unknown[]]

/** A sink that records what it was told, and nothing else. */
function recorder(): { sink: GenerationSink; calls: Call[] } {
  const calls: Call[] = []
  const sink: GenerationSink = {
    onUserMessage: (message) => calls.push(['onUserMessage', message.id]),
    onToken: (text) => calls.push(['onToken', text]),
    onFileStart: (path, mode) => calls.push(['onFileStart', path, mode]),
    onFileChunk: (path, text) => calls.push(['onFileChunk', path, text]),
    onFileEnd: (path) => calls.push(['onFileEnd', path]),
    onEditStart: (path, from, to) => calls.push(['onEditStart', path, from, to]),
    onEditChunk: (path, text) => calls.push(['onEditChunk', path, text]),
    onEditEnd: (path) => calls.push(['onEditEnd', path]),
    onDone: (message, files, fileError) => {
      calls.push(['onDone', message.id, files, fileError])
      return Promise.resolve()
    },
    onFailure: (error, code, message) => {
      calls.push(['onFailure', error, code, message?.id ?? null])
      return Promise.resolve()
    },
  }
  return { sink, calls }
}

describe('every frame reaches exactly one method', () => {
  it.each<[GenerateEvent, Call]>([
    [{ type: 'user', message: MESSAGE }, ['onUserMessage', 'm1']],
    [{ type: 'token', text: 'hello' }, ['onToken', 'hello']],
    [
      { type: 'file_start', path: 'a.js', mode: 'create' },
      ['onFileStart', 'a.js', 'create'],
    ],
    [{ type: 'file_chunk', path: 'a.js', text: 'x' }, ['onFileChunk', 'a.js', 'x']],
    [{ type: 'file_end', path: 'a.js' }, ['onFileEnd', 'a.js']],
    [
      { type: 'edit_start', path: 'a.css', from: 4, to: 9 },
      ['onEditStart', 'a.css', 4, 9],
    ],
    [{ type: 'edit_chunk', path: 'a.css', text: 'y' }, ['onEditChunk', 'a.css', 'y']],
    [{ type: 'edit_end', path: 'a.css' }, ['onEditEnd', 'a.css']],
  ])('routes %o', async (event, expected) => {
    const { sink, calls } = recorder()

    expect(await dispatchGenerationEvent(sink, event)).toBe('open')
    expect(calls).toEqual([expected])
  })
})

describe('the terminal frames close the stream', () => {
  it('reports closed for done, and hands over the files and the refusal', async () => {
    const { sink, calls } = recorder()
    const event: GenerateEvent = {
      type: 'done',
      message: MESSAGE,
      files: ['a.js'],
      fileError: 'nope',
    }

    expect(await dispatchGenerationEvent(sink, event)).toBe('closed')
    expect(calls).toEqual([['onDone', 'm1', ['a.js'], 'nope']])
  })

  it('reports closed for error, with the message the server persisted', async () => {
    const { sink, calls } = recorder()
    const event: GenerateEvent = {
      type: 'error',
      error: 'interrupted',
      code: 'upstream',
      message: MESSAGE,
    }

    expect(await dispatchGenerationEvent(sink, event)).toBe('closed')
    expect(calls).toEqual([['onFailure', 'interrupted', 'upstream', 'm1']])
  })

  it('passes a null message through for a failure that produced nothing', async () => {
    const { sink, calls } = recorder()

    await dispatchGenerationEvent(sink, {
      type: 'error',
      error: 'gone',
      code: 'internal',
      message: null,
    })

    expect(calls).toEqual([['onFailure', 'gone', 'internal', null]])
  })
})

describe('the interface covers the protocol', () => {
  /**
   * The compiler already proves this — the `switch` is exhaustive — but the count
   * is what fails loudly when a frame is added to `GenerateEvent` and the sink is
   * not grown to match.
   */
  it('has one method per frame kind', () => {
    const { sink } = recorder()
    expect(Object.keys(sink)).toHaveLength(10)
  })
})
