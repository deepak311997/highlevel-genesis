import { describe, expect, it } from 'vitest'

import { splitAtRange, StreamingDocuments } from './streamingDocuments'

const FILE = 'a\nb\nc\n'

describe('splitAtRange', () => {
  it('splits either side of a replaced line', () => {
    expect(splitAtRange(FILE, 2, 3)).toEqual({ prefix: 'a\n', suffix: 'c\n' })
  })

  it('gives the whole file back in two halves for an insertion', () => {
    const { prefix, suffix } = splitAtRange(FILE, 4, 4)
    expect(prefix + suffix).toBe(FILE)
    expect(prefix).toBe('a\nb\nc\n')
    expect(suffix).toBe('')
  })

  it('puts an insertion at line one entirely in the suffix', () => {
    expect(splitAtRange(FILE, 1, 1)).toEqual({ prefix: '', suffix: FILE })
  })

  it('spans several lines', () => {
    expect(splitAtRange(FILE, 1, 3)).toEqual({ prefix: '', suffix: 'c\n' })
  })
})

describe('a whole file being written', () => {
  it('shows only what has arrived', () => {
    const docs = new StreamingDocuments()
    docs.beginFile('a.js', 'create')
    expect(docs.content('a.js')).toBe('')
    docs.push('a.js', 'const ')
    docs.push('a.js', 'x = 1\n')
    expect(docs.content('a.js')).toBe('const x = 1\n')
  })

  it('reports creating and rewriting apart', () => {
    const docs = new StreamingDocuments()
    docs.beginFile('a.js', 'create')
    docs.beginFile('b.js', 'rewrite')
    expect(docs.states()).toEqual({ 'a.js': 'creating', 'b.js': 'rewriting' })
  })
})

describe('a located change', () => {
  it('composes prefix, body and suffix at every step', () => {
    const docs = new StreamingDocuments()
    docs.beginEdit('a.txt', splitAtRange(FILE, 2, 3))

    expect(docs.content('a.txt')).toBe('a\nc\n')
    docs.push('a.txt', 'B')
    expect(docs.content('a.txt')).toBe('a\nBc\n')
    docs.push('a.txt', '\n')
    expect(docs.content('a.txt')).toBe('a\nB\nc\n')
  })

  it('leaves the rest of the file untouched for an insertion', () => {
    const docs = new StreamingDocuments()
    docs.beginEdit('a.txt', splitAtRange(FILE, 4, 4))

    expect(docs.content('a.txt')).toBe(FILE)
    docs.push('a.txt', 'd\n')
    expect(docs.content('a.txt')).toBe('a\nb\nc\nd\n')
  })

  it('marks the row as editing', () => {
    const docs = new StreamingDocuments()
    docs.beginEdit('a.txt', splitAtRange(FILE, 1, 2))
    expect(docs.states()).toEqual({ 'a.txt': 'editing' })
  })
})

describe('when the browser does not hold the file yet', () => {
  it('accumulates the new text alone and says it is waiting', () => {
    const docs = new StreamingDocuments()
    docs.beginEdit('a.txt', null)
    docs.push('a.txt', 'B\n')

    expect(docs.awaitingBase('a.txt')).toBe(true)
    expect(docs.content('a.txt')).toBe('B\n')
  })

  it('puts what already arrived in place when the file lands', () => {
    const docs = new StreamingDocuments()
    docs.beginEdit('a.txt', null)
    docs.push('a.txt', 'B\n')
    docs.rebase('a.txt', splitAtRange(FILE, 2, 3))

    expect(docs.content('a.txt')).toBe('a\nB\nc\n')
    expect(docs.awaitingBase('a.txt')).toBe(false)
    docs.push('a.txt', 'B2\n')
    expect(docs.content('a.txt')).toBe('a\nB\nB2\nc\n')
  })

  it('ignores a base that arrives for a change already based', () => {
    const docs = new StreamingDocuments()
    docs.beginEdit('a.txt', splitAtRange(FILE, 2, 3))
    docs.rebase('a.txt', { prefix: 'WRONG', suffix: 'WRONG' })
    expect(docs.content('a.txt')).toBe('a\nc\n')
  })

  it('ignores a base for a path nothing opened', () => {
    const docs = new StreamingDocuments()
    docs.rebase('gone.txt', { prefix: 'x', suffix: 'y' })
    expect(docs.content('gone.txt')).toBeUndefined()
  })
})

describe('several paths at once', () => {
  it('keeps each one to itself', () => {
    const docs = new StreamingDocuments()
    docs.beginFile('a.js', 'create')
    docs.beginEdit('b.css', splitAtRange('x\ny\n', 1, 2))

    docs.push('a.js', 'one')
    docs.push('b.css', 'two')

    expect(docs.content('a.js')).toBe('one')
    expect(docs.content('b.css')).toBe('twoy\n')
    expect(docs.paths()).toEqual(['a.js', 'b.css'])
  })

  it('lets a second change to one path build on the first', () => {
    const docs = new StreamingDocuments()
    docs.beginEdit('a.txt', splitAtRange(FILE, 4, 4))
    docs.push('a.txt', 'd\n')

    const after = docs.content('a.txt') ?? ''
    docs.beginEdit('a.txt', splitAtRange(after, 1, 2))
    docs.push('a.txt', 'A\n')

    expect(docs.content('a.txt')).toBe('A\nb\nc\nd\n')
  })

  it('drops a chunk for a path nothing opened rather than inventing one', () => {
    const docs = new StreamingDocuments()
    docs.push('nowhere.js', 'x')
    expect(docs.content('nowhere.js')).toBeUndefined()
    expect(docs.paths()).toEqual([])
  })

  it('empties on clear', () => {
    const docs = new StreamingDocuments()
    docs.beginFile('a.js', 'create')
    docs.clear()
    expect(docs.paths()).toEqual([])
    expect(docs.states()).toEqual({})
  })
})
