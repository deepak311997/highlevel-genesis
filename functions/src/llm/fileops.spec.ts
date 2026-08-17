import { describe, expect, it } from 'vitest'

import {
  createFileCollector,
  createFileSplitter,
  MAX_INDENT,
  MAX_LINE,
  OPEN_HEAD,
  OPEN_TAIL,
  type CollectorFrame,
  type CollectResult,
  type SplitEvent,
} from './fileops'
import { PATH_MAX } from '../files/schema'

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

/**
 * Near-delimiters, tags inside content, and the line-start rule (AC-5, AC-6, P1,
 * P4).
 *
 * The splitter is exercised directly here rather than through the collector,
 * because what is being asserted is the **grammar**: which lines are delimiters
 * and which are text. Going through the collector would put both normalisers
 * between the assertion and the thing it is about.
 */

function split(text: string): SplitEvent[] {
  const splitter = createFileSplitter()
  return [...splitter.push(text), ...splitter.finish()]
}

/** Every byte the splitter kept, in order — delimiter lines excluded. */
const text = (events: SplitEvent[]): string =>
  events
    .flatMap((event) => (event.kind === 'prose' || event.kind === 'content' ? [event.text] : []))
    .join('')

const OPEN = '<genesis:file path="app.js">\n'
const CLOSE = '</genesis:file>\n'

describe('content that looks like markup (AC-5)', () => {
  const BODY = [
    '<!doctype html>\n',
    'if (a < b && b > c) return\n',
    '```js\n',
    'const x = 1\n',
    '```\n',
    '<genesis:file path="nested.js">\n',
    '</genesis:file >\n',
    'x</genesis:file>\n',
    ' </genesis:files>\n',
  ].join('')

  const INPUT = `Before.\n${OPEN}${BODY}${CLOSE}After.\n`

  it('preserves the body verbatim, closing only on the real tag', () => {
    const splitter = createFileSplitter()
    const events = [...splitter.push(INPUT), ...splitter.finish()]

    expect(events.flatMap((event) => (event.kind === 'content' ? [event.text] : [])).join('')).toBe(
      BODY,
    )
  })

  /*
   * A nested open tag inside a block is content (P4): inside a block only the
   * close tag is a delimiter, which is what AC-5 requires and what halves the
   * candidate set the hold-back has to consider.
   */
  it('opens exactly one block and closes it exactly once', () => {
    expect(split(INPUT).filter((event) => event.kind === 'open')).toHaveLength(1)
    expect(split(INPUT).filter((event) => event.kind === 'close')).toHaveLength(1)
  })

  /** Nothing is lost and nothing is duplicated: the two tag lines, and no more. */
  it('keeps every byte of the input except the two delimiter lines', () => {
    expect(text(split(INPUT))).toBe(`Before.\n${BODY}After.\n`)
  })

  /* A stray close tag in prose is prose, for the same reason (P4). */
  it('treats a close tag outside a block as ordinary prose', () => {
    const events = split(`Here is one: ${CLOSE}and that is all.\n`)

    expect(events.filter((event) => event.kind === 'close')).toHaveLength(0)
    expect(text(events)).toBe(`Here is one: ${CLOSE}and that is all.\n`)
  })
})

describe('the line-start rule (AC-6)', () => {
  const opened = (line: string): boolean =>
    split(`${line}\nbody\n${CLOSE}`).some((event) => event.kind === 'open')

  it.each([
    ['no indent', '<genesis:file path="app.js">'],
    ['one space', ' <genesis:file path="app.js">'],
    ['eight spaces', '        <genesis:file path="app.js">'],
    ['a tab', '\t<genesis:file path="app.js">'],
    ['trailing spaces after the tag', '<genesis:file path="app.js">   '],
  ])('treats an open tag with %s as a delimiter', (_label, line) => {
    expect(opened(line)).toBe(true)
  })

  it.each([
    ['a non-whitespace character before it', 'x<genesis:file path="app.js">'],
    ['a full stop before it', '. <genesis:file path="app.js">'],
    ['nine spaces', '         <genesis:file path="app.js">'],
    // P1: allowing a trailing suffix would open a file *and* eat the sentence.
    ['trailing prose on the line', '<genesis:file path="app.js"> and here is why'],
    ['an unquoted path', '<genesis:file path=app.js>'],
    ['a missing closing quote', '<genesis:file path="app.js>'],
    ['a missing angle bracket', '<genesis:file path="app.js"'],
    ['a quote inside the path', '<genesis:file path="a"b.js">'],
    ['a different tag name', '<genesis:files path="app.js">'],
  ])('treats an open tag with %s as prose', (_label, line) => {
    expect(opened(line)).toBe(false)
  })

  const closed = (line: string): boolean =>
    split(`${OPEN}body\n${line}\n`).some((event) => event.kind === 'close')

  it.each([
    ['no indent', '</genesis:file>'],
    ['four spaces', '    </genesis:file>'],
    ['a tab', '\t</genesis:file>'],
    ['trailing tabs', '</genesis:file>\t'],
  ])('treats a close tag with %s as a delimiter', (_label, line) => {
    expect(closed(line)).toBe(true)
  })

  it.each([
    ['a character before it', 'x</genesis:file>'],
    ['nine spaces', '         </genesis:file>'],
    ['a space inside the tag', '</genesis:file >'],
    ['trailing prose', '</genesis:file> done'],
  ])('treats a close tag with %s as content', (_label, line) => {
    expect(closed(line)).toBe(false)
  })

  /* The path capture is syntax only (D8): these all open a block and are refused
   * by `validateFileOps` at the terminal. */
  it.each(['../secrets.js', 'assets/app.js', '', 'A.HTML'])(
    'opens a block for the syntactically valid path %s and validates nothing',
    (path) => {
      const events = split(`<genesis:file path="${path}">\nbody\n${CLOSE}`)

      expect(events[0]).toEqual({ kind: 'open', path })
    },
  )

  /*
   * **Length is the one path rule the grammar keeps**, and it is not validation —
   * it is the same bound the hold-back is built on. `couldBeDelimiter` stops
   * holding a path once it passes `PATH_MAX`, because holding an unbounded one is
   * how a reply makes the splitter buffer without limit. A line grammar that
   * accepted what the hold-back had already given up on would open the block when
   * the tag arrived in one delta and not when it arrived in two, which is the
   * chunking dependence D4 forbids — and the visible failure is the whole
   * application landing in the chat bubble as prose.
   */
  it.each([
    [PATH_MAX, true],
    [PATH_MAX + 1, false],
  ])('treats a %i-character path as a delimiter: %s', (length, isDelimiter) => {
    const path = 'a'.repeat(length)
    const events = split(`<genesis:file path="${path}">\nbody\n${CLOSE}`)

    expect(events[0]?.kind === 'open').toBe(isDelimiter)
  })
})

describe('the hold-back bound', () => {
  /*
   * Named and asserted rather than argued in a comment. The bound is what stops
   * an adversarial reply from making the splitter buffer without limit: a line
   * longer than this cannot be a delimiter, so it is emitted rather than held.
   */
  it('is the longest line a delimiter could possibly occupy', () => {
    expect(MAX_LINE).toBe(
      MAX_INDENT + OPEN_HEAD.length + PATH_MAX + OPEN_TAIL.length + MAX_INDENT + 1,
    )
    expect(MAX_LINE).toBe(103)
  })

  /**
   * The property the bound exists for: a delimiter-shaped prefix followed by a
   * very long path is emitted rather than held for ever.
   */
  it('emits a partial line that has grown past the bound', () => {
    const splitter = createFileSplitter()
    const long = OPEN_HEAD + 'a'.repeat(MAX_LINE)

    expect(text(splitter.push(long))).toBe(long)
  })

  /* And a partial line still inside the bound is held, so the tag survives a split. */
  it('holds a partial line that could still become a delimiter', () => {
    const splitter = createFileSplitter()

    expect(splitter.push('<genesis:fi')).toEqual([])
    expect(splitter.push('le path="a.js">\n')).toEqual([{ kind: 'open', path: 'a.js' }])
  })
})

/**
 * A block that never closes, and the repairs (AC-7, AC-8, D16).
 *
 * The unterminated case is the one F8.1 is mostly about: a cut-off turn's last
 * block is unterminated by construction, and what must not happen is half a file
 * reaching the collection.
 */

describe('a block that is never closed (AC-7)', () => {
  const TEXT = `Here it is.\n\n<genesis:file path="index.html">\n<h1>Contacts</h1>\nstill writ`

  it('reports the path as unterminated and records no op', () => {
    const { result } = collect(TEXT)

    expect(result.unterminated).toBe('index.html')
    expect(result.ops).toEqual([])
  })

  it('emits no file_end for it', () => {
    const { frames } = collect(TEXT)

    expect(frames.filter((frame) => frame.kind === 'file_end')).toHaveLength(0)
  })

  /** Its content reaches the chat in no form at all. */
  it('puts none of its content in a token frame', () => {
    const { frames, result } = collect(TEXT)

    for (const needle of ['<h1>', 'Contacts', 'still writ']) {
      expect(tokens(frames)).not.toContain(needle)
      expect(result.messageText).not.toContain(needle)
    }
  })

  /*
   * The marker token *was* emitted, and that is correct: the message says a file
   * was attempted, and the tree says by omission that none was stored (D7's
   * rejected alternative).
   */
  it('keeps the marker it already emitted', () => {
    expect(collect(TEXT).result.messageText).toBe('Here it is.\n\n[file: index.html]')
  })

  /* Two files, the second unterminated: the first is still a complete op. */
  it('keeps an earlier closed block while reporting the later open one', () => {
    const { result } = collect(
      `${block('index.html', '<h1>x</h1>\n')}<genesis:file path="app.js">\nconst a = 1\n`,
    )

    expect(result.ops).toEqual([{ path: 'index.html', content: '<h1>x</h1>\n' }])
    expect(result.unterminated).toBe('app.js')
  })
})

describe('the line-ending and trailing-newline repairs (AC-8)', () => {
  it('rewrites CRLF content to LF and ends it with exactly one newline', () => {
    const { result } = collect(
      '<genesis:file path="app.js">\r\nconst a = 1\r\nconst b = 2\r\n</genesis:file>\r\n',
    )

    expect(result.ops).toEqual([{ path: 'app.js', content: 'const a = 1\nconst b = 2\n' }])
  })

  it('collapses a run of trailing blank lines to exactly one newline', () => {
    const { result } = collect(block('app.js', 'const a = 1\n\n\n\n'))

    expect(result.ops[0]?.content).toBe('const a = 1\n')
  })

  /* Blank lines *inside* a file are code, so they survive untouched. */
  it('leaves blank lines inside the body alone', () => {
    const { result } = collect(block('app.js', 'a\n\n\n\nb\n'))

    expect(result.ops[0]?.content).toBe('a\n\n\n\nb\n')
  })

  /* Spaces and tabs are meaningful in code, so only newline runs are held. */
  it('preserves trailing spaces on the last line', () => {
    const { result } = collect(block('app.js', 'const a = 1   \n'))

    expect(result.ops[0]?.content).toBe('const a = 1   \n')
  })

  /** A block with nothing in it is an empty file, not a file holding a newline. */
  it('gives an empty block empty content and emits no chunk', () => {
    const { frames, result } = collect(block('app.js', ''))

    expect(result.ops).toEqual([{ path: 'app.js', content: '' }])
    expect(frames.filter((frame) => frame.kind === 'file_chunk')).toHaveLength(0)
  })

  it('treats a block of blank lines as an empty file too', () => {
    expect(collect(block('app.js', '\n\n\n')).result.ops[0]?.content).toBe('')
  })

  /** A close tag that ends the input carries no newline, and still closes (P1). */
  it('closes a block whose close tag ends the input', () => {
    const { frames, result } = collect('<genesis:file path="app.js">\nconst a = 1\n</genesis:file>')

    expect(result.ops).toEqual([{ path: 'app.js', content: 'const a = 1\n' }])
    expect(chunksFor(frames, 'app.js')).toBe('const a = 1\n')
  })
})

describe('a CRLF split across two deltas', () => {
  /* One character wide, and the same hazard as a split tag. */
  it('repairs a line ending whose \\r and \\n arrived separately', () => {
    const collector = createFileCollector()
    const frames = [
      ...collector.push('<genesis:file path="app.js">\nconst a = 1\r'),
      ...collector.push('\nconst b = 2\n</genesis:file>\n'),
    ]
    const result = collector.finish()

    expect(result.ops).toEqual([{ path: 'app.js', content: 'const a = 1\nconst b = 2\n' }])
    expect(chunksFor([...frames, ...result.frames], 'app.js')).toBe('const a = 1\nconst b = 2\n')
  })

  /* A lone `\r` that never gets its `\n` is content, not a line ending. */
  it('keeps a carriage return that is not part of a line ending', () => {
    const { result } = collect(block('app.js', 'a\rb\n'))

    expect(result.ops[0]?.content).toBe('a\rb\n')
  })
})

/**
 * The corpus, shared by the invariant (AC-9) and the property (AC-4).
 *
 * One list rather than two, so a shape added for one is automatically covered by
 * the other — the malformed ones especially, since AC-9 says "including the
 * malformed ones" and a corpus that quietly lost them would still pass.
 */
const FIXTURES: [name: string, text: string][] = [
  ['empty', ''],
  ['whitespace only', '   \n\n  '],
  ['prose only', 'Here is a contact dashboard.\nIt lists everyone.\n'],
  ['prose needing both repairs', '\n\n  Here it is.\n\n\n\nAnd that is all.\n\n'],
  ['one block', `Before.\n\n${block('index.html', '<h1>Contacts</h1>\n')}\nAfter.\n`],
  ['marker only', block('index.html', '<h1>Contacts</h1>\n')],
  [
    'three blocks',
    [
      'Three files.\n\n',
      block('index.html', '<h1>Contacts</h1>\n'),
      '\nStyles.\n\n',
      block('styles.css', 'h1 { color: red }\n'),
      '\nBehaviour.\n\n',
      block('app.js', "console.log('hi')\n"),
      '\nDone.\n',
    ].join(''),
  ],
  ['an empty block', `Nothing in it.\n\n${block('app.js', '')}\n`],
  [
    'markup inside a block',
    `Before.\n${OPEN}<!doctype html>\na < b && b > c\n\`\`\`js\n<genesis:file path="n.js">\nx</genesis:file>\n</genesis:file >\n${CLOSE}After.\n`,
  ],
  [
    'CRLF throughout',
    '<genesis:file path="app.js">\r\nconst a = 1\r\nconst b = 2\r\n</genesis:file>\r\n',
  ],
  ['a lone carriage return', block('app.js', 'a\rb\n')],
  [
    'unterminated',
    `Here it is.\n\n<genesis:file path="index.html">\n<h1>Contacts</h1>\nstill writ`,
  ],
  ['closing at end of input', '<genesis:file path="app.js">\nconst a = 1\n</genesis:file>'],
  ['opening at end of input', 'Before.\n<genesis:file path="app.js">'],
  ['a duplicated path', `${block('app.js', 'one\n')}${block('app.js', 'two\n')}`],
  ['a path the schema will refuse', block('../secrets.js', 'oops\n')],
  ['an indented pair', `  <genesis:file path="app.js">\n  const a = 1\n  </genesis:file>\n`],
  [
    'near-delimiters in prose',
    `x<genesis:file path="a.js">\n</genesis:file>\n<genesis:file path=b.js>\n`,
  ],
  ['a delimiter-shaped line past the bound', `${OPEN_HEAD}${'a'.repeat(MAX_LINE)}\nafter\n`],
  /*
   * A **well-formed** tag whose path is longer than a name may be — the corner
   * the corpus above never reached, and the one where the hold-back's bound and
   * the line grammar could disagree. `couldBeDelimiter` stops holding a path once
   * it passes `PATH_MAX`, so a split there emits the partial as prose; the line
   * regex has to refuse the same line for the same reason, or the block opens
   * when the tag arrives whole and does not when it arrives in two deltas — and
   * the difference is the whole app landing in the chat bubble.
   */
  ['a path longer than a name may be', block(`${'a'.repeat(PATH_MAX)}.js`, 'const secret = 1\n')],
  ['no trailing newline anywhere', 'Prose with no newline at the end'],
]

describe('the message invariant (AC-9, D7, R5)', () => {
  /*
   * The one thing that makes Slice 5's placeholder swap safe: whatever the client
   * accumulated from `token` frames, the server's persisted copy is the same
   * string. Stated as an invariant rather than a habit, so a later slice adding a
   * `.trim()` before the write fails a test instead of shipping — the drift would
   * be in whitespace, which nobody notices until the bubble twitches.
   */
  it.each(FIXTURES)('holds for %s', (_name, fixture) => {
    const { frames, result } = collect(fixture)

    expect(result.messageText).toBe(tokens(frames))
  })

  /* And no file content ever reaches the chat text, on any fixture. */
  it.each(FIXTURES)('keeps file content out of the message for %s', (_name, fixture) => {
    const { result } = collect(fixture)

    for (const op of result.ops) {
      if (op.content.trim() === '') continue
      expect(result.messageText).not.toContain(op.content.trim())
    }
  })

  /* No frame is ever empty: an empty token or chunk is a lie about progress. */
  it.each(FIXTURES)('emits no empty text frame for %s', (_name, fixture) => {
    const { frames } = collect(fixture)

    for (const frame of frames) {
      if (frame.kind === 'token' || frame.kind === 'file_chunk') expect(frame.text).not.toBe('')
    }
  })
})

describe('a reply that is one block and nothing else (AC-10)', () => {
  /*
   * `storedMessageSchema` requires non-empty content, so a turn whose whole reply
   * was a file would be unwritable if the marker did not exist. This is the case
   * that makes D6's substitution load-bearing rather than cosmetic.
   */
  it('has the marker as its whole message', () => {
    const { result } = collect(block('index.html', '<!doctype html>\n'))

    expect(result.messageText).toBe('[file: index.html]')
    expect(result.messageText).not.toBe('')
  })

  it('gives one marker line per file when the reply is three blocks and no prose', () => {
    const { result } = collect(
      `${block('index.html', 'a\n')}${block('styles.css', 'b\n')}${block('app.js', 'c\n')}`,
    )

    expect(result.messageText).toBe('[file: index.html]\n[file: styles.css]\n[file: app.js]')
  })
})

/**
 * Chunking invariance (AC-4, D4, R1) — **the slice's one real hazard**.
 *
 * `<genesis:` is nine characters and a text delta is whatever the SDK felt like
 * sending, so `<genesis:fi` + `le path="a.js">` is an ordinary pair of deltas. A
 * naive per-delta scan misses the tag, leaks it into the chat bubble as prose,
 * and never opens the file — **and it passes every hand-written test above**,
 * because a hand-written test chunks on whole tags. Only a property driven at
 * every offset catches it, which is the same technique `frontend/src/lib/sse.ts`
 * already uses for the frame parser one layer down.
 */

/**
 * Adjacent frames of one kind folded together.
 *
 * How many frames a body arrives in **is** the chunking, so comparing frame
 * arrays directly would be asserting the opposite of the property. What must be
 * invariant is the sequence of boundaries and the bytes between them.
 */
function normalise(frames: CollectorFrame[]): CollectorFrame[] {
  const merged: CollectorFrame[] = []

  for (const frame of frames) {
    const last = merged.at(-1)
    if (last?.kind === 'token' && frame.kind === 'token') {
      merged[merged.length - 1] = { kind: 'token', text: last.text + frame.text }
      continue
    }
    if (last?.kind === 'file_chunk' && frame.kind === 'file_chunk' && last.path === frame.path) {
      merged[merged.length - 1] = {
        kind: 'file_chunk',
        path: frame.path,
        text: last.text + frame.text,
      }
      continue
    }
    merged.push(frame)
  }

  return merged
}

/** Push a text as the given list of chunks and gather everything it produced. */
function drive(chunks: string[]): { frames: CollectorFrame[]; result: CollectResult } {
  const collector = createFileCollector()
  const frames: CollectorFrame[] = []
  for (const chunk of chunks) frames.push(...collector.push(chunk))
  const result = collector.finish()
  return { frames: normalise([...frames, ...result.frames]), result }
}

describe('the emitted stream does not depend on how the text was chunked', () => {
  it.each(FIXTURES)('is identical at every split offset for %s', (_name, fixture) => {
    const whole = drive([fixture])

    for (let offset = 0; offset <= fixture.length; offset += 1) {
      const split = drive([fixture.slice(0, offset), fixture.slice(offset)])

      expect(split.frames).toEqual(whole.frames)
      expect(split.result.messageText).toBe(whole.result.messageText)
      expect(split.result.ops).toEqual(whole.result.ops)
      expect(split.result.unterminated).toBe(whole.result.unterminated)
    }
  })

  /* And the worst chunking there is: one character at a time. */
  it.each(FIXTURES)('is identical one character at a time for %s', (_name, fixture) => {
    const whole = drive([fixture])
    // UTF-16 code units rather than code points: the harsher chunking, and the
    // one a stream can actually produce.
    const perCharacter = drive(Array.from(fixture, (_unused, index) => fixture.charAt(index)))

    expect(perCharacter.frames).toEqual(whole.frames)
    expect(perCharacter.result.messageText).toBe(whole.result.messageText)
    expect(perCharacter.result.ops).toEqual(whole.result.ops)
    expect(perCharacter.result.unterminated).toBe(whole.result.unterminated)
  })

  /* Empty deltas happen, and must change nothing. */
  it.each(FIXTURES)('is unaffected by empty pushes for %s', (_name, fixture) => {
    const whole = drive([fixture])
    const padded = drive(['', fixture.slice(0, 3), '', fixture.slice(3), ''])

    expect(padded.frames).toEqual(whole.frames)
    expect(padded.result.ops).toEqual(whole.result.ops)
  })

  /** R1's named shape, written out so the regression has a name in the report. */
  it('parses a delimiter split mid-tag', () => {
    const { result } = drive(['Before.\n<genesis:fi', 'le path="a.js">\nbody\n</genesis:file>\n'])

    expect(result.ops).toEqual([{ path: 'a.js', content: 'body\n' }])
    expect(result.messageText).toBe('Before.\n[file: a.js]')
  })

  it('parses a close tag split mid-tag', () => {
    const { result } = drive(['<genesis:file path="a.js">\nbody\n</gene', 'sis:file>\n'])

    expect(result.ops).toEqual([{ path: 'a.js', content: 'body\n' }])
  })

  it('parses a CRLF split between its two characters', () => {
    const { result } = drive(['<genesis:file path="a.js">\r', '\nbody\r', '\n</genesis:file>\r\n'])

    expect(result.ops).toEqual([{ path: 'a.js', content: 'body\n' }])
  })

  /* A path split across three deltas, which a long filename makes likely. */
  it('parses a path split across several deltas', () => {
    const { result } = drive([
      '<genesis:file path="ind',
      'ex',
      '.html">\n<h1>x</h1>\n</genesis:',
      'file>\n',
    ])

    expect(result.ops).toEqual([{ path: 'index.html', content: '<h1>x</h1>\n' }])
  })
})
