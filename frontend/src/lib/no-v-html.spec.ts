import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * **`v-html` appears nowhere in `frontend/src`.**
 *
 * `markdown.ts` renders model output, and its safety argument is structural: the parser returns
 * tagged data, the template prints it through interpolation, and Vue escapes every text node.
 * That argument holds only while nobody reaches for `v-html` — one `v-html="message.content"` in
 * a future component and the whole property is gone, silently, with every test still green.
 */

const SRC = join(process.cwd(), 'src')

/** Built by concatenation, and this file skips itself below. */
const NEEDLE = 'v-' + 'html'

/** Every way it can come back, as source a scan has to catch. */
const FORMS: readonly (readonly [string, string])[] = [
  ['a plain directive', `<p ${NEEDLE}="content" />`],
  ['a shorthand binding', `<div ${NEEDLE}='rendered'></div>`],
  ['a render-function prop', `h('div', { innerHTML: html })`],
]

/**
 * What must not fire, or the scan would be unmaintainable.
 *
 * The first two are the reason {@link stripComments} exists. This rule has to be
 * *explained* — in `markdown.ts`'s module comment, in this file's, and in any
 * review that revisits it — and a scan that treats its own justification as a
 * violation is a scan somebody deletes rather than satisfies.
 */
const INNOCENT: readonly (readonly [string, string])[] = [
  ['a line comment naming the rule', `// never use ${NEEDLE} here`],
  ['a block comment naming the rule', `/* ${NEEDLE} appears nowhere */`],
  ['an HTML comment naming the rule', `<!-- no ${NEEDLE} in this template -->`],
  ['an ordinary interpolation', '<p>{{ part.text }}</p>'],
  ['reading innerHTML in an assertion', 'expect(el.innerHTML).toContain("x")'],
]

/**
 * Specs are excluded: they assert on rendered markup, so `.innerHTML` reads are
 * their ordinary vocabulary. Nothing in a spec ships.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!/\.(?:vue|ts)$/.test(entry.name)) return []
    if (entry.name.endsWith('.spec.ts')) return []
    return [full]
  })
}

/**
 * Comments removed before the scan, so documenting the rule is not breaking it.
 *
 * Crude on purpose — a `//` inside a string literal takes the rest of that line with it. The
 * consequence of over-stripping here is a missed offence in a line that also contains a URL, and
 * the consequence of under-stripping is a scan nobody keeps; between a rule that is slightly
 * permissive and a rule that gets deleted, the first one still catches the case it exists for.
 */
function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

/** Exported shape kept parallel to the sibling scans: text in, offences out. */
export function offences(source: string): string[] {
  const text = stripComments(source)
  const hits: string[] = []
  if (text.includes(NEEDLE)) hits.push(NEEDLE)
  /*
   * Assignment or object property — `el.innerHTML = x` and `h('div', { innerHTML: x })` are the
   * same hazard wearing different syntax.
   */
  if (/innerHTML\s*[:=][^=]/.test(text)) hits.push('innerHTML')
  return hits
}

describe('the scanner itself', () => {
  it.each(FORMS)('catches %s', (_name, source) => {
    expect(offences(source)).not.toEqual([])
  })

  it.each(INNOCENT)('ignores %s', (_name, source) => {
    expect(offences(source)).toEqual([])
  })
})

describe('frontend/src', () => {
  it('never renders raw HTML', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => offences(readFileSync(path, 'utf8')).length > 0)
      .map((path) => path.slice(SRC.length + 1))

    expect(offenders).toEqual([])
  })
})
