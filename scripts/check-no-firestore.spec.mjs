import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MARKER, filesContainingMarker } from './check-no-firestore.mjs'

/**
 * AC-26 — the third and last layer of the ban.
 *
 * The ESLint rule catches an import at authoring time and the source scan
 * catches one that got past it, but neither can see a *transitive* pull: a
 * dependency that imports Firestore on our behalf puts the SDK in the bundle
 * with nothing under `frontend/src` to point at. This check reads the built
 * artefact, which is the only thing that can answer that.
 *
 * Fixtures are made under the OS temp directory rather than committed, because a
 * committed fixture containing the marker would itself have to be excluded from
 * every other scanner in the repo.
 */

const made = []

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-bundle-'))
  made.push(dir)
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  return dir
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true })
})

describe('filesContainingMarker', () => {
  it('finds nothing in a bundle with no Firestore SDK', () => {
    const dir = fixture({
      'assets/index.js': 'export const a = 1',
      'assets/firebase.js': 'identitytoolkit.googleapis.com',
      'index.html': '<!doctype html>',
    })

    expect(filesContainingMarker(dir)).toEqual([])
  })

  it('names the file when the marker is in the bundle', () => {
    const dir = fixture({
      'assets/index.js': 'export const a = 1',
      'assets/firebase-CdRV33_-.js': `connect("${MARKER}")`,
    })

    expect(filesContainingMarker(dir)).toEqual([join('assets', 'firebase-CdRV33_-.js')])
  })

  it('searches nested directories, not just the top level', () => {
    const dir = fixture({ 'a/b/c/deep.js': MARKER })

    expect(filesContainingMarker(dir)).toEqual([join('a', 'b', 'c', 'deep.js')])
  })

  /*
   * A missing directory is a failure, not a pass.
   *
   * Exiting 0 on an absent `dist` means the CI step reports success loudest
   * exactly when the build did not run — a security check that passes on the
   * absence of evidence is worse than no check, because it is believed.
   */
  it('throws on a directory that does not exist, naming the build step', () => {
    expect(() => filesContainingMarker(join(tmpdir(), 'genesis-does-not-exist'))).toThrow(
      /npm run build/,
    )
  })
})
