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
 * The text checks are pure functions over the README. The five that also need
 * to resolve something — `npm run` names against a package.json, paths against
 * the filesystem — take that resolver as an injectable argument. Either way
 * `check-readme.spec.mjs` can assert twice: once over a fixture that proves the
 * check can fail, and once over the real README that proves it passes today.
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

/**
 * Sentences and identifiers that would claim the browser talks to Firestore.
 *
 * The same ban `scripts/check-no-firestore.mjs` enforces over the built bundle
 * and `CLAUDE.md` states as a non-negotiable, one layer further out: over the
 * artefact that *describes* the architecture. The other two checks read code, so
 * neither can see the README claim client-side Firestore access while the code
 * does the opposite — which is exactly what happened. Decision #1 on `main` read
 * "the SPA subscribes to Firestore directly" for weeks after the API-only
 * decision reversed it, so that sentence is banned by name alongside the three
 * SDK calls it would be written with.
 */
export const FIRESTORE_CLAIMS = ['onSnapshot', 'getDoc', 'setDoc', 'subscribes to Firestore']

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

/**
 * Top-level list items — numbered, dashed or starred — with no leading
 * whitespace, so nested items and continuation lines do not count.
 *
 * Every marker, because the brief's caps are on *items* and a cap that only
 * sees `1. ` is a cap on one markdown syntax. Counting numbered lines alone,
 * the same section rewritten with dashes counted zero and both caps passed
 * silently — on fourteen decisions as readily as on none.
 */
export function topLevelItemCount(body) {
  return body.split('\n').filter((line) => /^(?:\d+\.|[-*])\s/.test(line)).length
}

/** Readable problems: a required section absent, or a capped list over its cap. */
export function sectionProblems(text) {
  const headings = sectionsOf(text)

  const missing = REQUIRED_SECTIONS.filter((heading) => !headings.includes(heading)).map(
    (heading) => `missing section: ## ${heading}`,
  )

  const over = Object.entries(BULLET_CAPS).flatMap(([heading, cap]) => {
    const count = topLevelItemCount(sectionBody(text, heading))
    return count > cap ? [`${heading}: ${String(count)} items, cap is ${String(cap)}`] : []
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

/**
 * The live URLs, derived from `.firebaserc` and `firebase.json`.
 *
 * Derived, not matched literally, because the project id is committed in exactly
 * one place — `.firebaserc` — and the deploy, the OAuth redirect URI and these
 * two URLs all descend from it. A test that compared the README against a string
 * written into the test would pass forever: rename the project and the check
 * still agrees with itself while every link in the file is dead. Reading the
 * same file the deploy reads is what makes the README's Live URLs table a
 * consequence of the configuration rather than a claim about it.
 *
 * Throws unless the rewrites name exactly one region. Picking the first would be
 * a guess about which function a reader will call, and a base URL that is right
 * for one of two functions is not a base URL.
 */
export function liveUrls(firebasercText, firebaseJsonText) {
  const project = JSON.parse(firebasercText).projects?.default
  if (typeof project !== 'string' || project === '') {
    throw new Error('.firebaserc names no default project')
  }

  const regions = [
    ...new Set(
      (JSON.parse(firebaseJsonText).hosting?.rewrites ?? [])
        .map((rewrite) => rewrite.function?.region)
        .filter((region) => typeof region === 'string'),
    ),
  ]

  if (regions.length !== 1) {
    throw new Error(
      `firebase.json's hosting rewrites must pin exactly one region, found ${String(regions.length)}: ${regions.join(', ')}`,
    )
  }

  const [region] = regions

  return {
    project,
    region,
    hosting: `https://${project}.web.app`,
    functionsBase: `https://${region}-${project}.cloudfunctions.net`,
  }
}

/** Derived URLs the README's Live URLs section does not carry (AC-7). */
export function liveUrlProblems(text, firebasercText, firebaseJsonText) {
  const { hosting, functionsBase } = liveUrls(firebasercText, firebaseJsonText)
  const body = sectionBody(text, 'Live URLs')

  return [hosting, functionsBase]
    .filter((url) => !body.includes(url))
    .map((url) => `Live URLs: does not carry ${url}`)
}

/** The command a package.json declares for a script. `''` if there is none. */
export function scriptCommand(prefix, script, root = ROOT) {
  const path = join(root, prefix ?? '.', 'package.json')
  if (!existsSync(path)) return ''

  const { scripts } = JSON.parse(readFileSync(path, 'utf8'))

  return scripts?.[script] ?? ''
}

/**
 * Ways the local-setup section stops being runnable from a fresh clone (AC-8).
 *
 * Two halves, because the brief names the emulator explicitly and the README
 * tells a reader to type something else. The section must name
 * `firebase emulators:start`, and the command it does tell them to type —
 * `npm run dev` — must still be the one that wraps the emulators. Checking only
 * the prose would let the `dev` script quietly become plain `vite` and leave the
 * README describing an emulator that no longer starts.
 */
export function localSetupProblems(text, command = scriptCommand) {
  const body = sectionBody(text, 'Local setup')

  const named = ['firebase emulators:start', 'npm run dev']
    .filter((phrase) => !body.includes(phrase))
    .map((phrase) => `Local setup: does not name \`${phrase}\``)

  const wrapped = command(null, 'dev').includes('emulators:exec')
    ? []
    : ['the root `dev` script no longer contains `emulators:exec`']

  return [...named, ...wrapped]
}

/** Which banned claims the text makes, in the order `FIRESTORE_CLAIMS` bans them. */
export function firestoreClaims(text) {
  return FIRESTORE_CLAIMS.filter((claim) => text.includes(claim))
}

// Guarded so importing this module from the spec does not run the check.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const text = readFileSync(README, 'utf8')
    const firebasercText = readFileSync(join(ROOT, '.firebaserc'), 'utf8')
    const firebaseJsonText = readFileSync(join(ROOT, 'firebase.json'), 'utf8')
    const urls = liveUrls(firebasercText, firebaseJsonText)

    const problems = [
      ...sectionProblems(text),
      ...unresolvedNpmScripts(text).map(
        ({ script, prefix }) =>
          `npm ${prefix === null ? '' : `--prefix ${prefix} `}run ${script} — no such script in ${prefix ?? 'the root'} package.json`,
      ),
      ...missingPaths(text).map((path) => `${path} — named in the README, not on disk`),
      ...liveUrlProblems(text, firebasercText, firebaseJsonText),
      ...localSetupProblems(text),
      ...firestoreClaims(text).map(
        (claim) => `"${claim}" — the README must not claim client-side Firestore access`,
      ),
    ]

    if (problems.length > 0) {
      console.error('README.md:')
      for (const problem of problems) console.error(`  ${problem}`)
      console.error('\nSee docs/slices/13-deliverables/02-prd.md, AC-3 … AC-10.')
      process.exit(1)
    }

    const decisions = topLevelItemCount(sectionBody(text, 'Architecture decisions'))
    const improvements = topLevelItemCount(sectionBody(text, 'What I would improve'))

    console.log(
      `README.md — all ${String(REQUIRED_SECTIONS.length)} required sections; ` +
        `${String(decisions)} architecture decisions (cap 10), ` +
        `${String(improvements)} improvements (cap 5).`,
    )
    console.log(
      `README.md — ${String(npmScriptsNamed(text).length)} \`npm run\` commands resolve; ` +
        `${String(pathsNamed(text).length)} referenced paths exist.`,
    )
    console.log(
      `README.md — live URLs derived from .firebaserc + firebase.json: ${urls.hosting} and ${urls.functionsBase}.`,
    )
    console.log(
      'README.md — local setup names `firebase emulators:start`, the root `dev` script ' +
        'wraps `emulators:exec`, and nothing claims client-side Firestore access.',
    )
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
