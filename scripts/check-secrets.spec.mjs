import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PACKAGE_EXAMPLES,
  ROOT,
  ROOT_EXAMPLE,
  declaredVars,
  missingFromRoot,
} from './check-secrets.mjs'

/**
 * AC-1 — the root `.env.example` is a map of every variable the project reads.
 *
 * The file already drifted once: the deploy-pipeline PR added it, and four
 * variables that only `functions/.env.example` documents never made it across.
 * The gap is exactly the failure mode the root file exists to close — "where is
 * this configured?" answered wrongly — so it is held by a test rather than by
 * remembering.
 *
 * Every check here runs twice: once over a fixture, which proves the check can
 * fail, and once over the real files, which proves it passes today.
 */

const made = []

/** A throwaway `.env.example` on disk, so the checks are exercised over real files. */
function fixtureFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-env-'))
  made.push(dir)
  const path = join(dir, name)
  writeFileSync(path, contents)
  return path
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true })
})

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

describe('declaredVars', () => {
  it('reads NAME= at the start of a line only, deduped, in order', () => {
    const text = [
      '# HL_COMMENTED=  a name inside a comment is documentation, not a declaration',
      'FIRST=',
      '  INDENTED=',
      'SECOND=value',
      'FIRST=',
      'VITE_GOOGLE_RECAPTCHA_V3_KEY=',
    ].join('\n')

    expect(declaredVars(text)).toEqual(['FIRST', 'SECOND', 'VITE_GOOGLE_RECAPTCHA_V3_KEY'])
  })
})

describe('missingFromRoot', () => {
  it('names the variable and the file that has it', () => {
    const rootPath = fixtureFile('root.env.example', 'SHARED=\n')
    const packagePath = fixtureFile('package.env.example', 'SHARED=\nONLY_IN_THE_PACKAGE=\n')

    const missing = missingFromRoot(readFileSync(rootPath, 'utf8'), [
      { file: 'somewhere/.env.example', text: readFileSync(packagePath, 'utf8') },
    ])

    expect(missing).toEqual([{ name: 'ONLY_IN_THE_PACKAGE', file: 'somewhere/.env.example' }])
  })

  /*
   * One-directional on purpose. The root file may hold MORE than the packages —
   * HL_SEED_TOKEN and HL_SEED_LOCATION_ID are read by scripts/seed-sandbox.mjs
   * and by nothing that deploys, so they have no package file to live in.
   */
  it('does not complain that the root carries more than the packages', () => {
    expect(
      missingFromRoot('SHARED=\nONLY_AT_THE_ROOT=\n', [{ file: 'p', text: 'SHARED=\n' }]),
    ).toEqual([])
  })

  it('every variable in a package example is in the root example', () => {
    const missing = missingFromRoot(
      read(ROOT_EXAMPLE),
      PACKAGE_EXAMPLES.map((file) => ({ file, text: read(file) })),
    )

    expect(missing).toEqual([])
  })
})
