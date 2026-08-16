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
const IMPORT = new RegExp(`from\\s+['"]${NEEDLE.replace('/', '\\/')}`)

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

describe('the frontend source tree', () => {
  it('imports nothing from the Firestore client SDK', () => {
    // Reported by path, so a failure names the file rather than merely
    // asserting that one exists somewhere.
    const offenders = sourceFiles(SRC).filter((path) => IMPORT.test(readFileSync(path, 'utf8')))

    expect(offenders).toEqual([])
  })
})
