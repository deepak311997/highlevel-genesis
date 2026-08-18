import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEPLOY_WORKFLOW,
  PACKAGE_EXAMPLES,
  ROOT,
  ROOT_EXAMPLE,
  declaredVars,
  definedSecrets,
  missingFromRoot,
  plainEnvVarsInDeploy,
} from './check-secrets.mjs'

/**
 * AC-1 — the root `.env.example` is a map of every variable the project reads.
 *
 * The file already drifted once: the deploy-pipeline PR added it, and four variables that only
 * `functions/.env.example` documents never made it across. The gap is exactly the failure mode
 * the root file exists to close — "where is this configured?" answered wrongly — so it is held
 * by a test rather than by remembering.
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

/** A throwaway source tree, for the `defineSecret` scan. */
function fixtureTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-src-'))
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

/**
 * AC-2 — the credentials belong to Secret Manager, and the deploy does not get a copy.
 *
 * Everything `.github/workflows/deploy.yml` writes into `functions/.env` is uploaded as a plain
 * environment variable on the Cloud Run service, where anyone with Viewer on the project can
 * read it. The eight `defineSecret` declarations exist so those values are fetched at runtime
 * instead; this pair of checks is what keeps one from quietly moving back into the file.
 */
describe('definedSecrets', () => {
  it('declares exactly eight secrets, every one documented in the root example', () => {
    const secrets = definedSecrets()

    expect(secrets).toEqual([
      'ALLOWED_ORIGINS',
      'ANTHROPIC_API_KEY',
      'HL_CLIENT_ID',
      'HL_CLIENT_SECRET',
      'HL_REDIRECT_URI',
      'HL_TOKEN_SECRET',
      'HL_VERSION_ID',
      'OAUTH_STATE_SECRET',
    ])

    const documented = declaredVars(read(ROOT_EXAMPLE))
    expect(secrets.filter((name) => !documented.includes(name))).toEqual([])
  })

  /*
   * A spec file names secrets it does not declare — a stub, a fixture, an assertion about one —
   * so counting those would make the list depend on the tests rather than on the deployment.
   */
  it('reads declarations, not the specs that talk about them', () => {
    const dir = fixtureTree({
      'a/real.ts': "export const KEY = defineSecret('REAL_SECRET')\n",
      'a/real.spec.ts': "it('binds', () => defineSecret('FROM_A_SPEC'))\n",
      'a/notes.md': "defineSecret('FROM_A_MARKDOWN_FILE')\n",
    })

    expect(definedSecrets(dir)).toEqual(['REAL_SECRET'])
  })

  /*
   * This list is the input to *both* halves of the check, so a declaration it cannot see is
   * invisible twice: the name is never required in `.env.example`, and it drops out of the
   * comparison against what the deploy writes — leaving the deploy free to write it as a plain
   * variable.
   */
  it('reads a double-quoted declaration as well as a single-quoted one', () => {
    const dir = fixtureTree({ 'a/real.ts': 'defineSecret("DOUBLE_QUOTED")\n' })

    expect(definedSecrets(dir)).toEqual(['DOUBLE_QUOTED'])
  })

  it('throws on a defineSecret whose name it cannot read, rather than skipping it', () => {
    const dir = fixtureTree({
      'a/real.ts': 'const NAME = `HL_${suffix}`\nexport const K = defineSecret(NAME)\n',
    })

    expect(() => definedSecrets(dir)).toThrow(/defineSecret/)
  })
})

describe('plainEnvVarsInDeploy', () => {
  it('writes no defineSecret name into functions/.env — only FIRESTORE_DATABASE_ID', () => {
    const written = plainEnvVarsInDeploy(read(DEPLOY_WORKFLOW))

    expect(written).toEqual(['FIRESTORE_DATABASE_ID'])
    expect(written.filter((name) => definedSecrets().includes(name))).toEqual([])
  })

  it('reports a workflow line that writes a secret into functions/.env', () => {
    const workflow = [
      '      - name: Write functions/.env',
      '        run: |',
      '          echo "FIRESTORE_DATABASE_ID=$DATABASE" > functions/.env',
      '          echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >> functions/.env',
      '          cat functions/.env',
    ].join('\n')

    expect(plainEnvVarsInDeploy(workflow)).toEqual(['FIRESTORE_DATABASE_ID', 'ANTHROPIC_API_KEY'])
  })

  /* A form this cannot read is a failure, not a pass (C5). */
  it('throws on a heredoc redirect into functions/.env rather than reading nothing', () => {
    const workflow = [
      '      - name: Write functions/.env',
      '        run: |',
      '          cat <<EOF > functions/.env',
      '          FIRESTORE_DATABASE_ID=$DATABASE',
      '          ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY',
      '          EOF',
    ].join('\n')

    expect(() => plainEnvVarsInDeploy(workflow)).toThrow(/heredoc/i)
  })

  /*
   * The heredoc is one instance of a class, and the class is the finding: any line that fills
   * `functions/.env` without a readable `NAME=` on it answers `[]`, and `[]` is this check's
   * word for "the deploy writes no secrets".
   */
  const unreadableWrites = {
    'a secret-manager fetch appended beside the readable line': [
      '          echo "FIRESTORE_DATABASE_ID=$DATABASE" > functions/.env',
      '          gcloud secrets versions access latest --secret=FUNCTIONS_ENV >> functions/.env',
    ].join('\n'),
    'a quoted redirect target': '          echo "ANTHROPIC_API_KEY=$KEY" > "functions/.env"',
    'a redirect through a path prefix':
      '          echo "ANTHROPIC_API_KEY=$KEY" > $GITHUB_WORKSPACE/functions/.env',
    'a clobbering redirect': '          echo "ANTHROPIC_API_KEY=$KEY" >| functions/.env',
    'a pipe into tee': '          echo "ANTHROPIC_API_KEY=$KEY" | tee functions/.env',
    'a copy over the file': '          cp .ci/functions.env functions/.env',
    'a redirect whose assignments are on the previous line': '          > functions/.env',
    'an expanded variable carrying the whole line':
      '          echo "$SECRET_LINE" > functions/.env',
  }

  for (const [name, workflow] of Object.entries(unreadableWrites)) {
    it(`throws rather than reading nothing from ${name}`, () => {
      expect(() => plainEnvVarsInDeploy(workflow)).toThrow(/functions\/\.env/)
    })
  }

  it('still reads the plain form, and leaves reads of the file alone', () => {
    const workflow = [
      '      # functions/.env.example says the database id must match firebase.json',
      '      - name: Write functions/.env',
      '        run: |',
      '          echo "FIRESTORE_DATABASE_ID=$DATABASE" > functions/.env',
      '          cat functions/.env',
      '          grep -c . functions/.env',
    ].join('\n')

    expect(plainEnvVarsInDeploy(workflow)).toEqual(['FIRESTORE_DATABASE_ID'])
  })
})
