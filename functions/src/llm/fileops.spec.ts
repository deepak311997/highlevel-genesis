import { describe, expect, it } from 'vitest'

import { createFileCollector, type CollectorFrame, type CollectResult } from './fileops'

/**
 * The splitter and the collector — the pure boundary this slice is built on
 * (AC-1 to AC-10, D3, D4, D16).
 *
 * Everything here runs with no emulator, no network and no Firestore, which is
 * deliberate: the grammar, the hold-back and both normalisers are where an
 * off-by-one hides, and they are all pure. What is left for the handler is
 * framing and persistence.
 */

/** Drive a whole text through a collector and gather every frame it produced. */
function collect(text: string): { frames: CollectorFrame[]; result: CollectResult } {
  const collector = createFileCollector()
  const pushed = collector.push(text)
  const result = collector.finish()
  return { frames: [...pushed, ...result.frames], result }
}

const tokens = (frames: CollectorFrame[]): string =>
  frames
    .filter((frame) => frame.kind === 'token')
    .map((frame) => frame.text)
    .join('')

const kinds = (frames: CollectorFrame[]): string[] => frames.map((frame) => frame.kind)

/**
 * The frame kinds with adjacent repeats folded together.
 *
 * AC-2 writes `file_chunk+`, and it means it: how many chunks a body arrives in
 * is a function of how the model chunked it, which is exactly the thing AC-4 says
 * must not be observable. Asserting a count here would be asserting the opposite.
 */
const shape = (frames: CollectorFrame[]): string[] =>
  kinds(frames).filter((kind, index, all) => kind !== all[index - 1])

const chunksFor = (frames: CollectorFrame[], path: string): string =>
  frames
    .filter((frame) => frame.kind === 'file_chunk' && frame.path === path)
    .map((frame) => (frame.kind === 'file_chunk' ? frame.text : ''))
    .join('')

const block = (path: string, body: string): string =>
  `<genesis:file path="${path}">\n${body}</genesis:file>\n`

describe('a reply with no delimiters at all (AC-1)', () => {
  it('emits only token frames', () => {
    const { frames } = collect('Here is a contact dashboard.\nIt lists everyone.\n')

    expect(new Set(kinds(frames))).toEqual(new Set(['token']))
  })

  /*
   * D16's chat repairs, applied **in the emitted stream** rather than afterwards
   * (D7): the client's accumulated text and the server's stored copy have to be
   * the same string, so a `.trim()` before the write would break the invariant
   * invisibly, in whitespace.
   */
  it('trims both ends and collapses runs of three or more newlines to two', () => {
    const { frames, result } = collect('\n\n  Here it is.\n\n\n\nAnd that is all.\n\n')

    expect(tokens(frames)).toBe('Here it is.\n\nAnd that is all.')
    expect(result.messageText).toBe('Here it is.\n\nAnd that is all.')
  })

  it('leaves a run of exactly two newlines alone', () => {
    expect(tokens(collect('a\n\nb').frames)).toBe('a\n\nb')
  })

  it('reports no ops and nothing unterminated', () => {
    const { result } = collect('Just prose.')

    expect(result.ops).toEqual([])
    expect(result.unterminated).toBeNull()
  })

  /* A reply that is nothing but whitespace has no message in it at all. */
  it('produces an empty message for whitespace-only text', () => {
    const { frames, result } = collect('   \n\n  ')

    expect(frames).toEqual([])
    expect(result.messageText).toBe('')
  })
})

describe('prose, one block, prose (AC-2)', () => {
  const TEXT = `Here is a contact dashboard.\n\n${block('index.html', '<!doctype html>\n<h1>Contacts</h1>\n')}\nThat is all.\n`

  it('emits the frames in the documented order', () => {
    const { frames } = collect(TEXT)

    /*
     * The marker's own trailing newline is held back with the whitespace that
     * follows it (P2), so what is asserted is the **order** and the
     * **concatenation** rather than one frame's bytes. Every other clause of
     * AC-2 is asserted literally below.
     */
    expect(shape(frames)).toEqual([
      'token',
      'file_start',
      'token',
      'file_chunk',
      'file_end',
      'token',
    ])
  })

  it('puts the marker line in the chat text and no code at all', () => {
    const { frames, result } = collect(TEXT)

    expect(result.messageText).toBe(
      'Here is a contact dashboard.\n\n[file: index.html]\n\nThat is all.',
    )
    expect(tokens(frames)).toBe(result.messageText)
    expect(result.messageText).not.toContain('doctype')
  })

  /** One op, tags and their adjoining line breaks gone, exactly one trailing `\n`. */
  it('reports one op whose content is the block body', () => {
    const { result } = collect(TEXT)

    expect(result.ops).toEqual([
      { path: 'index.html', content: '<!doctype html>\n<h1>Contacts</h1>\n' },
    ])
    expect(result.unterminated).toBeNull()
  })

  it('emits file_start before any chunk and file_end after them', () => {
    const { frames } = collect(TEXT)
    const start = frames.findIndex((frame) => frame.kind === 'file_start')
    const end = frames.findIndex((frame) => frame.kind === 'file_end')
    const chunks = frames
      .map((frame, index) => (frame.kind === 'file_chunk' ? index : -1))
      .filter((index) => index >= 0)

    expect(start).toBeLessThan(Math.min(...chunks))
    expect(end).toBeGreaterThan(Math.max(...chunks))
  })

  /** AC-25's pure half: the chunks are the op, byte for byte. */
  it('emits chunks that concatenate to exactly the stored content', () => {
    const { frames, result } = collect(TEXT)

    expect(chunksFor(frames, 'index.html')).toBe(result.ops[0]?.content)
  })

  /* The marker names the file the tag named, so the transcript and the tree agree. */
  it('names the file in the marker exactly as the tag did', () => {
    const { result } = collect(block('styles.css', 'body { margin: 0 }\n'))

    expect(result.messageText).toBe('[file: styles.css]')
  })
})

describe('three blocks separated by prose (AC-3)', () => {
  const TEXT = [
    'Three files.\n\n',
    block('index.html', '<h1>Contacts</h1>\n'),
    '\nStyles next.\n\n',
    block('styles.css', 'h1 { color: red }\n'),
    '\nAnd the behaviour.\n\n',
    block('app.js', "console.log('hi')\n"),
    '\nDone.\n',
  ].join('')

  it('reports the ops in the order they were written', () => {
    const { result } = collect(TEXT)

    expect(result.ops.map((op) => op.path)).toEqual(['index.html', 'styles.css', 'app.js'])
  })

  it('gives each file exactly its own body', () => {
    const { result } = collect(TEXT)

    expect(result.ops).toEqual([
      { path: 'index.html', content: '<h1>Contacts</h1>\n' },
      { path: 'styles.css', content: 'h1 { color: red }\n' },
      { path: 'app.js', content: "console.log('hi')\n" },
    ])
  })

  /** No chunk carries another file's text. */
  it.each(['index.html', 'styles.css', 'app.js'])(
    'routes every chunk of %s to its own path',
    (path) => {
      const { frames, result } = collect(TEXT)
      const op = result.ops.find((entry) => entry.path === path)

      expect(chunksFor(frames, path)).toBe(op?.content)
    },
  )

  it('carries one marker per file and no code in the message', () => {
    const { result } = collect(TEXT)

    expect(result.messageText).toBe(
      'Three files.\n\n[file: index.html]\n\nStyles next.\n\n[file: styles.css]\n\n' +
        'And the behaviour.\n\n[file: app.js]\n\nDone.',
    )
    for (const needle of ['<h1>', 'color: red', 'console.log']) {
      expect(result.messageText).not.toContain(needle)
    }
  })

  it('emits a start and an end for each file, in written order', () => {
    const { frames } = collect(TEXT)

    const boundaries = frames.flatMap((frame) =>
      frame.kind === 'file_start' || frame.kind === 'file_end'
        ? [`${frame.kind}:${frame.path}`]
        : [],
    )

    expect(boundaries).toEqual([
      'file_start:index.html',
      'file_end:index.html',
      'file_start:styles.css',
      'file_end:styles.css',
      'file_start:app.js',
      'file_end:app.js',
    ])
  })
})
