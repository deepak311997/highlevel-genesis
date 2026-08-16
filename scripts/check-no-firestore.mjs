#!/usr/bin/env node
/**
 * Assert the built frontend contains no Firestore SDK.
 *
 * The frontend never talks to Firestore: every read and write goes through a
 * Cloud Function route that verifies the ID token and scopes the query by the
 * uid inside it, and `firestore.rules` denies every client outright. That is
 * enforced in three places, and this is the last of them.
 *
 * The other two — the ESLint rule and the `frontend/src` source scan — read our
 * own code, so neither can see a *transitive* pull: a dependency that imports
 * Firestore on our behalf would put the SDK in the bundle with nothing in `src`
 * to point at. Only the built artefact can answer that, which is why this runs
 * in CI after `npm run build`.
 *
 *   node scripts/check-no-firestore.mjs [dir]     # default: frontend/dist
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Measured, not guessed.
 *
 * A bare `grep firestore` over `dist/` matches incidental identifiers and would
 * turn a security guarantee into a flaky one. This host name appears in the
 * bundle when — and only when — `@firebase/firestore` is bundled.
 */
export const MARKER = 'firestore.googleapis.com'

const DEFAULT_DIR = join('frontend', 'dist')

/** Paths, relative to `dir`, of every file whose bytes contain the marker. */
export function filesContainingMarker(dir) {
  /*
   * A missing directory is a failure, not a pass.
   *
   * Returning `[]` here would make the CI step report success loudest exactly
   * when the build did not run — a check that passes on the absence of evidence
   * is worse than no check, because it is believed.
   */
  let stats
  try {
    stats = statSync(dir)
  } catch {
    throw new Error(`${dir} does not exist. Run \`npm run build\` first.`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`${dir} is not a directory. Run \`npm run build\` first.`)
  }

  const walk = (current) =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const path = join(current, entry.name)
      if (entry.isDirectory()) return walk(path)
      // Read as bytes and search as latin1: a bundle is not guaranteed to be
      // valid UTF-8, and a decode error must not be mistaken for a clean file.
      return readFileSync(path).toString('latin1').includes(MARKER) ? [relative(dir, path)] : []
    })

  return walk(dir)
}

// Guarded so importing this module from the spec does not run the check.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? DEFAULT_DIR

  try {
    const hits = filesContainingMarker(dir)

    if (hits.length > 0) {
      console.error(`The Firestore SDK is in the bundle — "${MARKER}" found in:`)
      for (const hit of hits) console.error(`  ${hit}`)
      console.error(
        '\nThe frontend must reach Firestore only through a Cloud Function route.\n' +
          'See CLAUDE.md and docs/slices/02b-api-data-access/.',
      )
      process.exit(1)
    }

    console.log(`No Firestore SDK in ${dir} — "${MARKER}" not found.`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
