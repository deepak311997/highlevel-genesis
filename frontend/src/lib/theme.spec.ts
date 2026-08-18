import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The design language, asserted where it is actually defined.
 *
 * `style.css` is the whole system: every colour, radius and face resolves from the token blocks
 * there, so a change to the design is a change to that file and very little else. That makes it
 * worth a test — not for the hex values, which are a judgement call and will move, but for the
 * properties that are contracts rather than taste.
 */

const css = readFileSync(join(process.cwd(), 'src/style.css'), 'utf8')

/** The `--name: value` declarations inside one top-level block. */
function tokensIn(selector: string): Map<string, string> {
  const start = css.indexOf(selector + ' {')
  expect(start, `no ${selector} block in style.css`).toBeGreaterThan(-1)
  const body = css.slice(start, css.indexOf('\n}', start))
  return new Map(
    [...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [
      m[1] ?? '',
      (m[2] ?? '').trim(),
    ]),
  )
}

/**
 * Colour-valued tokens are the ones that must exist in both themes. Geometry
 * (`--radius`) deliberately does not: one radius serves both grounds, and
 * duplicating it into `.dark` would be noise asserting nothing.
 */
const isColour = (value: string): boolean => /^(hsl|rgb|oklch|#)/.test(value)

/** Every .vue file under src/, recursively. */
function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return vueFiles(path)
    return entry.name.endsWith('.vue') ? [path] : []
  })
}

describe('the design tokens', () => {
  /*
   * The bug this exists to catch: a token defined only in `:root` renders one theme's colour on
   * the other theme's ground.
   */
  it('gives every colour token a dark value too', () => {
    const light = tokensIn(':root')
    const dark = tokensIn('.dark')
    const missing = [...light]
      .filter(([, value]) => isColour(value))
      .map(([token]) => token)
      .filter((token) => !dark.has(token))
    expect(missing, 'colour tokens with no dark value').toEqual([])
  })

  it('sets both faces from the self-hosted Geist family', () => {
    expect(css).toMatch(/@import '@fontsource-variable\/geist';/)
    expect(css).toMatch(/@import '@fontsource-variable\/geist-mono';/)
    expect(css).toMatch(/--font-sans:\s*'Geist Variable'/)
    expect(css).toMatch(/--font-mono:\s*'Geist Mono Variable'/)
  })

  /*
   * Instrument's geometry: 6px. Small enough that a control reads as precise
   * rather than friendly, which is the whole argument of the language.
   */
  it('carries Instrument’s radius', () => {
    expect(css).toMatch(/--radius:\s*0\.375rem;/)
  })
})

describe('Instrument’s weight ceiling', () => {
  /*
   * "Nothing heavier than semibold" is the single rule that most separates this language from
   * the one it replaces, and it is the easiest to lose: a new screen reaches for `font-bold`
   * because that is the habit, and the page quietly stops matching the system.
   */
  const BANNED = ['font-' + 'bold', 'font-' + 'extrabold', 'font-' + 'black']

  it('uses no weight above semibold in any component', () => {
    const offenders = vueFiles(join(process.cwd(), 'src'))
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      .filter(({ source }) => BANNED.some((needle) => source.includes(needle)))
      .map(({ path }) => path.slice(path.indexOf('src/')))
    expect(offenders, 'components using a weight above semibold').toEqual([])
  })

  /* The scanner, proven before it is trusted. */
  it('would catch a reintroduction', () => {
    expect(BANNED.some((needle) => '<h1 class="text-xl font-bold">x</h1>'.includes(needle))).toBe(
      true,
    )
  })
})
