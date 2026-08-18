import { describe, expect, it } from 'vitest'

import { encodeSse, encodeSseComment } from './sse'

describe('encodeSse', () => {
  it('emits a well-formed frame terminated by a blank line', () => {
    expect(encodeSse('token', { text: 'hi' })).toBe('event: token\ndata: {"text":"hi"}\n\n')
  })

  it('keeps a payload containing newlines on a single data line', () => {
    // A raw newline here would terminate the frame early and desync the client.
    const frame = encodeSse('token', { text: 'line one\nline two' })

    const body = frame.slice(0, -2)
    expect(body.split('\n')).toHaveLength(2)
    expect(frame).toContain('\\n')
  })

  it('round-trips through the parsing a browser would do', () => {
    const frame = encodeSse('file_start', { path: 'src/app.js' })
    // Defaulted rather than asserted: noUncheckedIndexedAccess is right that a
    // split can come up short, and an empty string fails the parse below anyway.
    const [eventLine, dataLine = ''] = frame.trimEnd().split('\n')

    expect(eventLine).toBe('event: file_start')
    expect(JSON.parse(dataLine.replace(/^data: /, ''))).toEqual({ path: 'src/app.js' })
  })
})

/**
 * One frame type per destination, and `file_chunk` is what keeps `token` honest: reusing `token`
 * between the boundaries would make its meaning depend on a mode the client has to track, and a
 * client that dropped a `file_start` would then route code into the chat bubble.
 */
describe('the file frames', () => {
  it.each(['file_start', 'file_chunk', 'file_end'] as const)('encodes %s', (name) => {
    expect(encodeSse(name, { path: 'app.js' })).toBe(`event: ${name}\ndata: {"path":"app.js"}\n\n`)
  })

  /* Every frame repeats the path, so it is self-describing. */
  it('keeps a chunk of code on one data line, path included', () => {
    const frame = encodeSse('file_chunk', { path: 'app.js', text: 'const a = 1\nconst b = 2\n' })

    expect(frame.slice(0, -2).split('\n')).toHaveLength(2)
    expect(frame).toContain('"path":"app.js"')
  })
})

describe('encodeSseComment', () => {
  it('emits a comment frame that carries no event', () => {
    expect(encodeSseComment()).toBe(': keep-alive\n\n')
  })
})
