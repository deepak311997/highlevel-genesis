import { z } from 'zod'

/**
 * Boundary schemas for the auth endpoints, doing two security-relevant jobs.
 *
 * **Validate before touching Firebase Auth**: a call that only happens for some
 * inputs is an oracle, because "rejected instantly" versus "rejected after a round
 * trip" tells an attacker whether the address exists.
 *
 * **Normalise the address**, since `Alice@X` and `alice@x` are one account to
 * Firebase — treating them as different would let one user hold two registrations
 * and make the throttle key evadable by changing case.
 */

/**
 * Password policy, mirroring the Identity Platform policy configured on the
 * project — and it has to: the console policy applies to `confirmPasswordReset`,
 * which runs client-side, so a password accepted here but refused there would let
 * someone sign up with a password they could never set again.
 *
 * This reverses the NIST-style length-only guidance the discovery preferred; the
 * project owner chose the stricter console policy, and the code follows it rather
 * than diverging. The maximum is 50 because the console caps there.
 */
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 50

/** Non-alphanumeric, matching how Identity Platform counts a "special" character. */
const SPECIAL = /[^A-Za-z0-9]/

export const PASSWORD_POLICY_MESSAGE =
  `Use ${String(PASSWORD_MIN)}–${String(PASSWORD_MAX)} characters, ` +
  'with an uppercase letter, a lowercase letter, a number and a symbol.'

/**
 * Trimmed and lower-cased *before* validation, so the value that reaches the Admin
 * SDK is the same value the throttle hashed.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address.' }))

/**
 * One message for every way the policy can be missed. Itemised feedback would tell
 * anyone probing the endpoint which rules a candidate password already satisfies,
 * and is of no more use to a legitimate user than the full rule.
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
