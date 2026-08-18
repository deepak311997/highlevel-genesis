import { describe, expect, it } from 'vitest'

import { parseInline, parseMarkdown } from './markdown'

/**
 * The markdown the model actually writes, parsed into a tree the template renders with ordinary
 * elements.
 *
 * **The security property is the shape of the output, not a sanitiser.** `parseMarkdown` returns
 * data, never HTML, so `MessageBody.vue` renders it through Vue interpolation and `v-html` never
 * appears. That is the same objection `messageParts.ts` recorded when it refused a renderer — "a
 * second parser over content the model controls, with an injection surface" — answered by
 * removing the surface rather than by trusting a scrubber. The link case below is the one place
 * a value reaches an attribute, and it is the one place with a scheme allowlist.
 */

describe('parseInline', () => {
  it('returns one text run for plain prose', () => {
    expect(parseInline('just prose')).toEqual([{ kind: 'text', text: 'just prose' }])
  })

  it('reads **bold** and __bold__', () => {
    expect(parseInline('a **b** c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' c' },
    ])
    expect(parseInline('__b__')).toEqual([{ kind: 'strong', text: 'b' }])
  })

  it('reads *italic* and _italic_', () => {
    expect(parseInline('*b*')).toEqual([{ kind: 'em', text: 'b' }])
    expect(parseInline('_b_')).toEqual([{ kind: 'em', text: 'b' }])
  })

  /* Bold before italic: `**x**` must not read as an empty em wrapping `x`. */
  it('prefers bold over italic on a double marker', () => {
    expect(parseInline('**x**')).toEqual([{ kind: 'strong', text: 'x' }])
  })

  it('reads `code`', () => {
    expect(parseInline('run `npm run dev` now')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'npm run dev' },
      { kind: 'text', text: ' now' },
    ])
  })

  /*
   * Code wins over every other marker, so a backticked `**` is shown rather
   * than interpreted. Without this the model cannot talk about markdown at all.
   */
  it('does not parse markers inside code', () => {
    expect(parseInline('`a **b** c`')).toEqual([{ kind: 'code', text: 'a **b** c' }])
  })

  it('reads an http link', () => {
    expect(parseInline('[docs](https://example.com/x)')).toEqual([
      { kind: 'link', text: 'docs', href: 'https://example.com/x' },
    ])
  })

  /* The injection case, and the reason `href` is the only attribute this parser ever produces. */
  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '/etc/passwd'])(
    'refuses %o as a link and leaves it literal',
    (href) => {
      const parts = parseInline(`[click](${href})`)

      expect(parts.every((part) => part.kind !== 'link')).toBe(true)
      expect(parts.map((part) => part.text).join('')).toBe(`[click](${href})`)
    },
  )
})

describe('parseMarkdown', () => {
  it('reads a paragraph', () => {
    expect(parseMarkdown('hello there')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'hello there' }] },
    ])
  })

  it('splits paragraphs on a blank line', () => {
    const blocks = parseMarkdown('one\n\ntwo')

    expect(blocks).toHaveLength(2)
    expect(blocks.every((block) => block.kind === 'paragraph')).toBe(true)
  })

  it('keeps a single newline inside one paragraph', () => {
    expect(parseMarkdown('one\ntwo')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'one\ntwo' }] },
    ])
  })

  it.each([
    ['# h', 1],
    ['## h', 2],
    ['### h', 3],
  ])('reads %o as a level-%i heading', (line, level) => {
    expect(parseMarkdown(line)).toEqual([
      { kind: 'heading', level, inline: [{ kind: 'text', text: 'h' }] },
    ])
  })

  it('reads a bullet list and keeps inline markup inside each item', () => {
    expect(parseMarkdown('- **Slots are real.** The month view asks.\n- Second')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          [
            { kind: 'strong', text: 'Slots are real.' },
            { kind: 'text', text: ' The month view asks.' },
          ],
          [{ kind: 'text', text: 'Second' }],
        ],
      },
    ])
  })

  it('reads an ordered list', () => {
    const blocks = parseMarkdown('1. first\n2. second')

    expect(blocks).toEqual([
      {
        kind: 'list',
        ordered: true,
        items: [[{ kind: 'text', text: 'first' }], [{ kind: 'text', text: 'second' }]],
      },
    ])
  })

  it('reads a fenced code block and does not parse markup inside it', () => {
    expect(parseMarkdown('```js\nconst a = **b**\n```')).toEqual([
      { kind: 'code', lang: 'js', text: 'const a = **b**' },
    ])
  })

  it('reads a fence with no language as null', () => {
    expect(parseMarkdown('```\nx\n```')).toEqual([{ kind: 'code', lang: null, text: 'x' }])
  })

  it('reads a blockquote', () => {
    expect(parseMarkdown('> quoted')).toEqual([
      { kind: 'quote', inline: [{ kind: 'text', text: 'quoted' }] },
    ])
  })

  it.each(['---', '***', '___'])('reads %o as a rule', (line) => {
    expect(parseMarkdown(line)).toEqual([{ kind: 'rule' }])
  })

  it('yields nothing for empty or whitespace-only content', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('   \n\n  ')).toEqual([])
  })

  /*
   * Streaming. The parser runs again on every token, so the half-written states
   * below are seen by a real user on a real reply — each has to render as the
   * literal characters that have arrived, never as a swallowed remainder.
   */
  describe('partial content, mid-stream', () => {
    it('leaves an unterminated bold literal', () => {
      expect(parseMarkdown('a **b')).toEqual([
        { kind: 'paragraph', inline: [{ kind: 'text', text: 'a **b' }] },
      ])
    })

    it('leaves an unterminated code span literal', () => {
      expect(parseMarkdown('a `b')).toEqual([
        { kind: 'paragraph', inline: [{ kind: 'text', text: 'a `b' }] },
      ])
    })

    it('leaves an unterminated link literal', () => {
      expect(parseMarkdown('[docs](https://exa')).toEqual([
        { kind: 'paragraph', inline: [{ kind: 'text', text: '[docs](https://exa' }] },
      ])
    })

    /* An open fence closes at end of input rather than hiding what follows. */
    it('closes an unterminated fence at the end of what has arrived', () => {
      expect(parseMarkdown('```js\nconst a = 1')).toEqual([
        { kind: 'code', lang: 'js', text: 'const a = 1' },
      ])
    })

    it('grows a list one item at a time without reflowing the earlier ones', () => {
      const one = parseMarkdown('- first')
      const two = parseMarkdown('- first\n- second')

      expect(one[0]).toMatchObject({ kind: 'list', items: [[{ text: 'first' }]] })
      expect(two[0]).toMatchObject({
        kind: 'list',
        items: [[{ text: 'first' }], [{ text: 'second' }]],
      })
    })
  })
})
