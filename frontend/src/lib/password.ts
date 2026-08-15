/**
 * The password policy, client side.
 *
 * Three copies of this rule exist and all three have to agree:
 *
 *  1. the Identity Platform policy configured on the Firebase project,
 *  2. `functions/src/auth/schema.ts`, which guards `/api/auth/register`,
 *  3. this, which is only there so a user sees the rule before a round trip.
 *
 * The console copy is the one nothing in this repo can enforce, and it is the
 * one that governs `confirmPasswordReset` — which runs here, in the browser. A
 * password this file accepted but the console refused would let someone sign up
 * with a password they could never set again on reset.
 *
 * This is a *usability* layer, not a security one. Anything relying on it being
 * applied is relying on the client, which an attacker simply does not run.
 */

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 50

export const PASSWORD_POLICY_MESSAGE =
  `Use ${String(PASSWORD_MIN)}–${String(PASSWORD_MAX)} characters, ` +
  'with an uppercase letter, a lowercase letter, a number and a symbol.'

/** Non-alphanumeric, matching how Identity Platform counts a "special" character. */
const SPECIAL = /[^A-Za-z0-9]/

/**
 * `null` when the password is acceptable, otherwise the message to show.
 *
 * One message for every failure, matching the server. Itemising which rule was
 * missed tells anyone probing exactly which constraints a candidate already
 * satisfies, and tells a legitimate user nothing the full rule does not.
 */
export function passwordProblem(value: string): string | null {
  const ok =
    value.length >= PASSWORD_MIN &&
    value.length <= PASSWORD_MAX &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /[0-9]/.test(value) &&
    SPECIAL.test(value)

  return ok ? null : PASSWORD_POLICY_MESSAGE
}
