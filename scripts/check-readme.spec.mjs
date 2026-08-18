import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BULLET_CAPS,
  FIRESTORE_CLAIMS,
  README,
  REQUIRED_SECTIONS,
  ROOT,
  firestoreClaims,
  liveUrlProblems,
  liveUrls,
  localSetupProblems,
  missingPaths,
  npmScriptsNamed,
  topLevelItemCount,
  pathsNamed,
  scriptCommand,
  scriptsOf,
  sectionBody,
  sectionProblems,
  sectionsOf,
  unresolvedNpmScripts,
} from './check-readme.mjs'

/**
 * AC-3 … AC-8 and AC-10 — the README, held true by a test.
 *
 * The README is the one artefact this assignment is graded on directly, and it is the one
 * artefact nothing else in the repository reads. That is how the file on `main` came to name two
 * scripts that do not exist, a root `npm run` script that does not exist, live URLs that were
 * "not deployed yet" months after they answered `200`, and an architecture decision the project
 * had already reversed. Every one of those is a mechanical claim, and a mechanical claim can be
 * checked.
 */

const readme = readFileSync(README, 'utf8')
const firebaserc = readFileSync(join(ROOT, '.firebaserc'), 'utf8')
const firebaseJson = readFileSync(join(ROOT, 'firebase.json'), 'utf8')

/** A README-shaped document: every required section, with the given bodies. */
function readmeFixture(bodies = {}) {
  return REQUIRED_SECTIONS.map((heading) => `## ${heading}\n\n${bodies[heading] ?? 'Prose.\n'}`)
    .join('\n')
    .concat('\n')
}

/** `n` top-level numbered items, as a section body. */
const numbered = (n) =>
  Array.from({ length: n }, (_, index) => `${String(index + 1)}. Item ${String(index + 1)}.`).join(
    '\n',
  )

describe('sectionsOf', () => {
  it('returns the `## ` headings in document order, ignoring deeper levels', () => {
    const text = ['# Title', '', '## First', '', '### Not a section', '', '## Second', ''].join(
      '\n',
    )

    expect(sectionsOf(text)).toEqual(['First', 'Second'])
  })
})

describe('sectionBody', () => {
  it('runs from the heading to the next `## `, keeping `###` subsections', () => {
    const text = ['## First', 'a', '', '### Sub', 'b', '', '## Second', 'c', ''].join('\n')

    expect(sectionBody(text, 'First')).toContain('### Sub')
    expect(sectionBody(text, 'First')).not.toContain('c')
    expect(sectionBody(text, 'Absent')).toBe('')
  })
})

describe('topLevelItemCount', () => {
  it('counts only top-level `1. ` lines, not indented or continuation ones', () => {
    const body = ['1. One', '   1. Nested', '   continued', '2. Two', 'prose 3. not an item'].join(
      '\n',
    )

    expect(topLevelItemCount(body)).toBe(2)
  })

  /* The brief's caps are on *items*, not on a markdown syntax. Counting `1. */
  it('counts dashed and starred items the same way', () => {
    const body = ['- One', '* Two', '  - Nested', 'prose - not an item'].join('\n')

    expect(topLevelItemCount(body)).toBe(2)
  })
})

describe('required sections — AC-5', () => {
  it('the real README carries all seven brief-named sections', () => {
    expect(sectionsOf(readme)).toEqual(expect.arrayContaining([...REQUIRED_SECTIONS]))
  })

  it('names the section a README is missing', () => {
    const fixture = readmeFixture().replace('## Deployment\n\nProse.\n', '')

    expect(sectionProblems(fixture)).toEqual(['missing section: ## Deployment'])
  })
})

describe('bullet caps — AC-6', () => {
  it('the real README stays inside both caps', () => {
    for (const [heading, cap] of Object.entries(BULLET_CAPS)) {
      const count = topLevelItemCount(sectionBody(readme, heading))
      expect(count).toBeLessThanOrEqual(cap)
      expect(count).toBeGreaterThan(0)
    }

    expect(sectionProblems(readme)).toEqual([])
  })

  it('names the section and the count when an eleventh decision is added', () => {
    const fixture = readmeFixture({ 'Architecture decisions': numbered(11) })

    expect(sectionProblems(fixture)).toEqual(['Architecture decisions: 11 items, cap is 10'])
  })

  it('names the section and the count when a sixth improvement is added', () => {
    const fixture = readmeFixture({ 'What I would improve': numbered(6) })

    expect(sectionProblems(fixture)).toEqual(['What I would improve: 6 items, cap is 5'])
  })

  it('holds a dash-bulleted list to the same cap as a numbered one', () => {
    const bulleted = Array.from({ length: 14 }, (_, i) => `- Decision ${String(i + 1)}.`).join('\n')
    const fixture = readmeFixture({ 'Architecture decisions': bulleted })

    expect(sectionProblems(fixture)).toEqual(['Architecture decisions: 14 items, cap is 10'])
  })
})

describe('npmScriptsNamed', () => {
  it('reads the script and its `--prefix`, inside fences and in prose alike', () => {
    const text = [
      '```bash',
      'npm run install:all      # root + frontend + functions',
      'npm --prefix frontend run dev:emulator',
      '```',
      '',
      'Run `npm run test:e2e` afterwards. `npm test` is not an `npm run`.',
    ].join('\n')

    expect(npmScriptsNamed(text)).toEqual([
      { script: 'install:all', prefix: null },
      { script: 'dev:emulator', prefix: 'frontend' },
      { script: 'test:e2e', prefix: null },
    ])
  })
})

describe('scriptsOf', () => {
  it('reads the root package when there is no prefix, and the prefixed one otherwise', () => {
    expect(scriptsOf(null)).toContain('install:all')
    expect(scriptsOf(null)).not.toContain('dev:emulator')
    expect(scriptsOf('frontend')).toContain('dev:emulator')
  })

  it('is empty for a prefix with no package.json, so the script cannot resolve', () => {
    expect(scriptsOf('nope')).toEqual([])
  })
})

describe('npm run resolution — AC-3', () => {
  it('every `npm run` the real README names resolves', () => {
    expect(unresolvedNpmScripts(readme)).toEqual([])
  })

  it("reports `npm run dev:emulator` at the root — the brief's own failing example", () => {
    const fixture = 'Then run `npm run dev:emulator` in a second terminal.\n'

    expect(unresolvedNpmScripts(fixture)).toEqual([{ script: 'dev:emulator', prefix: null }])
  })

  it('accepts the same script under `npm --prefix frontend`', () => {
    const fixture = 'Then run `npm --prefix frontend run dev:emulator` in a second terminal.\n'

    expect(unresolvedNpmScripts(fixture)).toEqual([])
  })
})

describe('pathsNamed', () => {
  it('takes markdown link targets, less the fragment, and skips URLs and anchors', () => {
    const text = [
      '[plan](docs/IMPLEMENTATION_PLAN.md)',
      '[section](CLAUDE.md#conventions)',
      '[out](https://example.com/a/b)',
      '[mail](mailto:someone@example.com)',
      '[anchor](#live-urls)',
      '[route](/api/health)',
    ].join('\n')

    expect(pathsNamed(text)).toEqual(['docs/IMPLEMENTATION_PLAN.md', 'CLAUDE.md'])
  })

  it('takes bare `<root>/…` tokens, trimming backticks and trailing punctuation', () => {
    const text = [
      'It calls `scripts/seed-sandbox.mjs`, then reads docs/PRODUCT_SPEC.md.',
      '<img src="frontend/public/genesis-mark.svg" alt="">',
      'Fixtures live in `tests/fixtures/`.',
    ].join('\n')

    expect(pathsNamed(text)).toEqual([
      'scripts/seed-sandbox.mjs',
      'docs/PRODUCT_SPEC.md',
      'frontend/public/genesis-mark.svg',
      'tests/fixtures/',
    ])
  })

  it('deduplicates the link target and the inline-code copy of the same path', () => {
    expect(pathsNamed('[`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md)')).toEqual([
      'docs/PRODUCT_SPEC.md',
    ])
  })
})

describe('path existence — AC-4', () => {
  it('every path the real README names exists on disk', () => {
    expect(missingPaths(readme)).toEqual([])
  })

  /*
   * A file that is gitignored *by design* still deserves to be named in the README —
   * `functions/.secret.local` is where a local Anthropic key goes, and a setup guide that cannot
   * say so is not a setup guide.
   */
  it('accepts a gitignored path whose committed .example exists', () => {
    const exists = (path) => path === 'functions/.secret.local.example'

    expect(missingPaths('Put a key in `functions/.secret.local`.', exists)).toEqual([])
  })

  it('still reports a missing path that has no .example beside it', () => {
    const exists = () => false

    expect(missingPaths('See `functions/.secret.typo`.', exists)).toEqual([
      'functions/.secret.typo',
    ])
  })

  it('reports a script that no longer exists', () => {
    const fixture = 'Run `node scripts/set-verified.mjs <email>` to skip the gate.\n'

    expect(missingPaths(fixture)).toEqual(['scripts/set-verified.mjs'])
  })

  it('reports a markdown link to a document that is not there', () => {
    expect(missingPaths('See [the notes](docs/nope.md).\n')).toEqual(['docs/nope.md'])
  })

  it('reports nothing for an external URL, an anchor, or an API route', () => {
    const fixture = [
      '[out](https://example.com/a/b)',
      '[anchor](#anchor)',
      '[health](/api/health)',
    ].join('\n')

    expect(missingPaths(fixture)).toEqual([])
  })
})

describe('liveUrls', () => {
  it('derives both URLs from the real `.firebaserc` and `firebase.json`', () => {
    expect(liveUrls(firebaserc, firebaseJson)).toEqual({
      project: 'hl-genesis-app',
      region: 'asia-south1',
      hosting: 'https://hl-genesis-app.web.app',
      functionsBase: 'https://asia-south1-hl-genesis-app.cloudfunctions.net',
    })
  })

  it('throws when the rewrites name two regions, rather than picking one', () => {
    const twoRegions = JSON.stringify({
      hosting: {
        rewrites: [
          { source: '/api/**', function: { functionId: 'api', region: 'asia-south1' } },
          { source: '/generate', function: { functionId: 'generate', region: 'us-central1' } },
        ],
      },
    })

    expect(() => liveUrls(firebaserc, twoRegions)).toThrow(/asia-south1.*us-central1/s)
  })
})

describe('live URLs are derived — AC-7', () => {
  it('the real README carries both derived URLs in its Live URLs section', () => {
    const { hosting, functionsBase } = liveUrls(firebaserc, firebaseJson)

    expect(sectionBody(readme, 'Live URLs')).toContain(hosting)
    expect(sectionBody(readme, 'Live URLs')).toContain(functionsBase)
    expect(liveUrlProblems(readme, firebaserc, firebaseJson)).toEqual([])
  })

  it('fails when `.firebaserc` alone names a different project', () => {
    const renamed = JSON.stringify({ projects: { default: 'other-project' } })

    expect(liveUrlProblems(readme, renamed, firebaseJson)).toEqual([
      'Live URLs: does not carry https://other-project.web.app',
      'Live URLs: does not carry https://asia-south1-other-project.cloudfunctions.net',
    ])
  })
})

describe('scriptCommand', () => {
  it('returns what the root package.json declares for a script', () => {
    expect(scriptCommand(null, 'dev')).toContain('emulators:exec')
    expect(scriptCommand(null, 'nope')).toBe('')
  })
})

describe('local setup names the emulator — AC-8', () => {
  it('the real README names `firebase emulators:start` and `npm run dev`', () => {
    expect(sectionBody(readme, 'Local setup')).toContain('firebase emulators:start')
    expect(sectionBody(readme, 'Local setup')).toContain('npm run dev')
    expect(localSetupProblems(readme)).toEqual([])
  })

  it('fails when local setup never names the emulator', () => {
    const fixture = readmeFixture({ 'Local setup': 'Run `npm run dev` and open the app.\n' })

    expect(localSetupProblems(fixture)).toEqual([
      'Local setup: does not name `firebase emulators:start`',
    ])
  })

  it('fails when the root `dev` script stops wrapping the emulators', () => {
    const command = () => 'vite'

    expect(localSetupProblems(readme, command)).toEqual([
      'the root `dev` script no longer contains `emulators:exec`',
    ])
  })
})

describe('no claim of client-side Firestore — AC-10', () => {
  it('bans the three SDK calls and the sentence that described the old design', () => {
    expect(FIRESTORE_CLAIMS).toEqual(['onSnapshot', 'getDoc', 'setDoc', 'subscribes to Firestore'])
  })

  it('the real README makes none of them', () => {
    expect(firestoreClaims(readme)).toEqual([])
  })

  it('reports an SDK call named in prose', () => {
    const fixture = 'Live updates come from an `onSnapshot` listener on the files collection.\n'

    expect(firestoreClaims(fixture)).toEqual(['onSnapshot'])
  })

  it('reports the architecture decision the README carried on `main`', () => {
    const fixture = '1. **The SPA subscribes to Firestore directly**, with rules as the guard.\n'

    expect(firestoreClaims(fixture)).toEqual(['subscribes to Firestore'])
  })

  it('reports every claim a fixture makes, not just the first', () => {
    const fixture = 'The store calls `getDoc` and `setDoc` directly.\n'

    expect(firestoreClaims(fixture)).toEqual(['getDoc', 'setDoc'])
  })
})
