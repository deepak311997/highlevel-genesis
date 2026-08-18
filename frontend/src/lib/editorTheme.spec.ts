import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  EDITOR_GROUND,
  INSTRUMENT_DARK,
  INSTRUMENT_LIGHT,
  THEME_DARK,
  THEME_LIGHT,
  registerEditorThemes,
} from './editorTheme'

/**
 * The editor's ground has to be the app's ground, or the seam shows where the
 * editor meets the panel beside it — and that seam is exactly what a stock
 * Monaco theme produces, because `vs` is pure white and Instrument's background
 * is not.
 *
 * Monaco takes hex and `style.css` is written in `hsl()`, so the two cannot
 * share a literal. Converting here is what keeps them from drifting: a later
 * palette change that moves `--background` and forgets the editor fails this,
 * rather than shipping a visible edge nobody looks for.
 */

const css = readFileSync(join(process.cwd(), 'src/style.css'), 'utf8')

/** `--background` out of one top-level block. */
function backgroundOf(selector: string): string {
  const start = css.indexOf(selector + ' {')
  expect(start, `no ${selector} block in style.css`).toBeGreaterThan(-1)
  const body = css.slice(start, css.indexOf('\n}', start))
  const match = /--background:\s*hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)/.exec(body)
  expect(match, `no hsl --background in ${selector}`).not.toBeNull()
  return hslToHex(Number(match?.[1]), Number(match?.[2]), Number(match?.[3]))
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100
  const lig = l / 100
  const c = (1 - Math.abs(2 * lig - 1)) * sat
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lig - c / 2
  const [r, g, b] = (
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  )
  const hex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase()
}

describe('the editor theme', () => {
  /*
   * The converter, proven before it is trusted — the rest of this file is only
   * as good as this function. The cases are exact by construction rather than
   * sampled from the palette: `--primary` is written `hsl(230 88% 56%)`, which
   * is a *rounding* of the brand's #2B4BF2 and converts back to #2C4DF2. A test
   * asserting the brand hex here would be asserting the rounding error.
   */
  it('converts hsl to hex', () => {
    expect(hslToHex(0, 0, 100)).toBe('#FFFFFF')
    expect(hslToHex(0, 0, 0)).toBe('#000000')
    expect(hslToHex(0, 100, 50)).toBe('#FF0000')
    expect(hslToHex(120, 100, 50)).toBe('#00FF00')
    expect(hslToHex(240, 100, 50)).toBe('#0000FF')
    expect(hslToHex(0, 0, 50)).toBe('#808080')
  })

  it.each([
    ['light', ':root', () => EDITOR_GROUND.light.background],
    ['dark', '.dark', () => EDITOR_GROUND.dark.background],
  ])('grounds the %s editor in the app’s own --background', (_name, selector, ground) => {
    expect(ground().toUpperCase()).toBe(backgroundOf(selector))
  })

  it('sets a matching gutter, so the line numbers sit on the same ground', () => {
    expect(INSTRUMENT_LIGHT.colors['editorGutter.background']).toBe(
      INSTRUMENT_LIGHT.colors['editor.background'],
    )
    expect(INSTRUMENT_DARK.colors['editorGutter.background']).toBe(
      INSTRUMENT_DARK.colors['editor.background'],
    )
  })

  it('inherits from the matching base, so unlisted scopes stay legible', () => {
    expect(INSTRUMENT_LIGHT.base).toBe('vs')
    expect(INSTRUMENT_DARK.base).toBe('vs-dark')
    expect(INSTRUMENT_LIGHT.inherit).toBe(true)
    expect(INSTRUMENT_DARK.inherit).toBe(true)
  })

  /*
   * Monaco takes rule colours *without* a leading `#` and silently ignores a
   * rule it cannot parse — the token simply renders in the base theme's colour,
   * which looks like a palette that did not quite take rather than an error.
   */
  it('writes every rule colour in the bare six-digit form monaco parses', () => {
    for (const theme of [INSTRUMENT_LIGHT, INSTRUMENT_DARK]) {
      for (const rule of theme.rules) {
        expect(rule.foreground, rule.token).toMatch(/^[0-9A-Fa-f]{6}$/)
      }
    }
  })

  it('covers the four languages the app actually registers', () => {
    for (const theme of [INSTRUMENT_LIGHT, INSTRUMENT_DARK]) {
      const tokens = theme.rules.map((rule) => rule.token)
      for (const scope of ['comment', 'keyword', 'string', 'number', 'tag', 'attribute.name']) {
        expect(tokens, scope).toContain(scope)
      }
    }
  })

  it('registers both themes under the names the editor asks for', () => {
    const defineTheme = vi.fn()
    registerEditorThemes({ editor: { defineTheme } })

    expect(defineTheme).toHaveBeenCalledTimes(2)
    expect(defineTheme).toHaveBeenCalledWith(THEME_LIGHT, INSTRUMENT_LIGHT)
    expect(defineTheme).toHaveBeenCalledWith(THEME_DARK, INSTRUMENT_DARK)
  })
})
