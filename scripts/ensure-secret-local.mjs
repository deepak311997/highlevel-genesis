#!/usr/bin/env node
/**
 * Create `functions/.secret.local` from its committed example, if it is absent.
 *
 * `functions/.secret.local` is gitignored — it is where a real API key lives
 * during manual verification — so a fresh clone does not have one. The functions
 * emulator resolves a declared secret by reading that file and, failing that, by
 * calling Secret Manager, which on a demo project with no credentials logs:
 *
 *   ERROR … Unable to access secret environment variables
 *
 * on the first `/generate` invocation. It does not prompt and does not abort, so
 * nothing actually breaks — under the emulator `openStream` takes the fake path
 * and never constructs the SDK client, so the placeholder is never used. But the
 * definition of done says the emulator run is clean from a fresh clone, and a red
 * ERROR line in every local demo is not clean.
 *
 * **It never overwrites.** A developer's real key lives in that file, and a
 * script that clobbered it on every `npm run dev` would be a script that deletes
 * credentials.
 */
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const TARGET = join(ROOT, 'functions', '.secret.local')
export const EXAMPLE = join(ROOT, 'functions', '.secret.local.example')

/**
 * Returns `'created'` or `'kept'`, so a caller can say which happened rather
 * than printing the same line either way.
 */
export function ensureSecretLocal(target = TARGET, example = EXAMPLE) {
  if (existsSync(target)) return 'kept'

  if (!existsSync(example)) {
    // A repository that lost a committed file, which is worth saying out loud:
    // the emulator would otherwise log the very error this exists to prevent,
    // and nothing would explain why.
    throw new Error(
      `Missing ${example}. functions/.secret.local.example is committed — restore it from git.`,
    )
  }

  copyFileSync(example, target)
  return 'created'
}

// Guarded so importing this module from the spec does not touch the real file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (ensureSecretLocal() === 'created') {
    console.log('functions/.secret.local written from .secret.local.example (placeholder value)')
  }
}
