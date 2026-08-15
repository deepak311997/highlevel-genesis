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

describe('encodeSseComment', () => {
  it('emits a comment frame that carries no event', () => {
    expect(encodeSseComment()).toBe(': keep-alive\n\n')
  })
})
