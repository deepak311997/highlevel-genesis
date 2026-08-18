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

/**
 * The only variables the deploy may write into `functions/.env` as plain values.
 *
 * An allowlist, not a denylist. Comparing what the deploy writes against the
 * `defineSecret` *names* proves only that no secret is written under its own
 * name — `echo "ANTHROPIC_KEY=$ANTHROPIC_API_KEY" > functions/.env` passes that
 * comparison and uploads the key anyway. Naming what may be plain leaves
 * nothing for a rename to hide behind.
 *
 * `FIRESTORE_DATABASE_ID` is not a secret: it names a database that security
 * rules protect, and the deploy reads it out of the committed `firebase.json`.
 */
export const ALLOWED_PLAIN_VARS = ['FIRESTORE_DATABASE_ID']

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

/**
 * Every `defineSecret('NAME')` under functions/src, excluding *.spec.ts.
 *
 * Either quote is read, and a call whose name is **not** a quoted literal
 * throws. This list feeds both halves of the check, so a declaration it cannot
 * see is invisible twice over: the name is never required in `.env.example`,
 * and it drops out of the comparison against what the deploy writes — which
 * would leave the deploy free to write that very name as a plain variable with
 * this check reporting nothing. Same rule as `plainEnvVarsInDeploy`: a form it
 * cannot read is a failure, not a pass.
 */
export function definedSecrets(dir = join(ROOT, 'functions/src')) {
  const walk = (current) =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const path = join(current, entry.name)
      if (entry.isDirectory()) return walk(path)
      // A spec names secrets it does not declare — a stub, or an assertion about
      // one — so reading them would make the list depend on the tests.
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) return []

      const source = readFileSync(path, 'utf8')
      const named = [...source.matchAll(/defineSecret\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g)]
      const calls = [...source.matchAll(/\bdefineSecret\(/g)]

      if (calls.length !== named.length) {
        throw new Error(
          `${path} calls defineSecret with a name this check cannot read — it takes a quoted ` +
            'literal, so that a secret cannot be declared under a name nothing here knows ' +
            `about. ${calls.length} call(s), ${named.length} readable.`,
        )
      }

      return named.map((match) => match[1])
    })

  return [...new Set(walk(dir))].sort()
}

/** `functions/.env` itself — never `.env.example`, never `.env.local`. */
const ENV_FILE = String.raw`functions\/\.env(?![.\w])`

/** Mentions the file at all. Lines that do not are none of this function's business. */
const MENTIONS_ENV_FILE = new RegExp(ENV_FILE)

/**
 * Puts content *into* it, in any form — a redirect, a heredoc, or a command
 * that writes its destination as an argument. `cat functions/.env` and
 * `- name: Write functions/.env` mention the file without filling it, and are
 * left alone.
 */
const FILLS_ENV_FILE = new RegExp(String.raw`>|<<|\b(?:tee|cp|mv|dd|rsync|install)\b`)

/** The one form this reader can decompose: `NAME=value` to the left of `> functions/.env`. */
const READABLE_REDIRECT = new RegExp(String.raw`(>>?)\s*${ENV_FILE}`)

/**
 * Variable names the workflow writes into functions/.env.
 *
 * Read line-wise, because that is the form the deploy uses:
 *
 *   echo "FIRESTORE_DATABASE_ID=$DATABASE" > functions/.env
 *
 * **A form this cannot read throws.** That is the whole design of this
 * function, and the default is inverted for it: a line-wise reader answers `[]`
 * for a heredoc, for `cp x functions/.env`, for `… | tee functions/.env`, for a
 * quoted or path-prefixed redirect target, and for
 * `gcloud secrets versions access … > functions/.env` — and `[]` is this
 * check's word for "the deploy writes no secrets". Silence that reads as an
 * all-clear is the one answer it must never give, so "I could not read this"
 * and "there is nothing here" are kept apart.
 *
 * The last of those forms is not hypothetical: `deploy.yml` already fetches the
 * SPA's whole `.env` out of Secret Manager that way, and giving the functions'
 * configuration the same single home is the obvious next change. Appended
 * *beside* the readable line rather than replacing it, it would have uploaded
 * all seven `defineSecret` values as plain Cloud Run environment variables with
 * the suite still green.
 */
export function plainEnvVarsInDeploy(text) {
  const written = text.split('\n').flatMap((line) => {
    if (!MENTIONS_ENV_FILE.test(line)) return []
    if (!FILLS_ENV_FILE.test(line)) return []

    const redirect = READABLE_REDIRECT.exec(line)
    const names =
      redirect === null
        ? []
        : [...line.slice(0, redirect.index).matchAll(/\b([A-Z_][A-Z0-9_]*)=/g)].map(
            (match) => match[1],
          )

    if (names.length === 0) {
      throw new Error(
        `${DEPLOY_WORKFLOW} fills functions/.env in a form this check cannot read` +
          `${line.includes('<<') ? ' — a heredoc' : ''}:\n` +
          `  ${line.trim()}\n` +
          'It cannot tell whether that line carries a secret, and it must not guess. Write it ' +
          'as `echo "NAME=value" > functions/.env` lines, or teach this function the form.',
      )
    }

    return names
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
        .filter((name) => !ALLOWED_PLAIN_VARS.includes(name))
        .map((name) =>
          secrets.includes(name)
            ? `${name} is a defineSecret, and ${DEPLOY_WORKFLOW} writes it into functions/.env — ` +
              'which uploads it as a plain Cloud Run environment variable.'
            : `${DEPLOY_WORKFLOW} writes ${name} into functions/.env, and it is not one of the ` +
              `values allowed to be plain (${ALLOWED_PLAIN_VARS.join(', ')}). If it is not a ` +
              'secret, add it to ALLOWED_PLAIN_VARS; if it is, move it to Secret Manager.',
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
