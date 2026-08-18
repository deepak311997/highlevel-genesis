#!/usr/bin/env node
/**
 * Assert the README still says what is true.
 *
 * The README is the one artefact this project is graded on directly, and the one
 * artefact nothing else in the repository reads — which is how the version on
 * `main` came to name two scripts that do not exist, a root `npm run` script
 * that does not exist, live URLs described as "not deployed yet" long after both
 * answered `200`, and an architecture decision the project had already reversed.
 *
 * Prose quality stays a review judgement. Every *mechanical* claim the file
 * makes is checked here:
 *
 *   - the seven brief-named sections are present (AC-5), and the two capped
 *     lists stay inside their caps (AC-6);
 *   - every `npm run` it tells a reader to type resolves (AC-3);
 *   - every repo-relative path it names exists on disk (AC-4);
 *   - the live URLs are the ones `.firebaserc` and `firebase.json` imply (AC-7);
 *   - local setup names the emulator (AC-8);
 *   - it claims no client-side Firestore access anywhere (AC-10).
 *
 * Everything is a pure function over text, so `check-readme.spec.mjs` can assert
 * twice: once over a fixture that proves the check can fail, and once over the
 * real README that proves it passes today.
 *
 *   node scripts/check-readme.mjs
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Repo root, resolved from this file so the checks work from any cwd. */
export const ROOT = join(import.meta.dirname, '..')

export const README = join(ROOT, 'README.md')

/** The seven sections the brief names, by the heading text they must carry. */
export const REQUIRED_SECTIONS = [
  'Live URLs',
  'Local setup',
  'HighLevel setup',
  'Architecture decisions',
  'What I would improve',
  'Deployment',
  'Repository layout',
]

/** The brief's two hard caps, by section. */
export const BULLET_CAPS = { 'Architecture decisions': 10, 'What I would improve': 5 }

/** The `## ` headings, in document order. */
export function sectionsOf(text) {
  return [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim())
}

/**
 * Everything from `## <heading>` up to the next `## `. `''` if absent.
 *
 * The one place a heading is sliced. Every check that reads a section reads it
 * through here, so "which lines belong to Local setup?" has exactly one answer
 * and `### ` subsections stay with their parent.
 */
export function sectionBody(text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`)
  if (start === -1) return ''

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))

  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n')
}

/** Lines matching /^\d+\.\s/ with no leading whitespace — top-level items only. */
export function orderedItemCount(body) {
  return body.split('\n').filter((line) => /^\d+\.\s/.test(line)).length
}

/** Readable problems: a required section absent, or a capped list over its cap. */
export function sectionProblems(text) {
  const headings = sectionsOf(text)

  const missing = REQUIRED_SECTIONS.filter((heading) => !headings.includes(heading)).map(
    (heading) => `missing section: ## ${heading}`,
  )

  const over = Object.entries(BULLET_CAPS).flatMap(([heading, cap]) => {
    const count = orderedItemCount(sectionBody(text, heading))
    return count > cap ? [`${heading}: ${String(count)} numbered items, cap is ${String(cap)}`] : []
  })

  return [...missing, ...over]
}
