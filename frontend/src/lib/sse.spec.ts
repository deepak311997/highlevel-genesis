import { describe, expect, it } from 'vitest'

import { createSseParser, type SseEvent } from './sse'

/**
 * The client's SSE parser — R4, and the bug that passes every hand-written test.
 *
 * `ReadableStream` chunks have nothing whatsoever to do with frame boundaries. `event: to` /
 * `ken\ndata: …` is a perfectly ordinary thing to receive, and a naive per-chunk parser drops or
 * corrupts it — while passing every test whose fixtures happen to be whole frames, which is
 * every test somebody writes by hand.
 */

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const STREAM =
  ': keep-alive\n\n' +
  frame('token', { text: 'Here is ' }) +
  frame('token', { text: 'a contact dashboard' }) +
  frame('done', { message: { id: 'm1', role: 'assistant', truncated: false } })

const EXPECTED: SseEvent[] = [
  { event: 'token', data: { text: 'Here is ' } },
  { event: 'token', data: { text: 'a contact dashboard' } },
  { event: 'done', data: { message: { id: 'm1', role: 'assistant', truncated: false } } },
]

/** Feed a stream through the parser in the given pieces. */
function parse(chunks: readonly string[]): SseEvent[] {
  const parser = createSseParser()
  return chunks.flatMap((chunk) => parser.push(chunk))
}

describe('createSseParser — chunk boundaries', () => {
  /** AC-28's baseline: whole frames, one chunk. */
  it('parses a whole stream delivered in one chunk', () => {
    expect(parse([STREAM])).toEqual(EXPECTED)
  })

  /*
   * `Array.from` rather than a spread, which the lint rule rightly flags for splitting code
   * points: this stream is ASCII, but a helper that quietly mangled a multi-byte character would
   * make the payload case below pass for the wrong reason.
   */
  it('parses a stream delivered one character at a time', () => {
    expect(parse(Array.from(STREAM))).toEqual(EXPECTED)
  })

  /*
   * AC-28, and the case this file exists for. Every split point, not three hand-picked ones —
   * the interesting offsets are exactly the ones nobody thinks to pick.
   */
  it('produces identical events for every possible two-chunk split', () => {
    for (let at = 1; at < STREAM.length; at += 1) {
      const events = parse([STREAM.slice(0, at), STREAM.slice(at)])

      expect(events, `split at ${String(at)}`).toEqual(EXPECTED)
    }
  })

  it('produces identical events for every possible three-chunk split', () => {
    const third = Math.floor(STREAM.length / 3)
    for (let at = 1; at < STREAM.length - third; at += 1) {
      const events = parse([
        STREAM.slice(0, at),
        STREAM.slice(at, at + third),
        STREAM.slice(at + third),
      ])

      expect(events, `split at ${String(at)}`).toEqual(EXPECTED)
    }
  })

  it('yields nothing while a frame is still incomplete', () => {
    const parser = createSseParser()

    expect(parser.push('event: token\ndata: {"text":"par')).toEqual([])
    expect(parser.push('tial"}\n\n')).toEqual([{ event: 'token', data: { text: 'partial' } }])
  })

  it('yields two events when two frames arrive in one chunk', () => {
    const parser = createSseParser()

    expect(parser.push(frame('token', { text: 'a' }) + frame('token', { text: 'b' }))).toHaveLength(
      2,
    )
  })
})

describe('createSseParser — what it ignores', () => {
  /** AC-29. A comment frame is the keep-alive, and it carries nothing. */
  it('yields nothing for a comment frame', () => {
    expect(parse([': keep-alive\n\n'])).toEqual([])
  })

  /*
   * An unknown name is **returned**, not dropped: filtering is the caller's job, which is what
   * lets Slice 6 add `file_start` handling without touching this file.
   */
  it('returns an unknown event name rather than throwing', () => {
    expect(parse([frame('file_start', { path: 'src/app.js' })])).toEqual([
      { event: 'file_start', data: { path: 'src/app.js' } },
    ])
  })

  /* AC-29, and **the case that matters**: a malformed frame must not desync the parser. */
  it('drops a frame whose data will not parse, and keeps the one after it', () => {
    const events = parse([
      frame('token', { text: 'before' }) +
        'event: token\ndata: {not json at all\n\n' +
        frame('token', { text: 'after' }),
    ])

    expect(events).toEqual([
      { event: 'token', data: { text: 'before' } },
      { event: 'token', data: { text: 'after' } },
    ])
  })

  it('survives a bad frame split across chunks too', () => {
    const bad = 'event: token\ndata: {not json\n\n'
    const stream = frame('token', { text: 'before' }) + bad + frame('done', { message: null })

    for (let at = 1; at < stream.length; at += 1) {
      const events = parse([stream.slice(0, at), stream.slice(at)])

      expect(
        events.map((one) => one.event),
        `split at ${String(at)}`,
      ).toEqual(['token', 'done'])
    }
  })

  it('ignores a frame with data and no event name', () => {
    expect(parse(['data: {"text":"orphan"}\n\n'])).toEqual([
      { event: 'message', data: { text: 'orphan' } },
    ])
  })
})

describe('createSseParser — payloads', () => {
  /*
   * The server JSON-encodes every payload precisely so a newline inside one
   * cannot end the frame early. This is that guarantee from the reading side.
   */
  it('preserves a newline inside a payload', () => {
    expect(parse([frame('token', { text: 'line one\nline two' })])).toEqual([
      { event: 'token', data: { text: 'line one\nline two' } },
    ])
  })

  it('preserves multi-byte characters', () => {
    expect(parse([frame('token', { text: '日本語 — and an em dash' })])).toEqual([
      { event: 'token', data: { text: '日本語 — and an em dash' } },
    ])
  })

  /* Per the SSE spec, several `data:` lines in one frame join with a newline. */
  it('joins multiple data lines with a newline', () => {
    expect(parse(['event: token\ndata: {"text":\ndata: "joined"}\n\n'])).toEqual([
      { event: 'token', data: { text: 'joined' } },
    ])
  })

  it('tolerates a field with no space after the colon', () => {
    expect(parse(['event:token\ndata:{"text":"tight"}\n\n'])).toEqual([
      { event: 'token', data: { text: 'tight' } },
    ])
  })
})
