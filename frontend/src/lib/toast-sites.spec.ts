import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * AC-6, D4 — **a toast may carry only the transient outcome of an action the
 * user just took, that leaves nothing on screen to read.**
 *
 * Every failure in this app stays in the inline surface it already has. An
 * error that vanishes after four seconds is an error the user cannot act on:
 * they cannot re-read it, cannot copy it, and cannot find it again once it has
 * gone — and this app's failures all have somewhere to live already, next to
 * the thing that failed and with the retry that answers them. That is why
 * adopting the toast library was a two-call-site change rather than a rewrite
 * of eighteen error surfaces.
 *
 * This scan is what makes that a rule rather than a habit, and it is strictly
 * stronger than a per-component "no notice was raised" assertion: those prove
 * that three known surfaces stay quiet, while this proves a **third call site
 * cannot exist at all**. The next person who reaches for a transient error gets
 * this file, and the sentence above, at the point of refusal.
 *
 * In `no-cdn.spec.ts`'s exact shape, for its reasons: the needle is built by
 * concatenation, spec files are skipped (this one included), offenders are
 * reported by path so a failure names the file, and the scanner is tested
 * before it is trusted.
 *
 * Read from the working directory rather than from `import.meta.url`, which is
 * `no-firestore.spec.ts`'s rule and for its reason: this suite runs under jsdom,
 * where `import.meta.url` is an http URL that `fileURLToPath` refuses. Vitest's
 * cwd is `frontend/`.
 */

const SRC = join(process.cwd(), 'src')

/**
 * Built by concatenation, and every `*.spec.ts` is skipped below — this file
 * with them.
 *
 * Both halves are needed for a scanner that does not trip on its own source, or
 * on the doubles the component specs stand up for it. A sibling scan went red
 * once because a sentence quoted its own needle; a needle in two pieces cannot.
 */
const NEEDLE = 'vue-' + 'sonner'

/**
 * The two files allowed to name it, and there is one reason each.
 *
 * The region is the primitive itself — the vendored `Toaster`, mounted once at
 * the shell root. The sheet is the one action whose outcome leaves nothing on
 * screen: a restore that rewrote the project, and a restore that changed
 * nothing because the project already was that version, which look identical.
 */
const ALLOWED: readonly string[] = [
  'src/components/ui/sonner/Sonner.vue',
  'src/components/workspace/SnapshotSheet.vue',
]

/** Every way a third call site can arrive, as source a scan has to catch. */
const FORMS: readonly (readonly [string, string])[] = [
  ['a direct import', `import { toast } from '${NEEDLE}'`],
  ['a deep import', `import { toast } from '${NEEDLE}/lib'`],
  ['a dynamic import', `const { toast } = await import('${NEEDLE}')`],
  ['a re-export that hides one', `export { toast } from '${NEEDLE}'`],
]

/**
 * What must **not** fire, or the scan would be unmaintainable.
 *
 * The vendored region is imported by its own path and is the fix, not the
 * offence; and an inline error surface is what D4 asks for, so the components
 * that render one have to stay silent here.
 */
const INNOCENT: readonly (readonly [string, string])[] = [
  ['the vendored region', `import { Toaster } from '@/components/ui/sonner'`],
  ['the region’s own file', `import { Toaster as Sonner } from './Sonner.vue'`],
  ['an inline error surface', `<Alert variant="destructive">{{ saveError }}</Alert>`],
]

/**
 * The vendored region's own import specifier, and the one file allowed to name
 * it.
 *
 * A second needle because the first one cannot see this: a view that mounted
 * its own `<Toaster />` would import `@/components/ui/sonner`, which does not
 * contain `vue-sonner` at all — `INNOCENT` below even names that import as the
 * thing the first scan must stay quiet about. `App.spec.ts` counts the regions
 * it can see, but it stubs the routed views, so a `Toaster` inside
 * `DashboardView.vue` is invisible there too. Between them that left AC-7 with
 * no test that a second region cannot exist, and two regions render every toast
 * twice.
 */
const REGION = '@/components/' + 'ui/sonner'

/** The shell, and only the shell. It is mounted once, outside `<main>`. */
const REGION_ALLOWED: readonly string[] = ['src/App.vue']

/**
 * Skipped so the scanner does not trip on its own source, nor on the component
 * specs that mock the module to assert a call site behaves — a test double is
 * not a call site.
 */
function isSpec(name: string): boolean {
  return name.endsWith('.spec.ts')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (isSpec(entry.name)) return []
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

/**
 * The needle, on source text.
 *
 * Split out so the cases below exercise the predicate the tree walk uses.
 * Asserting `source.includes(NEEDLE)` inline instead would be a tautology — the
 * fixtures are built by interpolating `NEEDLE` — and a tautology proves nothing
 * about the scanner it stands in for. `no-cdn.spec.ts` calls its own `hits()`
 * here for the same reason.
 */
function names(source: string): boolean {
  return source.includes(NEEDLE)
}

/** The same, for the vendored region's import specifier. */
function mountsRegion(source: string): boolean {
  return source.includes(REGION)
}

/** `/…/frontend/src/lib/x.ts` → `src/lib/x.ts`, so a failure reads as a path. */
function shortPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/')
}

describe('the scan itself', () => {
  /*
   * The scanner is tested before it is trusted, `no-firestore.spec.ts`'s rule.
   * `sites).toEqual(ALLOWED)` reads as proof whether the scanner catches
   * everything or nothing, so these cases are what "two call sites" has to mean
   * for that line to be worth anything.
   */
  it.each(FORMS)('catches %s', (_label, source) => {
    expect(names(source)).toBe(true)
  })

  it.each(INNOCENT)('does not fire on %s', (_label, source) => {
    expect(names(source)).toBe(false)
  })

  /* The skip is the other half, and the half that could silently widen: it
   * already exempts every spec, so a looser test would exempt source too. */
  it('skips specs and nothing else', () => {
    expect(isSpec('SnapshotSheet.spec.ts')).toBe(true)
    expect(isSpec('SnapshotSheet.vue')).toBe(false)
    expect(isSpec('sessionExpiry.ts')).toBe(false)
  })
})

describe('the frontend source tree', () => {
  it('raises a toast from exactly two files, and they are the two', () => {
    // Reported by path, so a third site names the file that added it rather
    // than merely asserting that one exists somewhere.
    const scanned = sourceFiles(SRC)

    // A walk that found nothing would leave `sites` empty for a reason that has
    // nothing to do with the rule — the one way this scan reads as green and
    // proves nothing.
    expect(scanned.length).toBeGreaterThan(50)

    const sites = scanned
      .filter((path) => names(readFileSync(path, 'utf8')))
      .map(shortPath)
      .sort()

    expect(sites).toEqual(ALLOWED)
  })

  /*
   * AC-7, and the half `App.spec.ts` cannot reach. It counts `Toaster`s in a
   * tree whose routed views are stubs, so it would still read one with a second
   * region sitting in `DashboardView.vue`. This is the assertion that a second
   * one cannot be added at all.
   */
  it('mounts the toast region from exactly one file, and it is the shell', () => {
    const regions = sourceFiles(SRC)
      .filter((path) => mountsRegion(readFileSync(path, 'utf8')))
      .map(shortPath)
      .sort()

    expect(regions).toEqual(REGION_ALLOWED)
  })
})
