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
import { existsSync, readFileSync } from 'node:fs'
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

/** Top-level directories a repo-relative path reference may start with. */
export const PATH_ROOTS = ['scripts', 'docs', 'functions', 'frontend', 'tests', 'brand']

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

/**
 * Every `npm [--prefix P] run X` named anywhere in the text, fences included.
 *
 * Fences included on purpose: a command inside a ```bash block is the one a
 * reader copies, so it is the one most worth checking.
 */
export function npmScriptsNamed(text) {
  const pattern = /npm\s+(?:--prefix\s+(\S+)\s+)?run\s+([\w:.\-]+)/g

  return [...text.matchAll(pattern)].map((match) => ({
    script: match[2],
    prefix: match[1] ?? null,
  }))
}

/** Scripts declared by a package.json. `prefix` null => the root package. */
export function scriptsOf(prefix, root = ROOT) {
  const path = join(root, prefix ?? '.', 'package.json')
  if (!existsSync(path)) return []

  const { scripts } = JSON.parse(readFileSync(path, 'utf8'))

  return Object.keys(scripts ?? {})
}

/**
 * Those that do not resolve, under the prefix-aware rule.
 *
 * A bare `npm run X` resolves against the **root** package alone; `npm --prefix
 * P run X` against P's. That distinction is the whole check. AC-3's own failing
 * example is `npm run dev:emulator`, which the README on `main` told a reader to
 * type at the repo root — and `dev:emulator` does exist, in
 * `frontend/package.json`. Under a rule that pooled all three package files it
 * would resolve, and the line that actually broke a fresh clone would pass. The
 * prefix is not decoration; it is which package.json the command reaches.
 */
export function unresolvedNpmScripts(text, resolve = scriptsOf) {
  return npmScriptsNamed(text).filter(({ script, prefix }) => !resolve(prefix).includes(script))
}

/**
 * Markdown link targets plus `<root>/…` tokens anywhere in the text. Deduped.
 *
 * Two passes, because the README names a path in two ways and both have gone
 * stale in the past: as a link a reader clicks, and as a filename in prose or in
 * a fenced command a reader types.
 *
 * Known limitation, recorded rather than papered over: a **bare root filename
 * with no slash** is only seen when it is a markdown link target. `CLAUDE.md` is
 * checked, because the README links it; `firestore.rules`, named in the
 * repository-layout block as prose, is not. Widening the token pass to every
 * `word.ext` would match version numbers, `2021-07-28`, `package.json` inside a
 * sentence about npm, and every `.env` variable — noise that would get the check
 * switched off. The roots are the boundary that keeps it quiet enough to keep.
 */
export function pathsNamed(text) {
  const linked = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1].split('#')[0])
    .filter(
      (target) => target !== '' && !target.startsWith('/') && !/^(?:https?|mailto):/.test(target),
    )

  const tokens = [
    ...text.matchAll(
      new RegExp(String.raw`(?<![\w/.-])(?:${PATH_ROOTS.join('|')})\/[\w./*-]*`, 'g'),
    ),
  ].map((match) => match[0])

  const trimmed = [...linked, ...tokens].map((path) => path.replace(/[`.,;:!?*)\]}'"]+$/, ''))

  return [...new Set(trimmed.filter((path) => path !== ''))]
}

/** Those `pathsNamed` returns that are not on disk. */
export function missingPaths(text, exists = (path) => existsSync(join(ROOT, path))) {
  return pathsNamed(text).filter((path) => !exists(path))
}
