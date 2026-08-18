import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * AC-3 — **the placeholder pulse lives in exactly one component**.
 *
 * Before Slice 12 the app had nineteen hand-rolled copies of the same three
 * utilities spread across ten components, and they had drifted: five used
 * `rounded`, five `rounded-md`, and the heights were guessed per site. That is
 * what the audit found, and `Skeleton` is the fix. This is what keeps it fixed —
 * without a scan, the twentieth copy is one convenient `<div class="…">` away
 * and nothing fails.
 *
 * In `no-cdn.spec.ts`'s exact shape, for its reasons: the needle is built by
 * concatenation, the file skips itself, offenders are reported by path so a
 * failure names the file, and the scanner is tested before it is trusted.
 *
 * Read from the working directory rather than from `import.meta.url`, which is
 * `no-firestore.spec.ts`'s rule and for its reason: this suite runs under jsdom,
 * where `import.meta.url` is an http URL that `fileURLToPath` refuses. Vitest's
 * cwd is `frontend/`.
 */

const SRC = join(process.cwd(), 'src')

/**
 * Built by concatenation, and this file skips itself below.
 *
 * Both halves are needed for a scanner that does not trip on its own source —
 * otherwise the only way to write this test is to write it somewhere it cannot
 * see, which is worse.
 */
const NEEDLE = 'animate-' + 'pulse'

/** The one directory the utility is allowed to appear in. */
const ALLOWED = join('components', 'ui', 'skeleton') + sep

/** Every way a hand-rolled placeholder can come back, as source a scan has to catch. */
const FORMS: readonly (readonly [string, string])[] = [
  ['a bare placeholder div', `<div class="h-5 w-48 ${NEEDLE} rounded bg-secondary" />`],
  ['one hidden in a v-for', `<div v-for="n in 3" :key="n" class="h-5 ${NEEDLE} rounded" />`],
  ['a bound class expression', `:class="['h-4', loading && '${NEEDLE}']"`],
  ['a class in a .ts constant', `const PLACEHOLDER = 'h-6 w-2/3 ${NEEDLE} rounded-md'`],
]

/**
 * What must **not** fire, or the scan would be unmaintainable.
 *
 * `Skeleton` is the fix, so naming it — or naming the rule in prose, as this
 * file's own doc comment does — is not the offence.
 */
const INNOCENT: readonly (readonly [string, string])[] = [
  ['the primitive itself', `import { Skeleton } from '@/components/ui/skeleton'`],
  ['a call site', `<Skeleton class="h-5 w-48 rounded" />`],
  ['a different animation', `<div class="animate-spin rounded-full border-2" />`],
]

/** Skipped so the scanner does not trip on its own source. */
const SELF = 'no-pulse.spec.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (entry.name === SELF) return []
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

function offends(path: string): boolean {
  if (path.includes(ALLOWED)) return false
  return readFileSync(path, 'utf8').includes(NEEDLE)
}

describe('the scan itself', () => {
  /*
   * The scanner is tested before it is trusted, `no-firestore.spec.ts`'s rule.
   * `offenders).toEqual([])` reads as proof whether the scanner catches
   * everything or nothing, so these cases are what "one placeholder" has to mean
   * for that line to be worth anything.
   */
  it.each(FORMS)('catches %s', (_label, source) => {
    expect(source.includes(NEEDLE)).toBe(true)
  })

  it.each(INNOCENT)('does not fire on %s', (_label, source) => {
    expect(source.includes(NEEDLE)).toBe(false)
  })
})

describe('the frontend source tree', () => {
  it('pulses in no file outside components/ui/skeleton', () => {
    // Reported by path, so a failure names the files rather than merely
    // asserting that one exists somewhere.
    const offenders = sourceFiles(SRC).filter(offends)

    expect(offenders).toEqual([])
  })
})
