/**
 * Carry the address from sign-up to sign-in.
 *
 * The two are separate steps in this flow, so without it a user types their
 * email, submits, and is immediately asked to type the same email again. Held
 * in `sessionStorage` rather than the query string: it is the user's own
 * address, but there is no reason to leave it in browser history.
 *
 * Read once and cleared, so a later visit to sign-in does not resurrect a
 * stale address.
 */
const KEY = 'genesis:signup-email'

export function rememberEmail(email: string): void {
  try {
    sessionStorage.setItem(KEY, email)
  } catch {
    // Private browsing throws. Losing this costs one retype, nothing more.
  }
}

export function recallEmail(): string {
  try {
    const value = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return value ?? ''
  } catch {
    return ''
  }
}
