import { describe, expect, it } from 'vitest'

import type { FileRejection } from '../files/schema'
import { applySteps, resolveStep, type LocatedStep, type Resolved, type Step } from './patch'

const CSS = ['body {', '  margin: 2rem;', '}', '', '#rows li {', '  padding: 0.5rem 0;', '}', ''].join(
  '\n',
)

const FILES = [{ path: 'a.css', content: CSS }]

interface Over {
  path?: string
  anchor?: string
  text?: string
}

/** A located step, built without an `as` — the verb decides the shape. */
function located(verb: LocatedStep['verb'], over: Over = {}): LocatedStep {
  const base = { path: over.path ?? 'a.css', text: over.text ?? '' }
  return verb === 'append' ? { verb, ...base } : { verb, ...base, anchor: over.anchor ?? '' }
}

function resolved(result: Resolved | FileRejection): Resolved {
  if ('reason' in result) throw new Error(`expected a resolution, got ${result.reason}`)
  return result
}

function rejected(result: Resolved | FileRejection): FileRejection {
  if (!('reason' in result)) throw new Error('expected a rejection')
  return result
}

describe('edit — replacing an anchor', () => {
  it('replaces the one occurrence and leaves every other byte identical', () => {
    const out = resolved(
      resolveStep(CSS, located('edit', { anchor: 'body {\n', text: 'body.dark {\n' })),
    )
    expect(out.content).toBe(CSS.replace('body {', 'body.dark {'))
  })

  it('spans the anchor, one-based and exclusive at the end', () => {
    const out = resolved(
      resolveStep(
        CSS,
        located('edit', { anchor: 'body {\n  margin: 2rem;\n}\n', text: 'body { margin: 0 }\n' }),
      ),
    )
    expect(out.range).toEqual({ from: 1, to: 4 })
  })

  it('deletes the anchor when the replacement is empty', () => {
    const out = resolved(
      resolveStep(CSS, located('edit', { anchor: '#rows li {\n  padding: 0.5rem 0;\n}\n' })),
    )
    expect(out.content).toBe('body {\n  margin: 2rem;\n}\n\n')
  })

  it('matches a multi-line anchor as a run of whole lines', () => {
    const out = resolved(
      resolveStep(CSS, located('edit', { anchor: '  margin: 2rem;\n}\n', text: '}\n' })),
    )
    expect(out.content).toBe('body {\n}\n\n#rows li {\n  padding: 0.5rem 0;\n}\n')
  })
})

describe('append — new text at the end', () => {
  it('puts the text after the last line and changes nothing else', () => {
    const out = resolved(resolveStep(CSS, located('append', { text: '.dark { color: #fff }\n' })))
    expect(out.content).toBe(`${CSS}.dark { color: #fff }\n`)
  })

  it('resolves to an empty range one past the last line', () => {
    const out = resolved(resolveStep(CSS, located('append', { text: 'x\n' })))
    expect(out.range).toEqual({ from: 8, to: 8 })
  })

  it('appends to a file with no trailing newline, and leaves one', () => {
    const out = resolved(resolveStep('a', located('append', { text: 'b\n' })))
    expect(out.content).toBe('a\nb\n')
  })
})

describe('after and before — new text at an anchor', () => {
  const anchor = '#rows li {\n  padding: 0.5rem 0;\n}\n'

  it('keeps the anchor byte for byte and puts the text after it', () => {
    const out = resolved(resolveStep(CSS, located('after', { anchor, text: '.dark { }\n' })))
    expect(out.content).toBe(`${CSS}.dark { }\n`)
    expect(out.content).toContain(anchor)
  })

  it('keeps the anchor byte for byte and puts the text before it', () => {
    const out = resolved(resolveStep(CSS, located('before', { anchor, text: '.dark { }\n' })))
    expect(out.content).toBe(
      'body {\n  margin: 2rem;\n}\n\n.dark { }\n#rows li {\n  padding: 0.5rem 0;\n}\n',
    )
    expect(out.content).toContain(anchor)
  })

  it('resolves both to an empty range — after the anchor, and at its first line', () => {
    expect(resolved(resolveStep(CSS, located('after', { anchor, text: 'x\n' }))).range).toEqual({
      from: 8,
      to: 8,
    })
    expect(resolved(resolveStep(CSS, located('before', { anchor, text: 'x\n' }))).range).toEqual({
      from: 5,
      to: 5,
    })
  })
})

describe('the anchor has to be there, exactly once', () => {
  it('refuses an anchor that is not in the file', () => {
    const out = rejected(resolveStep(CSS, located('edit', { anchor: 'nowhere {\n', text: 'x\n' })))
    expect(out).toEqual({ reason: 'edit-no-match', path: 'a.css' })
  })

  it('refuses an anchor that is in the file more than once', () => {
    const out = rejected(resolveStep(CSS, located('edit', { anchor: '}\n', text: 'x\n' })))
    expect(out).toEqual({ reason: 'edit-ambiguous', path: 'a.css' })
  })

  it('matches when only trailing whitespace differs', () => {
    const out = resolved(
      resolveStep(CSS, located('edit', { anchor: 'body {   \n', text: 'body.dark {\n' })),
    )
    expect(out.range).toEqual({ from: 1, to: 2 })
  })

  it('keeps a CRLF file CRLF, in the lines it writes as well as the ones it does not', () => {
    const crlf = CSS.replace(/\n/g, '\r\n')
    const out = resolved(
      resolveStep(crlf, located('edit', { anchor: 'body {\n', text: 'body.dark {\n' })),
    )
    expect(out.content).toBe(crlf.replace('body {', 'body.dark {'))
  })

  it('prefers an exact match over a whitespace-tolerant one', () => {
    const out = resolved(resolveStep('a  \na\n', located('edit', { anchor: 'a\n', text: 'z\n' })))
    expect(out.range).toEqual({ from: 2, to: 3 })
  })

  it('calls two exact matches ambiguous rather than falling through to the tolerant pass', () => {
    expect(rejected(resolveStep('a\na\n', located('edit', { anchor: 'a\n', text: 'z\n' }))).reason).toBe(
      'edit-ambiguous',
    )
  })
})

describe('what is refused before any matching happens', () => {
  it.each(['append', 'after', 'before', 'edit'] as const)(
    'refuses %s against a file the project does not hold',
    (verb) => {
      const out = rejected(
        resolveStep(undefined, located(verb, { path: 'gone.css', anchor: 'x\n', text: 'y\n' })),
      )
      expect(out).toEqual({ reason: 'edit-unknown-file', path: 'gone.css' })
    },
  )

  it.each(['after', 'before', 'edit'] as const)('refuses %s with an empty anchor', (verb) => {
    expect(rejected(resolveStep(CSS, located(verb, { anchor: '  \n', text: 'y\n' }))).reason).toBe(
      'edit-malformed',
    )
  })

  it.each(['append', 'after', 'before'] as const)('refuses %s with an empty payload', (verb) => {
    expect(rejected(resolveStep(CSS, located(verb, { anchor: 'body {\n' }))).reason).toBe(
      'edit-malformed',
    )
  })

  it('allows an empty payload for edit, which is how a deletion is written', () => {
    expect(resolved(resolveStep(CSS, located('edit', { anchor: 'body {\n' }))).content).not.toContain(
      'body {',
    )
  })
})

describe('applying a whole turn', () => {
  it('returns one op per touched path, in reply order', () => {
    const out = applySteps(FILES, [
      { verb: 'file', path: 'b.js', content: 'const x = 1\n' },
      { verb: 'append', path: 'a.css', text: '.z { }\n' },
    ])
    expect(out.ok && out.ops.map((op) => op.path)).toEqual(['b.js', 'a.css'])
  })

  it('collapses several ops on one path into one, at its first appearance', () => {
    const out = applySteps(FILES, [
      { verb: 'append', path: 'a.css', text: '.one { }\n' },
      { verb: 'file', path: 'b.js', content: 'x\n' },
      { verb: 'append', path: 'a.css', text: '.two { }\n' },
    ])
    expect(out.ok && out.ops.map((op) => op.path)).toEqual(['a.css', 'b.js'])
  })

  it('applies three ops to one path in reply order, each seeing the last one', () => {
    const out = applySteps(FILES, [
      { verb: 'append', path: 'a.css', text: '.one { }\n' },
      { verb: 'after', path: 'a.css', anchor: '.one { }\n', text: '.two { }\n' },
      { verb: 'edit', path: 'a.css', anchor: '.two { }\n', text: '.three { }\n' },
    ])
    expect(out.ok && out.ops[0]?.content).toBe(`${CSS}.one { }\n.three { }\n`)
  })

  it('lets an append land on a whole-file block written earlier in the same reply', () => {
    const out = applySteps(FILES, [
      { verb: 'file', path: 'a.css', content: 'fresh\n' },
      { verb: 'append', path: 'a.css', text: 'more\n' },
    ])
    expect(out.ok && out.ops[0]?.content).toBe('fresh\nmore\n')
  })

  it('refuses the whole turn on the first failure and names it', () => {
    const out = applySteps(FILES, [
      { verb: 'append', path: 'a.css', text: 'ok\n' },
      { verb: 'edit', path: 'a.css', anchor: 'nowhere\n', text: 'x\n' },
    ])
    expect(out.ok ? null : out.error).toEqual({ reason: 'edit-no-match', path: 'a.css' })
  })

  it('still refuses two whole-file blocks for one path', () => {
    const out = applySteps(FILES, [
      { verb: 'file', path: 'b.js', content: 'one\n' },
      { verb: 'file', path: 'b.js', content: 'two\n' },
    ])
    expect(out.ok ? null : out.error).toEqual({ reason: 'duplicate', path: 'b.js' })
  })

  it('lets a modify verb reach a file the same reply created', () => {
    const steps: Step[] = [
      { verb: 'file', path: 'b.js', content: 'one\n' },
      { verb: 'append', path: 'b.js', text: 'two\n' },
    ]
    const out = applySteps([], steps)
    expect(out.ok && out.ops[0]?.content).toBe('one\ntwo\n')
  })

  it('refuses a modify verb against a path nothing has created', () => {
    const out = applySteps([], [{ verb: 'append', path: 'b.js', text: 'two\n' }])
    expect(out.ok ? null : out.error).toEqual({ reason: 'edit-unknown-file', path: 'b.js' })
  })

  it('leaves the files it was given untouched', () => {
    const files = [{ path: 'a.css', content: CSS }]
    applySteps(files, [{ verb: 'append', path: 'a.css', text: 'x\n' }])
    expect(files[0]?.content).toBe(CSS)
  })
})
