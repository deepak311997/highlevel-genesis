/**
 * The one module that reads `process.env`.
 *
 * Every reader below treats a blank string as an absence, which is the reason the
 * module exists: a name listed in a `.env` file with nothing after the `=` is the
 * commonest way to half-configure a deployment, it is indistinguishable from a
 * typo in the name, and `??` accepts it as a real value.
 *
 * **`defineSecret` declarations stay beside their readers.** What is centralised
 * here is the mechanics of reading a value; where a value lives — plain
 * environment or Secret Manager — belongs at the declaration, because a binding
 * declared a file away from its reader is one a refactor silently drops, and a
 * dropped binding is invisible under the emulator.
 */

/**
 * Exactly what the Firebase emulator sets, compared strictly.
 *
 * This gates behaviour that must not exist in a deployed build, and production
 * never sets the variable — so it is the one signal a deploy cannot turn on by
 * mistake. Every near-miss (`TRUE`, `1`, `yes`) has to read as "not the emulator".
 */
const EMULATOR_MARKER = 'true'

export function isEmulator(): boolean {
  return process.env['FUNCTIONS_EMULATOR'] === EMULATOR_MARKER
}

/** A configured value, or `undefined` — where blank counts as `undefined`. */
function read(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * A plain environment variable that must be set. The message names the file to
 * put it in, because the alternative is grepping the repository for the name.
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
 * Validated rather than trusted: `SecretParam.value()` answers `''` for a secret
 * the function was never granted and only warns. Left unchecked, a missing binding
 * surfaces a long way from itself — an opaque 401, an `invalid_client`, or a
 * cipher working perfectly under a key derived from the empty string.
 *
 * The message deliberately does not name `functions/.env`: that file is uploaded
 * as plain Cloud Run environment, readable by anyone holding Viewer.
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
 * A base URL with a default, trailing slashes stripped so every caller can join
 * with a leading slash: `//locations/x` is a different path to a strict router,
 * and the difference is one invisible character in a config file.
 */
export function baseUrl(name: string, fallback: string): string {
  return (read(name) ?? fallback).replace(/\/+$/, '')
}

/**
 * A comma-separated list with a default, each entry trimmed and blanks dropped —
 * a trailing comma is a configured list, not a list with an empty entry, and an
 * empty entry in an origin allowlist matches an empty `Origin` header.
 */
export function list(name: string, fallback: readonly string[]): readonly string[] {
  return listFrom(process.env[name], fallback)
}

/**
 * The same parse, for a value that did not come from `process.env` by name — a
 * comma-separated *secret*, such as the origin allowlist, cannot go through
 * {@link list}.
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
 * The functions emulator loads `.env` and `.env.local` into the runtime and those
 * beat anything the shell exported. That has a sharp consequence for the suite:
 * `.env.local` can be pointed at the real HighLevel for manual checks, and tests
 * inheriting it would exchange real authorization codes against the live API.
 *
 * The names passed here appear in no `.env` file, so a shell value survives, and
 * they are honoured only under the emulator, so no deploy can reach them.
 */
export function emulatorOverride(name: string): string | undefined {
  return isEmulator() ? read(name) : undefined
}

/**
 * The same override, as a boolean switch.
 *
 * **`1` and `true` only.** The obvious alternative — `!== undefined` at the call
 * site — reads `GENESIS_LOCAL_REAL_LLM=0` as *on*, which is the exact spelling
 * somebody reaches for when they mean off.
 */
export function emulatorFlag(name: string): boolean {
  const value = emulatorOverride(name)?.toLowerCase()
  return value === '1' || value === 'true'
}

/** The same override, for a positive number: zero and negative fall back, since a
 * keep-alive of 0 ms is a busy loop and a timeout of -1 aborts before it starts. */
export function emulatorNumber(name: string, fallback: number): number {
  const raw = Number(emulatorOverride(name) ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
