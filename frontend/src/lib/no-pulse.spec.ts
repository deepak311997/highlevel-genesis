import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * AC-3 — **the placeholder pulse lives in exactly one component**.
 *
 * Before Slice 12 the app had nineteen hand-rolled copies of the same three utilities spread
 * across ten components, and they had drifted: five used `rounded`, five `rounded-md`, and the
 * heights were guessed per site. That is what the audit found, and `Skeleton` is the fix. This
 * is what keeps it fixed — without a scan, the twentieth copy is one convenient `<div
 * class="…">` away and nothing fails.
 */

const SRC = join(process.cwd(), 'src')

/**
 * Built by concatenation, and this file skips itself below.
 *
 * Both halves are needed for a scanner that does not trip on its own source — otherwise the only
 * way to write this test is to write it somewhere it cannot see, which is worse.
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
    // `.css` as well as `.ts`/`.vue`: `@apply animate-pulse` in a stylesheet is
    // the same twentieth copy by another route, and `style.css` is under `src`.
    return /\.(ts|vue|css)$/.test(entry.name) ? [path] : []
  })
}

/**
 * The needle half of the scan, on source text.
 *
 * Split out from {@link offends} so the cases below can exercise the predicate
 * the tree walk actually uses. Asserting `source.includes(NEEDLE)` inline
 * instead would be a tautology — the fixtures are built by interpolating
 * `NEEDLE` — and a tautology proves nothing about the scanner it is standing in
 * for. `no-cdn.spec.ts` calls its own `hits()` here for the same reason.
 */
function pulses(source: string): boolean {
  return source.includes(NEEDLE)
}

/** The exemption half: the one directory the utility may appear in. */
function exempt(path: string): boolean {
  return path.includes(ALLOWED)
}

function offends(path: string): boolean {
  if (exempt(path)) return false
  return pulses(readFileSync(path, 'utf8'))
}

describe('the scan itself', () => {
  /* The scanner is tested before it is trusted, `no-firestore.spec.ts`'s rule. */
  it.each(FORMS)('catches %s', (_label, source) => {
    expect(pulses(source)).toBe(true)
  })

  it.each(INNOCENT)('does not fire on %s', (_label, source) => {
    expect(pulses(source)).toBe(false)
  })

  /* The exemption is the other half of `offends`, and the half that could
   * silently widen: a mistake here excuses a whole directory rather than one
   * file. */
  it('exempts the primitive’s own directory and nothing else', () => {
    expect(exempt(join(SRC, 'components', 'ui', 'skeleton', 'Skeleton.vue'))).toBe(true)
    expect(exempt(join(SRC, 'components', 'ui', 'alert', 'Alert.vue'))).toBe(false)
    expect(exempt(join(SRC, 'components', 'workspace', 'FileTree.vue'))).toBe(false)
  })
})

describe('the frontend source tree', () => {
  it('pulses in no file outside components/ui/skeleton', () => {
    // Reported by path, so a failure names the files rather than merely
    // asserting that one exists somewhere.
    const scanned = sourceFiles(SRC)

    // A walk that found nothing would make the assertion below pass without
    // having read a line — the one way this scan can be green and worthless.
    expect(scanned.length).toBeGreaterThan(50)

    expect(scanned.filter(offends)).toEqual([])
  })
})
