import { describe, expect, it } from 'vitest'

import { PATH_MAX } from '../files/schema'
import {
  closeTagFor,
  createBlockSplitter,
  MAX_INDENT,
  MAX_LINE,
  openTagFor,
  separatorFor,
  VERBS,
  type BlockEvent,
  type Verb,
} from './blocks'

/** Everything a splitter produces for one whole input, pushed in one go. */
function split(text: string): BlockEvent[] {
  const splitter = createBlockSplitter()
  return [...splitter.push(text), ...splitter.finish()]
}

/** The same input, fed one character at a time. */
function splitByCharacter(text: string): BlockEvent[] {
  const splitter = createBlockSplitter()
  const events: BlockEvent[] = []
  for (const character of text) events.push(...splitter.push(character))
  events.push(...splitter.finish())
  return events
}

/** The same input, cut in two at `offset`. */
function splitAt(text: string, offset: number): BlockEvent[] {
  const splitter = createBlockSplitter()
  return [
    ...splitter.push(text.slice(0, offset)),
    ...splitter.push(text.slice(offset)),
    ...splitter.finish(),
  ]
}

/** Text events concatenate; delimiters do not, so compare a normalised form. */
function normalise(events: readonly BlockEvent[]): BlockEvent[] {
  const out: BlockEvent[] = []
  for (const event of events) {
    const last = out[out.length - 1]
    if ((event.kind === 'prose' || event.kind === 'content') && last?.kind === event.kind) {
      out[out.length - 1] = { kind: event.kind, text: last.text + event.text }
      continue
    }
    out.push(event)
  }
  return out
}

describe('the tag table', () => {
  it('derives every tag from the verb, so a tag cannot drift from its name', () => {
    expect(openTagFor('file')).toBe('<genesis:file path="')
    expect(closeTagFor('file')).toBe('</genesis:file>')
    expect(openTagFor('append')).toBe('<genesis:append path="')
    expect(closeTagFor('edit')).toBe('</genesis:edit>')
  })

  it('gives the two-section verbs a separator and the one-section verbs none', () => {
    expect(separatorFor('file')).toBeNull()
    expect(separatorFor('append')).toBeNull()
    expect(separatorFor('after')).toBe('<genesis:add>')
    expect(separatorFor('before')).toBe('<genesis:add>')
    expect(separatorFor('edit')).toBe('<genesis:with>')
  })

  it('bounds the held-back line by the longest open tag plus a storable path', () => {
    const longest = Math.max(...VERBS.map((verb) => openTagFor(verb).length))
    expect(MAX_LINE).toBe(MAX_INDENT + longest + PATH_MAX + '">'.length + MAX_INDENT + 1)
  })
})

describe('opening a block', () => {
  it.each(VERBS)('recognises <genesis:%s> at a line start', (verb: Verb) => {
    const events = split(`${openTagFor(verb)}a.js">\nbody\n${closeTagFor(verb)}\n`)
    expect(events[0]).toEqual({ kind: 'open', verb, path: 'a.js' })
  })

  it.each(VERBS)('recognises <genesis:%s> under eight leading spaces', (verb: Verb) => {
    const indent = ' '.repeat(MAX_INDENT)
    const events = split(`${indent}${openTagFor(verb)}a.js">\nbody\n${indent}${closeTagFor(verb)}\n`)
    expect(events[0]).toEqual({ kind: 'open', verb, path: 'a.js' })
    expect(events.at(-1)).toEqual({ kind: 'close', verb, path: 'a.js' })
  })

  it('treats a ninth leading space as prose', () => {
    const line = `${' '.repeat(MAX_INDENT + 1)}${openTagFor('edit')}a.js">\n`
    expect(normalise(split(line))).toEqual([{ kind: 'prose', text: line }])
  })

  it('treats a delimiter with trailing text on its line as prose', () => {
    const line = `${openTagFor('edit')}a.js"> and then\n`
    expect(normalise(split(line))).toEqual([{ kind: 'prose', text: line }])
  })

  it('allows trailing spaces and tabs after a delimiter', () => {
    const events = split(`${openTagFor('append')}a.js">  \t\nx\n${closeTagFor('append')}\t\n`)
    expect(events[0]).toEqual({ kind: 'open', verb: 'append', path: 'a.js' })
    expect(events.at(-1)).toEqual({ kind: 'close', verb: 'append', path: 'a.js' })
  })

  it('does not open on an unknown verb', () => {
    const line = '<genesis:destroy path="a.js">\n'
    expect(normalise(split(line))).toEqual([{ kind: 'prose', text: line }])
  })
})

describe('the three grammars', () => {
  it('gives a one-section verb one run of content and no separator', () => {
    const events = normalise(
      split(`${openTagFor('append')}a.css">\n.x { color: red }\n${closeTagFor('append')}\n`),
    )
    expect(events).toEqual([
      { kind: 'open', verb: 'append', path: 'a.css' },
      { kind: 'content', text: '.x { color: red }\n' },
      { kind: 'close', verb: 'append', path: 'a.css' },
    ])
  })

  it('splits a two-section verb at its separator', () => {
    const events = normalise(
      split(`${openTagFor('edit')}a.css">\nold\n<genesis:with>\nnew\n${closeTagFor('edit')}\n`),
    )
    expect(events).toEqual([
      { kind: 'open', verb: 'edit', path: 'a.css' },
      { kind: 'content', text: 'old\n' },
      { kind: 'separator', verb: 'edit', path: 'a.css' },
      { kind: 'content', text: 'new\n' },
      { kind: 'close', verb: 'edit', path: 'a.css' },
    ])
  })

  it('uses <genesis:add> for after and before', () => {
    const events = normalise(
      split(`${openTagFor('after')}a.html">\nold\n<genesis:add>\nnew\n${closeTagFor('after')}\n`),
    )
    expect(events.map((event) => event.kind)).toEqual([
      'open',
      'content',
      'separator',
      'content',
      'close',
    ])
  })

  it("treats a verb's separator as content inside a verb that has none", () => {
    const events = normalise(
      split(`${openTagFor('append')}a.css">\n<genesis:with>\n${closeTagFor('append')}\n`),
    )
    expect(events).toEqual([
      { kind: 'open', verb: 'append', path: 'a.css' },
      { kind: 'content', text: '<genesis:with>\n' },
      { kind: 'close', verb: 'append', path: 'a.css' },
    ])
  })

  it('treats the other separator as content', () => {
    const events = normalise(
      split(`${openTagFor('edit')}a.css">\n<genesis:add>\n${closeTagFor('edit')}\n`),
    )
    expect(events[1]).toEqual({ kind: 'content', text: '<genesis:add>\n' })
  })

  it('treats a second separator as content in the second section', () => {
    const events = normalise(
      split(`${openTagFor('edit')}a.css">\nold\n<genesis:with>\n<genesis:with>\nnew\n${closeTagFor('edit')}\n`),
    )
    expect(events[3]).toEqual({ kind: 'content', text: '<genesis:with>\nnew\n' })
  })

  it('closes only on its own closing tag', () => {
    const events = normalise(
      split(`${openTagFor('edit')}a.css">\n</genesis:append>\n${closeTagFor('edit')}\n`),
    )
    expect(events[1]).toEqual({ kind: 'content', text: '</genesis:append>\n' })
    expect(events[2]).toEqual({ kind: 'close', verb: 'edit', path: 'a.css' })
  })

  it('does not open a nested block', () => {
    const inner = `${openTagFor('file')}b.js">\n`
    const events = normalise(split(`${openTagFor('edit')}a.css">\n${inner}${closeTagFor('edit')}\n`))
    expect(events[1]).toEqual({ kind: 'content', text: inner })
  })

  it('reads a stray closing tag in prose as prose', () => {
    const line = `${closeTagFor('edit')}\n`
    expect(normalise(split(line))).toEqual([{ kind: 'prose', text: line }])
  })
})

describe('what an unterminated block leaves behind', () => {
  it('never emits a close for a block the reply ended inside', () => {
    const events = split(`${openTagFor('edit')}a.css">\nold\n`)
    expect(events.some((event) => event.kind === 'close')).toBe(false)
  })

  it('resolves a delimiter that ends at end of input rather than at a newline', () => {
    const events = split(`${openTagFor('append')}a.css">\nx\n${closeTagFor('append')}`)
    expect(events.at(-1)).toEqual({ kind: 'close', verb: 'append', path: 'a.css' })
  })
})

/**
 * The property Slice 6 found a real bug with, now over five verbs and two
 * separators: a delimiter arriving across two pushes must read the same as one
 * arriving whole.
 */
describe('chunking invariance', () => {
  const reply = [
    'Here is what I changed.',
    '',
    `${openTagFor('file')}app.js">`,
    'const x = 1',
    closeTagFor('file'),
    '',
    `${openTagFor('append')}styles.css">`,
    '.dark { color: #fff }',
    closeTagFor('append'),
    '',
    `${openTagFor('after')}index.html">`,
    '  <h1>Contacts</h1>',
    '<genesis:add>',
    '  <button>Theme</button>',
    closeTagFor('after'),
    '',
    `${openTagFor('before')}index.html">`,
    '</body>',
    '<genesis:add>',
    '<script src="app.js"></script>',
    closeTagFor('before'),
    '',
    `${openTagFor('edit')}styles.css">`,
    'body { margin: 0 }',
    '<genesis:with>',
    'body { margin: 2rem }',
    closeTagFor('edit'),
    '',
    'That is all.',
    '',
  ].join('\n')

  const whole = normalise(split(reply))

  it('produces the same events one character at a time', () => {
    expect(normalise(splitByCharacter(reply))).toEqual(whole)
  })

  it('produces the same events split at every offset', () => {
    for (let offset = 1; offset < reply.length; offset += 1) {
      expect(normalise(splitAt(reply, offset)), `split at ${String(offset)}`).toEqual(whole)
    }
  })

  it('handles a CRLF split across two pushes', () => {
    const crlf = reply.replace(/\n/g, '\r\n')
    const splitter = createBlockSplitter()
    const events: BlockEvent[] = []
    const cut = crlf.indexOf('\r\n', crlf.indexOf('app.js')) + 1
    events.push(...splitter.push(crlf.slice(0, cut)))
    events.push(...splitter.push(crlf.slice(cut)))
    events.push(...splitter.finish())
    expect(normalise(events)).toEqual(whole)
  })
})

describe('the hold-back is bounded', () => {
  it('gives up on a path longer than one that could be stored', () => {
    const splitter = createBlockSplitter()
    const events = splitter.push(`${openTagFor('edit')}${'a'.repeat(PATH_MAX + 10)}`)
    expect(events).toEqual([
      { kind: 'prose', text: `${openTagFor('edit')}${'a'.repeat(PATH_MAX + 10)}` },
    ])
  })

  it('holds nothing longer than MAX_LINE, however adversarial the input', () => {
    const splitter = createBlockSplitter()
    splitter.push(`${openTagFor('edit')}${'a'.repeat(1_000_000)}`)
    // Everything over the bound was emitted rather than buffered, so the flush is
    // empty rather than a megabyte.
    expect(splitter.finish()).toEqual([])
  })
})
