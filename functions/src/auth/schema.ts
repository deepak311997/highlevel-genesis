import { z } from 'zod'

/**
 * Boundary schemas for the auth endpoints.
 *
 * Two jobs, both security-relevant beyond ordinary input hygiene:
 *
 * 1. **Validate before touching Firebase Auth.** A weak password has to be
 *    rejected without an Admin SDK call, because a call that only happens for
 *    some inputs is an oracle: the difference between "rejected instantly" and
 *    "rejected after a round trip" tells an attacker whether the address exists.
 *
 * 2. **Normalise the address.** `Alice@X` and `alice@x` are the same account to
 *    Firebase, so treating them as different here would let one user hold two
 *    registrations and would make the throttle key in ./throttle trivially
 *    evadable by changing case.
 */

/**
 * Password policy.
 *
 * These rules mirror the Identity Platform policy configured on the Firebase
 * project, and they have to: the console policy applies to
 * `confirmPasswordReset`, which runs client-side, so a password accepted here
 * but refused there would let someone sign up with a password they could never
 * set again. The two must agree, and the console is the one we cannot enforce
 * from this repo.
 *
 * This reverses discovery D23, which chose NIST SP 800-63B — length only, no
 * composition rules. That guidance holds generally (composition rules push
 * people toward `P@ssw0rd1`, and length is what actually resists guessing), but
 * the project owner chose the stricter-looking policy and the code follows the
 * console rather than diverging from it.
 *
 * The maximum is 50 because the console caps there, not because it is a good
 * limit — it is below the length at which passphrases become interesting.
 */
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 50

/** Non-alphanumeric, matching how Identity Platform counts a "special" character. */
const SPECIAL = /[^A-Za-z0-9]/

export const PASSWORD_POLICY_MESSAGE =
  `Use ${String(PASSWORD_MIN)}–${String(PASSWORD_MAX)} characters, ` +
  'with an uppercase letter, a lowercase letter, a number and a symbol.'

/**
 * Trimmed and lower-cased *before* validation, so the value that reaches the
 * Admin SDK is the same value the throttle hashed.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address.' }))

/**
 * One message for every way the policy can be missed.
 *
 * Deliberately not "you are missing a digit": itemised feedback tells anyone
 * probing the endpoint exactly which rule a candidate password already
 * satisfies, and it is of no more use to a legitimate user than the full rule.
 */
const password = z
  .string()
  .min(PASSWORD_MIN, PASSWORD_POLICY_MESSAGE)
  .max(PASSWORD_MAX, PASSWORD_POLICY_MESSAGE)
  .refine((value) => /[A-Z]/.test(value), PASSWORD_POLICY_MESSAGE)
  .refine((value) => /[a-z]/.test(value), PASSWORD_POLICY_MESSAGE)
  .refine((value) => /[0-9]/.test(value), PASSWORD_POLICY_MESSAGE)
  .refine((value) => SPECIAL.test(value), PASSWORD_POLICY_MESSAGE)

/** `POST /api/auth/register`. Unknown keys are dropped, not forwarded. */
export const registerSchema = z.object({ email, password })

/** `POST /api/auth/resend` and `/api/auth/password-reset`. */
export const emailOnlySchema = z.object({ email })

export type RegisterInput = z.infer<typeof registerSchema>
export type EmailOnlyInput = z.infer<typeof emailOnlySchema>
