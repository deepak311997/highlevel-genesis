import { describe, expect, it } from 'vitest'

import { editorEdit, type EditorEdit } from './editorContent'

/**
 * AC-2 – AC-5, D8, R1 — **the slice's one real hazard**, proven where it is cheap.
 *
 * The alternative this module exists to refuse is `model.setValue(next)` on every chunk. That
 * version passes every automated test this repo can run below L5 — jsdom computes no layout and
 * runs no Monaco — and in the running app it snaps the viewport back to line 1 on each chunk, so
 * a user watching a 300-line file stream in stares at its first ten lines for the whole
 * generation, resets the undo stack per chunk, and re-tokenizes the whole document each time:
 * O(n²) over the file.
 */

/**
 * What monaco does with the returned edit, modelled — an append concatenates at
 * the end, a splice replaces the range that actually changed.
 *
 * This is the round trip's oracle (AC-5). Written here rather than imported so
 * the spec states its own expectation of monaco rather than sharing a definition
 * with the code under test, which would make the assertion circular.
 */
function apply(current: string, edit: EditorEdit | null): string {
  if (edit === null) return current
  if (edit.kind === 'append') return current + edit.text
  return current.slice(0, edit.offset) + edit.text + current.slice(edit.offset + edit.length)
}

describe('editorEdit', () => {
  /** AC-2. Nothing changed, so nothing is issued — not a zero-length edit. */
  it('returns null when the two are equal', () => {
    expect(editorEdit('<h1>Contacts</h1>', '<h1>Contacts</h1>')).toBeNull()
    expect(editorEdit('', '')).toBeNull()
  })

  /**
   * AC-3. The suffix, **not** the whole document — which is the entire point of
   * the module, and the assertion that fails if this is ever "simplified".
   */
  it('returns an append carrying only the suffix', () => {
    const current = '<h1>Contacts'
    const next = '<h1>Contacts</h1>\n'

    const edit = editorEdit(current, next)

    expect(edit).toEqual({ kind: 'append', text: '</h1>\n' })
    expect(edit?.text).toBe(next.slice(current.length))
    // The claim R1 is about: an append is O(delta), not O(document).
    expect(edit?.text.length).toBeLessThan(next.length)
  })

  it('appends onto an empty buffer, which is a file’s first chunk', () => {
    expect(editorEdit('', 'body{}')).toEqual({ kind: 'append', text: 'body{}' })
  })

  /** AC-4, over the three shapes that actually occur. */
  it.each([
    ['a different file’s content', '<h1>Contacts</h1>', 'body { margin: 0 }'],
    ['a server repair that changed earlier bytes', '<h1>Contacts', '<!doctype html>\n<h1>Contacts'],
    ['a shorter string', '<h1>Contacts</h1>\n', '<h1>Contacts'],
  ])('returns a splice for %s', (_label, current, next) => {
    expect(editorEdit(current, next)?.kind).toBe('splice')
    expect(apply(current, editorEdit(current, next))).toBe(next)
  })

  /**
   * AC-30 — the point of the splice. A change in the middle of a long file must
   * not touch the bytes around it, or Monaco re-tokenises the whole document and
   * the viewport leaves what the user was reading.
   */
  it('touches only the range that changed, in the middle of a long file', () => {
    const before = `${'x\n'.repeat(200)}old\n${'y\n'.repeat(200)}`
    const after = before.replace('old', 'new')

    const edit = editorEdit(before, after)

    expect(edit).toEqual({ kind: 'splice', offset: 400, length: 3, text: 'new' })
  })

  it('deletes with an empty text rather than rewriting the document', () => {
    const edit = editorEdit('a\nb\nc\n', 'a\nc\n')
    expect(edit).toEqual({ kind: 'splice', offset: 2, length: 2, text: '' })
  })

  it('never produces a negative length, however the strings overlap', () => {
    for (const [current, next] of CORPUS) {
      const edit = editorEdit(current, next)
      if (edit?.kind !== 'splice') continue
      expect(edit.length).toBeGreaterThanOrEqual(0)
      expect(edit.offset + edit.length).toBeLessThanOrEqual(current.length)
    }
  })

  /**
   * AC-5 — the round trip, which is what makes the two branches one contract
   * rather than two behaviours that happen to be tested separately.
   */
  const CORPUS: readonly (readonly [string, string])[] = [
    ['', ''],
    ['', '<!doctype html>'],
    ['<!doctype html>', '<!doctype html>\n<title>Contacts</title>'],
    ['<!doctype html>', '<!doctype html>'],
    ['<h1>Contacts</h1>\n', '<h1>People</h1>\n'],
    ['<h1>Contacts</h1>\n', '<h1>Contacts'],
    ['body { margin: 0 }', 'body { margin: 0 }\n.row { display: flex }\n'],
    ['const a = 1', 'const a = 1;\n'],
    // Multi-byte, because slicing by code unit is where a naive suffix goes wrong.
    ['日本', '日本語'],
    ['日本語', '日本'],
    // A newline-only delta, which is what a slow stream mostly produces.
    ['line one\n', 'line one\nline two\n'],
  ]

  it.each(CORPUS)('applying the edit to %j yields %j', (current, next) => {
    expect(apply(current, editorEdit(current, next))).toBe(next)
  })
})
