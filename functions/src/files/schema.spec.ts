import { describe, expect, it } from 'vitest'

import {
  displayPath,
  FILE_BYTES_MAX,
  FILE_EXTENSIONS,
  FILE_LIMIT,
  filePathSchema,
  filesPath,
  PATH_MAX,
} from './schema'

/**
 * The filename, and what may not be one (AC-11, D12).
 *
 * Traversal is refused by **the shape of a name** rather than by a sanitiser that
 * has to be right about every encoding: `../secrets.js`, `/etc/passwd`, `a/b.js`,
 * `..` and `.env` all simply fail to be filenames. That is the whole security
 * argument of the path half of this slice, so the refused list is written out
 * case by case rather than summarised by a regex a reader would have to re-derive.
 */

describe('filePathSchema', () => {
  /**
   * AC-11's refusals.
   *
   * Each entry names *why* it is here, because a bare list of strings is a list a
   * later reader deletes an entry from without noticing what it covered.
   */
  it.each([
    ['parent traversal', '../secrets.js'],
    ['an absolute path', '/etc/passwd'],
    ['a directory segment', 'assets/app.js'],
    ['the parent directory itself', '..'],
    ['a dotfile', '.env'],
    ['an uppercase letter', 'Index.html'],
    ['no extension at all', 'app'],
    ['an extension outside the allowlist', 'app.ts'],
    ['a doubled dot in the middle', 'a..b.js'],
    // 65 characters: `PATH_MAX` is 64, so this is the first name over the cap.
    ['a 65-character name', `${'a'.repeat(62)}.js`],
    ['the empty string', ''],
    // A file whose name *is* an extension has no base, so it is a dotfile by
    // another spelling.
    ['an extension with no base', '.js'],
    ['a backslash', 'a\\b.js'],
    ['a NUL byte', 'app\u0000.js'],
    ['a space', 'my app.js'],
    ['a trailing dot', 'app.js.'],
  ])('refuses %s', (_reason, path) => {
    expect(filePathSchema.safeParse(path).success).toBe(false)
  })

  it.each([
    'index.html',
    'styles.css',
    'app.js',
    'data.json',
    'notes.md',
    'a-b_c.2.js',
    // Exactly at the cap, so the boundary is a fact rather than an inference.
    `${'a'.repeat(61)}.js`,
  ])('accepts %s', (path) => {
    expect(filePathSchema.safeParse(path)).toMatchObject({ success: true, data: path })
  })

  /* The refusal names the path, so `fileError` can be reproduced from a fixture. */
  it('refuses with a message a person can act on', () => {
    const parsed = filePathSchema.safeParse('assets/app.js')

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBeTruthy()
  })
})

describe('the constants the whole slice is built from', () => {
  /*
   * Pinned because three other files interpolate them: the system prompt (D25),
   * the frontend's mirrored caps, and the copy table. A change here that is not a
   * deliberate product decision fails in one obvious place.
   */
  it('caps a project at 20 files and a file at 100,000 UTF-8 bytes', () => {
    expect(FILE_LIMIT).toBe(20)
    expect(FILE_BYTES_MAX).toBe(100_000)
    expect(PATH_MAX).toBe(64)
  })

  /* The preview runs plain HTML/CSS/JS (D1), so nothing that needs a build step. */
  it('allows exactly the five extensions the preview can run', () => {
    expect([...FILE_EXTENSIONS]).toEqual(['css', 'html', 'js', 'json', 'md'])
  })

  /*
   * Composed from `projectsPath` rather than a second `'users'` literal, so the
   * four segments cannot drift.
   */
  it('composes the collection path under the project', () => {
    expect(filesPath('alice', 'proj-1')).toBe('users/alice/projects/proj-1/files')
  })
})

describe('displayPath', () => {
  /*
   * A path reaches the copy table straight from the model's output, so it is a
   * hostile string until this function has been over it: control characters could
   * smuggle a second line into an error notice, and an arbitrarily long one would
   * blow up the panel.
   */
  it('strips control characters', () => {
    expect(displayPath('app\u001b[31m.js\nrm -rf')).toBe('app[31m.jsrm -rf')
  })

  it('truncates at 40 characters', () => {
    expect(displayPath('a'.repeat(200))).toHaveLength(40)
  })

  it('leaves an ordinary filename exactly as it is', () => {
    expect(displayPath('index.html')).toBe('index.html')
  })
})
