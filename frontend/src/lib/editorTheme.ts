import type { editor } from 'monaco-editor'

/**
 * Monaco, dressed in Instrument.
 *
 * The editor already followed the app's theme — `CodeEditor.vue` swapped
 * Monaco's stock `vs` and `vs-dark` on the `.dark` class. What it did not do is
 * *match*: stock `vs` is pure white with VS Code's blues, which sits a shade
 * brighter than Instrument's near-white ground and colours code in a palette
 * the rest of the app does not use. The seam showed exactly where the editor
 * meets the panel beside it.
 *
 * **The grounds are the app's own tokens, not approximations.** `editor.background`
 * is `--background` in each theme, so the editor is seamless with the panel it
 * sits in rather than a rectangle laid on top of it. `editorTheme.spec.ts`
 * converts the token out of `style.css` and asserts the match, so the two cannot
 * drift apart in a later palette change.
 *
 * **Syntax colour is information, not decoration**, which is why it is the one
 * place Instrument spends more than a single hue. The rule the language does
 * keep here is restraint: five roles, no background fills on tokens, and
 * comments set in the same grey as muted interface text so they recede the same
 * way in both places.
 */

/** The five roles Instrument spends colour on, plus the three the four
 *  registered languages need to stay readable. */
interface Palette {
  comment: string
  keyword: string
  string: string
  number: string
  entity: string
  type: string
  tag: string
  attribute: string
}

/** Instrument's syntax roles, light. Chosen for legibility on a near-white ground. */
const LIGHT: Palette = {
  comment: '6E7781',
  keyword: 'CF222E',
  string: '0A3069',
  number: '0550AE',
  entity: '8250DF',
  type: '953800',
  tag: '116329',
  attribute: '0550AE',
}

/** The same roles, dark. Lifted rather than inverted — a hue that reads on
 *  paper is muddy on near-black, so each is brighter and less saturated. */
const DARK: Palette = {
  comment: '6B6E78',
  keyword: 'FF7B8A',
  string: '8DD6A0',
  number: '7FB4FF',
  entity: 'C09BFF',
  type: 'E0A876',
  tag: '7EE787',
  attribute: '79C0FF',
}

/**
 * The four tokenizers `monacoSetup.ts` registers are JavaScript, CSS, HTML and
 * Markdown, so these are the scopes that actually appear. Anything else falls
 * through to the inherited base theme.
 */
function rulesFor(palette: Palette): editor.ITokenThemeRule[] {
  return [
    { token: 'comment', foreground: palette.comment, fontStyle: 'italic' },
    { token: 'keyword', foreground: palette.keyword },
    { token: 'string', foreground: palette.string },
    { token: 'number', foreground: palette.number },
    { token: 'regexp', foreground: palette.string },
    { token: 'type', foreground: palette.type },
    { token: 'type.identifier', foreground: palette.entity },
    { token: 'tag', foreground: palette.tag },
    { token: 'metatag', foreground: palette.keyword },
    { token: 'attribute.name', foreground: palette.attribute },
    { token: 'attribute.value', foreground: palette.string },
    // CSS
    { token: 'keyword.css', foreground: palette.keyword },
    { token: 'attribute.name.css', foreground: palette.attribute },
    { token: 'attribute.value.css', foreground: palette.string },
    // Markdown
    { token: 'keyword.md', foreground: palette.keyword },
    { token: 'string.link.md', foreground: palette.attribute },
  ]
}

/** The app tokens this theme mirrors — see the spec, which asserts the match. */
export const EDITOR_GROUND = {
  light: { background: '#FCFCFD', foreground: '#16171A' },
  dark: { background: '#0A0A0B', foreground: '#EDEDEF' },
} as const

export const THEME_LIGHT = 'instrument-light'
export const THEME_DARK = 'instrument-dark'

export const INSTRUMENT_LIGHT: editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: rulesFor(LIGHT),
  colors: {
    'editor.background': EDITOR_GROUND.light.background,
    'editor.foreground': EDITOR_GROUND.light.foreground,
    'editorGutter.background': EDITOR_GROUND.light.background,
    'editorLineNumber.foreground': '#B4B6BE',
    'editorLineNumber.activeForeground': '#5F6169',
    // A tinted line highlight rather than a bordered one: Instrument marks the
    // caret's row by ground, the same way a table marks a hovered row.
    'editor.lineHighlightBackground': '#F4F4F6',
    'editor.selectionBackground': '#2B4BF226',
    'editor.inactiveSelectionBackground': '#2B4BF214',
    'editorCursor.foreground': '#2B4BF2',
    'editorIndentGuide.background1': '#EBEBEF',
    'editorIndentGuide.activeBackground1': '#DFDFE6',
    'editorWidget.background': '#FFFFFF',
    'editorWidget.border': '#DFDFE6',
    'editorBracketMatch.background': '#2B4BF21A',
    'editorBracketMatch.border': '#2B4BF200',
    'scrollbarSlider.background': '#16171A1F',
    'scrollbarSlider.hoverBackground': '#16171A33',
  },
}

export const INSTRUMENT_DARK: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: rulesFor(DARK),
  colors: {
    'editor.background': EDITOR_GROUND.dark.background,
    'editor.foreground': EDITOR_GROUND.dark.foreground,
    'editorGutter.background': EDITOR_GROUND.dark.background,
    'editorLineNumber.foreground': '#4A4C55',
    'editorLineNumber.activeForeground': '#9295A0',
    'editor.lineHighlightBackground': '#141417',
    'editor.selectionBackground': '#4D96FF33',
    'editor.inactiveSelectionBackground': '#4D96FF1A',
    'editorCursor.foreground': '#6699FF',
    'editorIndentGuide.background1': '#1E1E22',
    'editorIndentGuide.activeBackground1': '#2A2A30',
    'editorWidget.background': '#0F0F11',
    'editorWidget.border': '#2A2A30',
    'editorBracketMatch.background': '#4D96FF26',
    'editorBracketMatch.border': '#4D96FF00',
    'scrollbarSlider.background': '#EDEDEF1F',
    'scrollbarSlider.hoverBackground': '#EDEDEF33',
  },
}

/**
 * Registered against whichever monaco instance the caller holds, rather than
 * importing monaco here — this module must stay free of the ~1 MB chunk so a
 * test (or anything else) can read the palette without pulling the editor in.
 */
export function registerEditorThemes(target: {
  editor: { defineTheme: (name: string, data: editor.IStandaloneThemeData) => void }
}): void {
  target.editor.defineTheme(THEME_LIGHT, INSTRUMENT_LIGHT)
  target.editor.defineTheme(THEME_DARK, INSTRUMENT_DARK)
}
