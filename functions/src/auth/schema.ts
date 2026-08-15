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
 * NIST SP 800-63B, §5.1.1.2: length is the control that matters. No composition
 * rules, no forced rotation, and long passphrases explicitly accepted — rules
 * demanding a symbol and a digit reliably produce weaker passwords, not stronger
 * ones, because they push people toward predictable substitutions.
 *
 * The maximum exists only so an absurd input cannot become a hashing cost
 * vector; it is far above anything a person types.
 */
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 256

export const PASSWORD_POLICY_MESSAGE = `Use at least ${String(PASSWORD_MIN)} characters.`

/**
 * Trimmed and lower-cased *before* validation, so the value that reaches the
 * Admin SDK is the same value the throttle hashed.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address.' }))

const password = z
  .string()
  .min(PASSWORD_MIN, PASSWORD_POLICY_MESSAGE)
  .max(PASSWORD_MAX, `Use at most ${String(PASSWORD_MAX)} characters.`)

/** `POST /api/auth/register`. Unknown keys are dropped, not forwarded. */
export const registerSchema = z.object({ email, password })

/** `POST /api/auth/resend` and `/api/auth/password-reset`. */
export const emailOnlySchema = z.object({ email })

export type RegisterInput = z.infer<typeof registerSchema>
export type EmailOnlyInput = z.infer<typeof emailOnlySchema>
