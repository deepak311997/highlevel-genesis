/**
 * Action links that point at our own SPA rather than Firebase's hosted handler.
 *
 * `generateEmailVerificationLink` and `generatePasswordResetLink` return URLs on
 * the Firebase auth domain. Pointing users there would work, but it is an
 * unbranded page mid-flow and it gives us nowhere to put the states the gate
 * needs — expired, already applied, superseded.
 *
 * So the code is extracted and re-hosted on our `/auth/action` route, which
 * applies it with `applyActionCode` / `confirmPasswordReset`. This needs no
 * console configuration, which matters because every console setting is one
 * more thing a reviewer has to replicate to run the project.
 */

export type ActionMode = 'verifyEmail' | 'resetPassword'

/**
 * Read the one-time code out of a Firebase-generated link.
 *
 * Throws rather than returning a fallback: a link without a code is a link the
 * recipient cannot use, and mailing it would strand them with no way to tell
 * whether the fault was theirs.
 */
export function extractOobCode(link: string): string {
  let parsed: URL
  try {
    parsed = new URL(link)
  } catch {
    throw new Error('Firebase returned a link that is not a URL')
  }

  const code = parsed.searchParams.get('oobCode')
  if (code === null || code === '') {
    throw new Error('Firebase returned a link with no oobCode')
  }
  return code
}

/** Where the SPA is reachable. Configured, because it differs per environment. */
function appBaseUrl(): string {
  const value = process.env['APP_BASE_URL']?.trim()
  if (value === undefined || value === '') {
    throw new Error(
      'Missing APP_BASE_URL. Set it in functions/.env — it is the origin emailed links ' +
        'point at, so a wrong value sends users somewhere that cannot verify them.',
    )
  }
  return value.replace(/\/+$/, '')
}

/**
 * Compose the link that actually goes in the email.
 *
 * `URLSearchParams` does the encoding: a code is opaque provider output, and
 * string-concatenating it would let an `&` in one turn into a second parameter.
 */
export function appActionLink(mode: ActionMode, oobCode: string): string {
  const params = new URLSearchParams({ mode, oobCode })
  return `${appBaseUrl()}/auth/action?${params.toString()}`
}
