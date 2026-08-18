#!/usr/bin/env node
/**
 * Assert the project's configuration is where it says it is.
 *
 * Two claims, both of which have been wrong before and neither of which a human
 * can be asked to re-verify on every commit:
 *
 *   1. The root `.env.example` is a MAP of every variable the project reads. A
 *      variable documented in `frontend/.env.example` or `functions/.env.example`
 *      and nowhere else answers "where is this configured?" wrongly, which is the
 *      one job the root file has.
 *
 *   2. Credentials come from Secret Manager, not from the deploy. Anything the
 *      deploy writes into `functions/.env` is uploaded as a plain environment
 *      variable on the Cloud Run service and is readable by anyone with Viewer
 *      on the project.
 *
 * What the second claim means concretely, and the shape the checks assert:
 *
 *   Secret Manager, seven, each a `defineSecret` under functions/src —
 *     ANTHROPIC_API_KEY   generate; the LLM credential
 *     OAUTH_STATE_SECRET  api; whoever holds it can mint a state naming any uid
 *     HL_CLIENT_ID        api ┐ the marketplace app's four values. Not all of
 *     HL_CLIENT_SECRET    api │ them are credentials — the redirect URI is
 *     HL_VERSION_ID       api │ public — but functions/.env is synthesised by
 *     HL_REDIRECT_URI     api ┘ the deploy, on a public repository.
 *     ALLOWED_ORIGINS     api and generate
 *
 *   functions/.env, one, written by the deploy —
 *     FIRESTORE_DATABASE_ID  derived from firebase.json, and not a secret: it
 *                            names a database that security rules protect.
 *
 * So the two sets must stay disjoint, and every one of the seven must still be
 * documented at the root — Secret Manager holds the value, and the example file
 * is the only place a reader learns the name exists at all.
 *
 * D4 chose this over a `gcloud run services describe` by hand: that verifies
 * today and nothing tomorrow, while a read of the two files that decide it
 * verifies every commit. The console reading stays in the release checklist as a
 * one-time confirmation, not as the mechanism.
 *
 *   node scripts/check-secrets.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Repo root, resolved from this file so the checks work from any cwd. */
export const ROOT = join(import.meta.dirname, '..')

export const PACKAGE_EXAMPLES = ['frontend/.env.example', 'functions/.env.example']
export const ROOT_EXAMPLE = '.env.example'
export const DEPLOY_WORKFLOW = '.github/workflows/deploy.yml'

/**
 * Every `NAME=` declared at the start of a line. Order preserved, deduped.
 *
 * Anchored at column zero with no leading whitespace allowed, because both
 * example files quote variable names inside their comments — `#   HL_VERSION_ID`
 * is documentation, and counting it as a declaration would let a variable
 * "exist" in a file that never sets it.
 */
export function declaredVars(text) {
  const names = text.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)
  return [...new Set([...names].map((match) => match[1]))]
}

/**
 * Variables in a package example that the root example does not carry.
 *
 * One-directional on purpose: the root file may hold MORE (the operator
 * variables live only there, because no deployed code reads them).
 */
export function missingFromRoot(rootText, packages) {
  const known = new Set(declaredVars(rootText))
  return packages.flatMap(({ file, text }) =>
    declaredVars(text)
      .filter((name) => !known.has(name))
      .map((name) => ({ name, file })),
  )
}

/** Every `defineSecret('NAME')` under functions/src, excluding *.spec.ts. */
export function definedSecrets(dir = join(ROOT, 'functions/src')) {
  const walk = (current) =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const path = join(current, entry.name)
      if (entry.isDirectory()) return walk(path)
      // A spec names secrets it does not declare — a stub, or an assertion about
      // one — so reading them would make the list depend on the tests.
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) return []
      const declarations = readFileSync(path, 'utf8').matchAll(
        /defineSecret\(\s*'([A-Z0-9_]+)'\s*\)/g,
      )
      return [...declarations].map((match) => match[1])
    })

  return [...new Set(walk(dir))].sort()
}

/**
 * Variable names the workflow writes into functions/.env.
 *
 * Read line-wise, because that is the form the deploy uses:
 *
 *   echo "FIRESTORE_DATABASE_ID=$DATABASE" > functions/.env
 *
 * Throws on a heredoc redirect into that file — a form this cannot read is a
 * failure, not a pass (C5). A heredoc puts its assignments on the lines after
 * the redirect, so a line-wise reader answers `[]` for it, and `[]` is this
 * check's word for "the deploy writes no secrets". Silence that reads as an
 * all-clear is the one answer it must never give.
 */
export function plainEnvVarsInDeploy(text) {
  const written = text.split('\n').flatMap((line) => {
    const redirect = /(>>?)\s*functions\/\.env(?![.\w])/.exec(line)
    if (redirect === null) return []
    if (line.includes('<<')) {
      throw new Error(
        `${DEPLOY_WORKFLOW} writes functions/.env with a heredoc, which this check cannot read:\n` +
          `  ${line.trim()}\n` +
          'Write it as `echo "NAME=value" > functions/.env` lines, or teach this function the form.',
      )
    }
    const echoed = line.slice(0, redirect.index)
    return [...echoed.matchAll(/\b([A-Z_][A-Z0-9_]*)=/g)].map((match) => match[1])
  })

  return [...new Set(written)]
}

// Guarded so importing this module from the spec does not run the check.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

  try {
    const rootText = read(ROOT_EXAMPLE)
    const documented = declaredVars(rootText)
    const secrets = definedSecrets()
    const plain = plainEnvVarsInDeploy(read(DEPLOY_WORKFLOW))

    // Collected rather than thrown one at a time: a run that reports the first
    // problem makes the next one a second round trip, and these are cheap.
    const failures = [
      ...missingFromRoot(
        rootText,
        PACKAGE_EXAMPLES.map((file) => ({ file, text: read(file) })),
      ).map(({ name, file }) => `${name} is documented in ${file} but not in ${ROOT_EXAMPLE}.`),

      ...secrets
        .filter((name) => !documented.includes(name))
        .map((name) => `defineSecret('${name}') is not documented in ${ROOT_EXAMPLE}.`),

      ...plain
        .filter((name) => secrets.includes(name))
        .map(
          (name) =>
            `${name} is a defineSecret, and ${DEPLOY_WORKFLOW} writes it into functions/.env — ` +
            'which uploads it as a plain Cloud Run environment variable.',
        ),
    ]

    if (failures.length > 0) {
      console.error('Configuration is not where it says it is:')
      for (const failure of failures) console.error(`  ${failure}`)
      console.error('\nSee docs/slices/13-deliverables/02-prd.md, D3 and D4.')
      process.exit(1)
    }

    console.log(
      `${ROOT_EXAMPLE} documents ${String(documented.length)} variables — ` +
        `every one declared in ${PACKAGE_EXAMPLES.join(' and ')}, and the operator scripts'.`,
    )
    console.log(`${String(secrets.length)} defineSecrets, each documented: ${secrets.join(', ')}.`)
    console.log(`${DEPLOY_WORKFLOW} writes ${plain.join(', ')} into functions/.env, and no secret.`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
