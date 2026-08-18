import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ensureSecretLocal } from './ensure-secret-local.mjs'

/**
 * `functions/.secret.local` is gitignored, so a fresh clone does not have it.
 *
 * The functions emulator resolves a declared secret by reading that file and,
 * failing that, by calling Secret Manager — which on a demo project with no
 * credentials logs `ERROR … Unable to access secret environment variables` on the
 * first `/generate` invocation. It does not prompt and does not abort, so nothing
 * breaks; but the definition of done says the emulator run is clean from a fresh
 * clone, and a red ERROR line in every local demo is not clean.
 *
 * The placeholder it writes is never used: under the emulator `openStream` takes
 * the fake path and never constructs the SDK client.
 *
 * **Never overwriting is the case that matters.** A developer's real key lives in
 * that file for manual checks against the live API, and a script that clobbered
 * it on every `npm run dev` would be a script that deletes credentials.
 */

const made = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-secret-'))
  made.push(dir)
  return dir
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true })
})

describe('ensureSecretLocal', () => {
  it('writes the file from the example when it is absent', () => {
    const dir = tempDir()
    const example = join(dir, '.secret.local.example')
    const target = join(dir, '.secret.local')
    writeFileSync(example, 'ANTHROPIC_API_KEY=placeholder\n')

    expect(ensureSecretLocal(target, example)).toBe('created')

    expect(readFileSync(target, 'utf8')).toBe('ANTHROPIC_API_KEY=placeholder\n')
  })

  /* The one that matters: a real key lives here during manual verification. */
  it('does not touch a file that already exists', () => {
    const dir = tempDir()
    const example = join(dir, '.secret.local.example')
    const target = join(dir, '.secret.local')
    writeFileSync(example, 'ANTHROPIC_API_KEY=placeholder\n')
    writeFileSync(target, 'ANTHROPIC_API_KEY=sk-a-real-key-somebody-pasted\n')

    expect(ensureSecretLocal(target, example)).toBe('kept')

    expect(readFileSync(target, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-a-real-key-somebody-pasted\n')
  })

  /*
   * Adding a *key* is not overwriting a *value*, and the difference is the whole
   * reason this branch exists.
   *
   * A second and a third secret were declared after this script was written —
   * `HL_CLIENT_SECRET` and `OAUTH_STATE_SECRET` moved into Secret Manager with
   * the deploy pipeline. Every developer who had already cloned held a
   * `.secret.local` naming only the first one, and because the file existed the
   * script left it alone — so they got the red `Unable to access secret
   * environment variables` line on every emulator run, which is the exact noise
   * this script exists to prevent, with nothing on screen to explain it.
   *
   * So: values are never touched, and absent keys are filled in from the
   * example.
   */
  it('adds a key the example has and the file lacks', () => {
    const dir = tempDir()
    const example = join(dir, '.secret.local.example')
    const target = join(dir, '.secret.local')
    writeFileSync(example, 'ANTHROPIC_API_KEY=placeholder\nOAUTH_STATE_SECRET=also-placeholder\n')
    writeFileSync(target, 'ANTHROPIC_API_KEY=sk-a-real-key-somebody-pasted\n')

    expect(ensureSecretLocal(target, example)).toBe('extended')

    const written = readFileSync(target, 'utf8')
    expect(written).toContain('ANTHROPIC_API_KEY=sk-a-real-key-somebody-pasted')
    expect(written).toContain('OAUTH_STATE_SECRET=also-placeholder')
    // The real key is still the only ANTHROPIC_API_KEY line, not shadowed by a
    // placeholder appended below it — last-one-wins would silently replace it.
    expect(written).not.toContain('ANTHROPIC_API_KEY=placeholder')
  })

  /* A file that already names everything is left exactly as it is. */
  it('keeps a file that has every key, whatever the values', () => {
    const dir = tempDir()
    const example = join(dir, '.secret.local.example')
    const target = join(dir, '.secret.local')
    writeFileSync(example, 'ANTHROPIC_API_KEY=placeholder\nOAUTH_STATE_SECRET=also-placeholder\n')
    const mine = 'OAUTH_STATE_SECRET=mine\nANTHROPIC_API_KEY=sk-real\n'
    writeFileSync(target, mine)

    expect(ensureSecretLocal(target, example)).toBe('kept')

    expect(readFileSync(target, 'utf8')).toBe(mine)
  })

  /*
   * An empty file names no keys, so it gains all of them. There is no value to
   * clobber — the rule is about values, and an empty file has none.
   */
  it('fills an existing empty file', () => {
    const dir = tempDir()
    const example = join(dir, '.secret.local.example')
    const target = join(dir, '.secret.local')
    writeFileSync(example, 'ANTHROPIC_API_KEY=placeholder\n')
    writeFileSync(target, '')

    expect(ensureSecretLocal(target, example)).toBe('extended')

    expect(readFileSync(target, 'utf8')).toContain('ANTHROPIC_API_KEY=placeholder')
  })

  /* Comments and blank lines in the example are not keys and are not copied. */
  it('ignores comments when deciding what is missing', () => {
    const dir = tempDir()
    const example = join(dir, '.secret.local.example')
    const target = join(dir, '.secret.local')
    writeFileSync(example, '# a comment\n\nANTHROPIC_API_KEY=placeholder\n')
    writeFileSync(target, 'ANTHROPIC_API_KEY=sk-real\n')

    expect(ensureSecretLocal(target, example)).toBe('kept')

    expect(readFileSync(target, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-real\n')
  })

  /* A file whose last line has no newline must not gain `KEY=…` glued to it. */
  it('starts a new line when the existing file does not end in one', () => {
    const dir = tempDir()
    const example = join(dir, '.secret.local.example')
    const target = join(dir, '.secret.local')
    writeFileSync(example, 'ANTHROPIC_API_KEY=placeholder\nOAUTH_STATE_SECRET=seed\n')
    writeFileSync(target, 'ANTHROPIC_API_KEY=sk-real')

    expect(ensureSecretLocal(target, example)).toBe('extended')

    expect(readFileSync(target, 'utf8')).toMatch(/^ANTHROPIC_API_KEY=sk-real$/m)
    expect(readFileSync(target, 'utf8')).toMatch(/^OAUTH_STATE_SECRET=seed$/m)
  })

  /*
   * A missing example is a repository that lost a committed file, which is worth
   * saying out loud rather than silently skipping — the emulator would then log
   * the very error this exists to prevent, and nothing would explain why.
   */
  it('throws when the committed example is missing', () => {
    const dir = tempDir()

    expect(() => ensureSecretLocal(join(dir, '.secret.local'), join(dir, 'nope.example'))).toThrow(
      /\.secret\.local\.example/,
    )
  })
})
