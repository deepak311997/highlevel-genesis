import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * AC-29 — what the frontend depends on, as a test rather than as a review habit.
 *
 * Two claims, and neither is decorative.
 *
 * **`monaco-editor` is pinned exactly** (D1). 0.55 added an `exports` map and 0.56
 * restructured the ESM tree, so the deep path the mandated wrapper's own `.d.ts`
 * imports — `monaco-editor/esm/vs/editor/editor.api` — stops resolving. Under this
 * project's `strict` typecheck that is a build failure inside a package the brief
 * requires, caused by a peer we chose. A caret would let `npm update` reintroduce it
 * silently; this fails first, and names the version it wanted.
 *
 * **The dependency set is asserted whole.** The point is not the two additions on
 * their own — it is that a third one has to be a deliberate edit to this list, which
 * is what makes "these are the only added dependencies" a claim with a test behind it
 * rather than a sentence in a PRD.
 *
 * Read from the working directory rather than from `import.meta.url`, which is
 * `no-firestore.spec.ts`'s rule and for its reason: this suite runs under jsdom,
 * where `import.meta.url` is an http URL that `fileURLToPath` refuses. Vitest's cwd
 * is `frontend/`.
 */

interface PackageJson {
  dependencies: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
) as PackageJson

/** Every runtime dependency the frontend is allowed to have, in package.json's order. */
const EXPECTED = [
  '@fontsource-variable/geist',
  '@fontsource-variable/geist-mono',
  '@guolao/vue-monaco-editor',
  '@vueuse/core',
  'class-variance-authority',
  'clsx',
  'firebase',
  'lucide-vue-next',
  'monaco-editor',
  'pinia',
  'reka-ui',
  'tailwind-merge',
  'vue',
  'vue-router',
  'vue-sonner',
]

describe('the frontend’s dependencies', () => {
  it('declares the two Monaco packages and pins monaco exactly', () => {
    expect(manifest.dependencies['@guolao/vue-monaco-editor']).toBeDefined()
    // Exact, not caretted, and asserted twice: the literal is what we chose, the
    // pattern is what makes a later `^` or `~` a failure rather than a shrug.
    expect(manifest.dependencies['monaco-editor']).toBe('0.52.2')
    expect(manifest.dependencies['monaco-editor']).toMatch(/^\d+\.\d+\.\d+$/)
  })

  /* The whole set, so a third addition cannot arrive unnoticed. */
  it('adds nothing else', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual([...EXPECTED].sort())
  })
})
