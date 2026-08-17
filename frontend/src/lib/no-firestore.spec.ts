import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * AC-24 — the architectural guarantee, as a test rather than a convention.
 *
 * The frontend never talks to Firestore: every read and write goes through a
 * Cloud Function route that verifies the ID token and scopes the query by the
 * uid inside it. `frontend/eslint.config.js` is the mechanism that enforces
 * that; this is the assertion that survives someone editing the ESLint config,
 * disabling the rule for a line, or adding an allowlist entry "just for now".
 *
 * A convention that lives only in CLAUDE.md is a convention until the first
 * hurried commit. This slice gives it three layers — the lint rule, this scan,
 * and `scripts/check-no-firestore.mjs` over the built bundle.
 */

/**
 * From the working directory, not from `import.meta.url`: this suite runs under
 * jsdom, where `import.meta.url` is an http URL and `fileURLToPath` refuses it.
 * Vitest's cwd is `frontend/`, which is what `npm --prefix frontend run test`
 * and the root `test:unit` both give it.
 */
const SRC = join(process.cwd(), 'src')

/**
 * Built by concatenation, and this file skips itself below.
 *
 * Both halves are needed for a scanner that does not trip on its own source —
 * otherwise the only way to write this test is to write it somewhere it cannot
 * see, which is worse.
 */
const NEEDLE = 'firebase' + '/firestore'

/**
 * Anchored on the quote that opens a module specifier, not on `from`.
 *
 * `from` only covers static imports and re-exports. A side-effect import, a
 * dynamic `import()` and a `require()` all name the module with no `from` in
 * sight, and each one puts the SDK in the bundle just as effectively — as do
 * the `/lite` subpath and `@firebase/firestore`, the implementation package
 * that `firebase/firestore` re-exports and that ESLint's pattern does not
 * match. The quote is what every one of them has in common.
 *
 * The optional `@` is what admits the scoped package without also admitting
 * `@/lib/firebase`, our own wrapper, which is the import every module here is
 * supposed to use. A bare mention in prose has no quote and does not match.
 * `FORMS` and `INNOCENT` below are that sentence as tests.
 */
const IMPORT = new RegExp(`['"]@?${NEEDLE.replace('/', '\\/')}`)

/** Every way the module can be named, as source a scanner has to catch. */
const FORMS: readonly (readonly [string, string])[] = [
  ['a named import', `import { doc } from '${NEEDLE}'`],
  ['a side-effect import', `import '${NEEDLE}'`],
  ['a dynamic import', `const mod = await import('${NEEDLE}')`],
  ['a require', `const mod = require('${NEEDLE}')`],
  ['a re-export', `export { doc } from '${NEEDLE}'`],
  ['a subpath', `import { doc } from '${NEEDLE}/lite'`],
  ['double quotes', `import { doc } from "${NEEDLE}"`],
  // `@firebase/firestore` is the implementation package `firebase/firestore`
  // re-exports. It resolves straight out of node_modules, and ESLint's
  // `firebase/firestore` pattern does not match it, so nothing but this scan
  // stands between it and the bundle.
  ['the scoped implementation package', `import { doc } from '@${NEEDLE}'`],
]

const INNOCENT: readonly (readonly [string, string])[] = [
  ['another Firebase product', `import { getAuth } from 'firebase/auth'`],
  ['our own wrapper', `import { auth } from '@/lib/firebase'`],
  ['a mention in prose', `// the ${NEEDLE} ban is absolute — see CLAUDE.md`],
]

/** Skipped so the scanner does not trip on its own source. */
const SELF = 'no-firestore.spec.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (entry.name === SELF) return []
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

describe('the scan itself', () => {
  /*
   * The scanner is tested before it is trusted.
   *
   * This layer exists to outlive the ESLint rule — someone editing the config,
   * disabling the rule for a line, adding an allowlist entry "just for now". A
   * scanner that catches less than the rule it is meant to outlive is worse
   * than no scanner, because `offenders).toEqual([])` reads as proof either
   * way. These cases are what "no import" has to mean for that to be true.
   */
  it.each(FORMS)('catches %s', (_label, source) => {
    expect(IMPORT.test(source)).toBe(true)
  })

  it.each(INNOCENT)('does not fire on %s', (_label, source) => {
    expect(IMPORT.test(source)).toBe(false)
  })
})

describe('the frontend source tree', () => {
  it('imports nothing from the Firestore client SDK', () => {
    // Reported by path, so a failure names the file rather than merely
    // asserting that one exists somewhere.
    const offenders = sourceFiles(SRC).filter((path) => IMPORT.test(readFileSync(path, 'utf8')))

    expect(offenders).toEqual([])
  })
})
