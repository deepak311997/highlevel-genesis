/**
 * Exactly what the Firebase emulator sets, and nothing else.
 *
 * Compared strictly on purpose. This gates behaviour that must not exist in a
 * deployed build — currently the test-only cleanup route, which accepts `now`
 * as input. Production never sets FUNCTIONS_EMULATOR, which makes it the one
 * signal that cannot be turned on by a mistake in a deploy.
 */
const EMULATOR_MARKER = 'true'

export function isEmulator(): boolean {
  return process.env['FUNCTIONS_EMULATOR'] === EMULATOR_MARKER
}
