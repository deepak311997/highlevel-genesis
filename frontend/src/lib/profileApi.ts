import { request } from './apiClient'

/**
 * The user's own profile, over HTTP.
 *
 * `users/{uid}` is denied to every client by `firestore.rules` — the browser has
 * no path to the document at all — so these two calls are the whole of its
 * access to it. The uid is never sent: the path is the literal `me`, and the
 * server reads the caller's uid from the ID token.
 */

/** Mirrors the server's wire shape. Timestamps are ISO-8601 strings. */
export interface Profile {
  email: string
  displayName: string | null
  createdAt: string
  updatedAt: string
}

/**
 * `null` is a value, not a failure: it is the state between verifying and the
 * first ensure, and it is the account card's empty state.
 */
export async function getProfile(): Promise<Profile | null> {
  const { profile } = await request<{ profile: Profile | null }>('/api/users/me')
  return profile
}

/**
 * Create the profile if it is absent, touch it if it is not. Idempotent, so a
 * sign-up interrupted before the document existed heals on the next visit.
 *
 * The body is an explicit `'{}'` with a JSON content type rather than nothing at
 * all: it is what makes the request arrive at the route as a parsed body, so the
 * `.strict()` boundary is genuinely exercised on the path the app actually uses
 * instead of only in tests. The `PUT` never answers `null` on success.
 */
export async function ensureProfile(): Promise<Profile> {
  const { profile } = await request<{ profile: Profile }>('/api/users/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  return profile
}
