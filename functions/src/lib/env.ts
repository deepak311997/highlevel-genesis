/**
 * The one module that reads `process.env`.
 *
 * Every configured value in this codebase arrives through one of the readers
 * below, and every one of them treats a blank string as an absence. That single
 * rule is the reason this module exists: a name listed in a `.env` file with
 * nothing after the `=` is the commonest way to half-configure a deployment, it
 * is indistinguishable from a typo in the name, and `??` accepts it as a real
 * value. Four hand-rolled copies of that check were four chances to write `??`.
 *
 * They were not hypothetical copies. `required()` stood verbatim in both
 * `hl/config.ts` and `lib/firebase.ts`; the emulator-only override stood in
 * `hl/config.ts` and again in `generate.ts`, whose comment said outright that it
 * was "`hl/config.ts`'s `emulatorOverride` pattern exactly"; and `api/index.ts`
 * parsed a comma-separated list its own way.
 *
 * **`defineSecret` declarations stay beside their readers** — in `llm/client.ts`,
 * `hl/config.ts` and `hl/state.ts` — and that is not an inconsistency with the
 * paragraph above. `client.ts` records the reason: a binding declared a file away
 * from the code that reads it is a binding that a refactor of the wrong file
 * silently drops, and a dropped binding is invisible under the emulator, where a
 * secret resolves from `process.env` whether it was granted or not. What is
 * centralised here is the *mechanics* of reading a value. Where a value lives —
 * plain environment or Secret Manager — is a decision that belongs at the
 * declaration, next to the code whose disclosure properties motivated it.
 */

/**
 * Exactly what the Firebase emulator sets, and nothing else.
 *
 * Compared strictly on purpose. This gates behaviour that must not exist in a
 * deployed build — the test-only cleanup route, which accepts `now` as input,
 * and the emulator overrides below. Production never sets FUNCTIONS_EMULATOR,
 * which makes it the one signal that cannot be turned on by a mistake in a
 * deploy. Every near-miss — `TRUE`, `1`, `yes` — has to read as "not the
 * emulator" rather than as a truthy string.
 */
const EMULATOR_MARKER = 'true'

export function isEmulator(): boolean {
  return process.env['FUNCTIONS_EMULATOR'] === EMULATOR_MARKER
}

/**
 * A configured value, or `undefined` — where blank counts as `undefined`.
 *
 * The primitive the rest of this file is built from.
 */
function read(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * A plain environment variable that must be set.
 *
 * The message names the file to put it in, because the alternative is someone
 * grepping the repository for the variable name.
 */
export function required(name: string): string {
  const value = read(name)
  if (value === undefined) {
    throw new Error(`Missing ${name}. Set it in functions/.env — see functions/.env.example.`)
  }
  return value
}

/** The shape of a `firebase-functions` `SecretParam`, narrowed to what is used. */
export interface SecretLike {
  value: () => string
}

/**
 * A value that lives in Secret Manager and must be set.
 *
 * Validated rather than trusted, because `SecretParam.value()` answers `''` for
 * a secret the function was never granted and only `warn`s about it. Left
 * unchecked, a missing *binding* surfaces a long way from itself: as an opaque
 * 401 from Anthropic, as an `invalid_client` from HighLevel, or — worst — as a
 * cipher that works perfectly under a key derived from the empty string.
 *
 * The message deliberately does **not** name `functions/.env`. Telling someone to
 * put a Secret Manager value there is telling them to put a secret in the one
 * file that is uploaded as plain Cloud Run environment, readable by anyone
 * holding Viewer on the project.
 */
export function requiredSecret(param: SecretLike, name: string): string {
  const value = param.value().trim()
  if (value === '') {
    throw new Error(
      `Missing ${name}. Set it with \`firebase functions:secrets:set ${name}\` — ` +
        'see functions/.env.example.',
    )
  }
  return value
}

/**
 * A base URL with a default, trailing slashes stripped.
 *
 * Stripped so every caller can join with a leading slash and none of them has to
 * think about it: `//locations/x` is a different path from `/locations/x` to a
 * strict router, and the difference is one invisible character in a config file.
 * The fallback is stripped too — it is a configured value like any other, just
 * one configured in source.
 */
export function baseUrl(name: string, fallback: string): string {
  return (read(name) ?? fallback).replace(/\/+$/, '')
}

/**
 * A comma-separated list with a default, each entry trimmed and blanks dropped.
 *
 * Blanks are dropped rather than kept because a trailing comma is a configured
 * list, not a list with an empty entry — and an empty entry in an origin
 * allowlist is an entry that matches an empty `Origin` header.
 */
export function list(name: string, fallback: readonly string[]): readonly string[] {
  return listFrom(process.env[name], fallback)
}

/**
 * The same parse, for a value that did not come from `process.env` by name.
 *
 * A `SecretParam` hands back a string, so a comma-separated *secret* — the origin
 * allowlist is one — cannot go through {@link list}. Splitting it here rather than
 * at the call site keeps one definition of what "a configured list" means, which
 * is the point of this module.
 */
export function listFrom(raw: string | undefined, fallback: readonly string[]): readonly string[] {
  const configured = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')

  return configured.length > 0 ? configured : fallback
}

/**
 * A value the *test scripts* can force, which no `.env` file can overrule.
 *
 * The functions emulator loads `.env` and `.env.local` into the runtime and
 * those values **beat anything the shell exported** — the precedence that once
 * sent the local OAuth flow to the deployed site. It has a sharper consequence
 * for the suite: `.env.local` can be switched to the real HighLevel for manual
 * checks, and if tests inherited that they would exchange real authorization
 * codes against the live API with real credentials.
 *
 * The names passed here appear in no `.env` file, so a shell value survives; and
 * they are honoured only under the emulator, so no deploy can reach them however
 * its environment is set. `HL_TEST_API_BASE` outside the emulator would point the
 * live proxy at a fake.
 */
export function emulatorOverride(name: string): string | undefined {
  return isEmulator() ? read(name) : undefined
}

/**
 * The same override, for a positive number, with a default.
 *
 * Zero and negative are rejected rather than honoured: a keep-alive of 0 ms is a
 * busy loop and a timeout of -1 aborts before it starts, so a fat-fingered value
 * degrades to the default rather than to a hang.
 */
export function emulatorNumber(name: string, fallback: number): number {
  const raw = Number(emulatorOverride(name) ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
