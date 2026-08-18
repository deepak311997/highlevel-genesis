import { describe, expect, it } from 'vitest'

import { editorLanguage, EDITOR_LANGUAGES, PLAINTEXT } from './editorLanguage'

/**
 * AC-1, D25 — the extension → monaco language id map.
 *
 * The failure mode this exists for is **silent**: an unmapped extension renders as plaintext,
 * which looks like a file that simply has no colours rather than like a bug. Pinning the map to
 * the server's allowlist is what makes a future extension addition fail a test instead of
 * shipping colourless.
 */

/**
 * `functions/src/files/schema.ts`'s `FILE_EXTENSIONS`, restated.
 *
 * The functions package is not reachable from `frontend/`, which is why `filesApi.spec.ts`
 * restates `FILE_BYTES_MAX` the same way. Restated rather than derived: the point is that adding
 * an extension there without deciding what colours it here fails a test.
 */
const ALLOWED_EXTENSIONS = ['css', 'html', 'js', 'json', 'md'] as const

describe('editorLanguage', () => {
  it.each([
    ['index.html', 'html'],
    ['styles.css', 'css'],
    ['app.js', 'javascript'],
    ['notes.md', 'markdown'],
    // D4: monaco ships no basic-languages/json.
    ['data.json', 'plaintext'],
    // Outside Slice 6's allowlist entirely — the server would never store it.
    ['weird.txt', 'plaintext'],
    ['noextension', 'plaintext'],
  ])('maps %s to %s', (path, language) => {
    expect(editorLanguage(path)).toBe(language)
  })

  /*
   * The whole allowlist, so an extension added on the server cannot arrive here uncoloured and
   * unnoticed.
   */
  it('covers the whole allowlist, deliberately rather than by fall-through', () => {
    for (const extension of ALLOWED_EXTENSIONS) {
      expect(Object.hasOwn(EDITOR_LANGUAGES, extension)).toBe(true)
      expect(editorLanguage(`file.${extension}`)).toBe(EDITOR_LANGUAGES[extension])
    }
  })

  /* A dotted filename takes its *last* extension, which is what a browser does. */
  it('reads the last extension of a dotted name', () => {
    expect(editorLanguage('vendor.min.js')).toBe('javascript')
  })

  /* Case is not part of an extension: HTML is html. */
  it('is case-insensitive', () => {
    expect(editorLanguage('INDEX.HTML')).toBe('html')
  })

  /* A trailing dot names no extension, so it is the default rather than a crash. */
  it('falls back to plaintext for a trailing dot', () => {
    expect(editorLanguage('weird.')).toBe(PLAINTEXT)
  })
})
