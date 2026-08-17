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

  /* Even an empty one. "Exists" is the whole test, not "has content we like". */
  it('does not overwrite an existing empty file', () => {
    const dir = tempDir()
    const example = join(dir, '.secret.local.example')
    const target = join(dir, '.secret.local')
    writeFileSync(example, 'ANTHROPIC_API_KEY=placeholder\n')
    writeFileSync(target, '')

    expect(ensureSecretLocal(target, example)).toBe('kept')

    expect(readFileSync(target, 'utf8')).toBe('')
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
