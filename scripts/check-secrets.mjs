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
 *   node scripts/check-secrets.mjs
 */
import { readFileSync } from 'node:fs'
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
