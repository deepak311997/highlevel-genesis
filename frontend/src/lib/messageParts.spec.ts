import { describe, expect, it } from 'vitest'

import { splitMessageContent, type MessagePart } from './messageParts'

/**
 * AC-46's pure half.
 *
 * The transcript carries `[file: index.html]` marker lines rather than code, and rendering them
 * as text would give a chat that reads like a build log with what looks like a bug sitting in
 * it. This is ten lines of template over a pure function — not a markdown renderer, which D6 and
 * D29 both refuse.
 */

const text = (value: string): MessagePart => ({ kind: 'text', text: value })
const file = (path: string): MessagePart => ({ kind: 'file', path })

describe('splitMessageContent', () => {
  it('splits prose and marker lines into parts, in order', () => {
    expect(
      splitMessageContent(
        'Here is a contact dashboard.\n\n[file: index.html]\n[file: app.js]\n\nDone.',
      ),
    ).toEqual([
      text('Here is a contact dashboard.'),
      file('index.html'),
      file('app.js'),
      text('Done.'),
    ])
  })

  /** AC-10's shape: a reply that is one block and nothing else. */
  it('returns a single file part for a marker-only message', () => {
    expect(splitMessageContent('[file: index.html]')).toEqual([file('index.html')])
  })

  it('returns a single text part for a message with no marker', () => {
    expect(splitMessageContent('Just prose.\nOver two lines.')).toEqual([
      text('Just prose.\nOver two lines.'),
    ])
  })

  /** A line that only *looks* like a marker stays text. */
  it.each([
    'prefix [file: a.js]',
    '[file: a.js] suffix',
    '[file:a.js]',
    '[file: ]',
    '[FILE: a.js]',
    '[file: a.js',
  ])('leaves %s as text', (line) => {
    expect(splitMessageContent(line)).toEqual([text(line)])
  })

  /* An indented marker is still a marker: the server holds no whitespace back
   * before it, but a lenient reader here costs nothing and a strict one would
   * show the raw line to a user. */
  it('accepts a marker indented by spaces', () => {
    expect(splitMessageContent('  [file: app.js]')).toEqual([file('app.js')])
  })

  it('returns nothing for an empty message', () => {
    expect(splitMessageContent('')).toEqual([])
  })

  /*
   * Blank lines between markers are collapsed rather than becoming empty text
   * parts, so the bubble does not grow a gap for every file.
   */
  it('emits no empty text part between adjacent markers', () => {
    const parts = splitMessageContent('[file: a.js]\n\n[file: b.js]')

    expect(parts).toEqual([file('a.js'), file('b.js')])
  })

  /** The streaming placeholder is the same string, so it splits the same way. */
  it('handles a partial message that ends mid-word', () => {
    expect(splitMessageContent('Here is a cont')).toEqual([text('Here is a cont')])
  })

  it('handles a partial message whose last line is half a marker', () => {
    expect(splitMessageContent('Here it is.\n\n[file: ind')).toEqual([
      text('Here it is.\n\n[file: ind'),
    ])
  })
})
