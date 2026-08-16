/**
 * Resolving a usable HighLevel access token for a user.
 *
 * Split deliberately into a decision and an effect. This file owns the
 * decision — *is the stored token still good enough?* — and is pure, so the
 * arithmetic is unit-testable. Performing a rotation is a Firestore
 * transaction, supplied by the caller through {@link TokenDeps} and covered at
 * L4 where a real transaction can actually race.
 *
 * ## Why five minutes early
 *
 * HighLevel rotates refresh tokens on use: each refresh issues a new refresh
 * token and invalidates the one presented. So two callers who both find an
 * expired access token will both try to rotate, one wins, and the loser
 * presents a refresh token that has already been spent — `invalid_grant`, and
 * if that is persisted the connection is dead until the user reinstalls.
 *
 * The transaction in the adapter is what makes that safe. The skew here is what
 * makes it rare: refreshing while the token is still valid means the window in
 * which callers pile up on an expired token is essentially never open.
 */

/** Refresh this long before the token actually expires. */
export const SKEW_MS = 5 * 60_000

/** No `hlConnections/{uid}` document exists — the user never connected. */
export class HlNotConnectedError extends Error {
  constructor() {
    super('No HighLevel account is connected.')
    this.name = 'HlNotConnectedError'
  }
}

export interface ConnectionSnapshot {
  accessToken: string
  expiresAtMs: number
}

export interface TokenDeps {
  /** Read the stored connection, or undefined when there is none. */
  read: (uid: string) => Promise<ConnectionSnapshot | undefined>
  /** Rotate transactionally and return a fresh access token. */
  refresh: (uid: string) => Promise<string>
}

/**
 * Strictly greater than, so a token expiring exactly at the skew boundary is
 * treated as stale. At the boundary the token has five minutes left, which a
 * slow request could outlive; erring toward one extra refresh is far cheaper
 * than erring toward a 401 mid-flight.
 */
export function isFresh(expiresAtMs: number, now: number): boolean {
  return expiresAtMs - SKEW_MS > now
}

export async function getAccessToken(
  uid: string,
  deps: TokenDeps,
  now = Date.now(),
): Promise<string> {
  const connection = await deps.read(uid)
  if (connection === undefined) throw new HlNotConnectedError()

  // Fast path: no transaction, no lock, no HighLevel round trip. This is what
  // almost every call takes, and keeping it out of a transaction is why the
  // proxy can serve a burst of preview requests without serialising them.
  if (isFresh(connection.expiresAtMs, now)) return connection.accessToken

  return deps.refresh(uid)
}
