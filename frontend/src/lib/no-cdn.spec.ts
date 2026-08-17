import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * AC-25's second half — **nothing is fetched from a CDN at runtime** (D2).
 *
 * `@guolao/vue-monaco-editor`'s default is `@monaco-editor/loader` pulling monaco
 * off jsDelivr over AMD. That would make `npm run dev` on the emulators require
 * the internet from a fresh clone — which the brief names explicitly as a
 * deliverable — put a third party in the e2e suite's critical path, and force a
 * CSP allowlist entry in Slice 13. `monacoSetup.ts` hands the loader our own
 * imported instance instead, and its sibling spec asserts that call.
 *
 * This is the other half: the assertion that nobody reintroduces the CDN by hand
 * — a `paths: { vs: … }` config, a `<script src>`, a bare URL in a string. In
 * `no-firestore.spec.ts`'s exact shape, for its reasons: needles built by
 * concatenation, a self-skip, and the scanner tested before it is trusted.
 */

/**
 * From the working directory, not from `import.meta.url`: this suite runs under
 * jsdom, where `import.meta.url` is an http URL and `fileURLToPath` refuses it.
 * Vitest's cwd is `frontend/`.
 */
const SRC = join(process.cwd(), 'src')

/**
 * Built by concatenation, and this file skips itself below.
 *
 * Both halves are needed for a scanner that does not trip on its own source —
 * otherwise the only way to write this test is to write it somewhere it cannot
 * see, which is worse.
 */
const HOSTS = ['cdn.' + 'jsdelivr.net', 'unpkg' + '.com', 'cdnjs.' + 'cloudflare.com']

/** Every way a CDN host can reach the running app, as source a scanner has to catch. */
const FORMS: readonly (readonly [string, string])[] = [
  ['a loader paths config', `loader.config({ paths: { vs: 'https://${HOSTS[0]}/npm/monaco' } })`],
  ['a script src', `script.src = '//${HOSTS[1]}/monaco-editor/min/vs/loader.js'`],
  ['a bare URL in a string', `const base = "https://${HOSTS[2]}/ajax/libs/monaco-editor"`],
  ['a protocol-relative host', `const vs = '//${HOSTS[0]}/npm/monaco-editor@0.52.2/min/vs'`],
]

/**
 * What must **not** fire, or the scan would be unmaintainable.
 *
 * `@monaco-editor/loader` is the package the wrapper re-exports and the thing we
 * configure; naming it is the fix, not the offence. And a host named in prose —
 * this file's own doc comment says "jsDelivr" — is a sentence, not a fetch.
 */
const INNOCENT: readonly (readonly [string, string])[] = [
  ['the loader package itself', `import { loader } from '@monaco-editor/loader'`],
  ['the wrapper', `import { loader } from '@guolao/vue-monaco-editor'`],
  ['a host named in prose', `// the default pulls monaco off jsDelivr — see D2`],
]

/** Skipped so the scanner does not trip on its own source. */
const SELF = 'no-cdn.spec.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (entry.name === SELF) return []
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

function hits(source: string): string[] {
  return HOSTS.filter((host) => source.includes(host))
}

describe('the scan itself', () => {
  /*
   * The scanner is tested before it is trusted, `no-firestore.spec.ts`'s rule.
   * `offenders).toEqual([])` reads as proof whether the scanner catches
   * everything or nothing, so these cases are what "no CDN" has to mean for that
   * line to be worth anything.
   */
  it.each(FORMS)('catches %s', (_label, source) => {
    expect(hits(source)).not.toEqual([])
  })

  it.each(INNOCENT)('does not fire on %s', (_label, source) => {
    expect(hits(source)).toEqual([])
  })
})

describe('the frontend source tree', () => {
  it('names no CDN host anywhere under src', () => {
    // Reported by path, so a failure names the file rather than merely asserting
    // that one exists somewhere.
    const offenders = sourceFiles(SRC).filter((path) => hits(readFileSync(path, 'utf8')).length > 0)

    expect(offenders).toEqual([])
  })
})
