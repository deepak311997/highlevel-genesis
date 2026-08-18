#!/usr/bin/env node
/**
 * Create `functions/.secret.local` from its committed example, if it is absent.
 *
 * `functions/.secret.local` is gitignored — it is where a real API key lives during manual
 * verification — so a fresh clone does not have one. The functions emulator resolves a declared
 * secret by reading that file and, failing that, by calling Secret Manager, which on a demo
 * project with no credentials logs:
 */
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const TARGET = join(ROOT, 'functions', '.secret.local')
export const EXAMPLE = join(ROOT, 'functions', '.secret.local.example')

/**
 * The names a dotenv-shaped file assigns, in order.
 *
 * Comments and blank lines are not keys. `KEY=` with nothing after it is — the
 * name is present, which is all this needs to know.
 */
function keysIn(contents) {
  return contents
    .split('\n')
    .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
    .filter((key) => key !== undefined)
}

/**
 * Returns `'created'`, `'extended'` or `'kept'`, so a caller can say which
 * happened rather than printing the same line either way.
 */
export function ensureSecretLocal(target = TARGET, example = EXAMPLE) {
  if (!existsSync(example)) {
    // A repository that lost a committed file, which is worth saying out loud:
    // the emulator would otherwise log the very error this exists to prevent,
    // and nothing would explain why.
    throw new Error(
      `Missing ${example}. functions/.secret.local.example is committed — restore it from git.`,
    )
  }

  const exampleContents = readFileSync(example, 'utf8')

  if (!existsSync(target)) {
    copyFileSync(example, target)
    return 'created'
  }

  const current = readFileSync(target, 'utf8')
  const have = new Set(keysIn(current))
  const missing = keysIn(exampleContents).filter((key) => !have.has(key))

  if (missing.length === 0) return 'kept'

  /* Appended rather than merged in place, and the existing lines are not rewritten. */
  const lines = missing.map((key) => {
    const assignment = exampleContents
      .split('\n')
      .find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line))
    return assignment ?? `${key}=`
  })

  // A file whose last line has no newline would otherwise gain `KEY=…` glued to
  // the end of it, producing one corrupt line instead of two good ones.
  const lead = current === '' || current.endsWith('\n') ? '' : '\n'

  appendFileSync(
    target,
    `${lead}\n# Added by scripts/ensure-secret-local.mjs.\n${lines.join('\n')}\n`,
  )
  return 'extended'
}

// Guarded so importing this module from the spec does not touch the real file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outcome = ensureSecretLocal()
  if (outcome === 'created') {
    console.log('functions/.secret.local written from .secret.local.example (placeholder values)')
  } else if (outcome === 'extended') {
    console.log('functions/.secret.local gained the secrets it was missing (placeholder values)')
  }
}
