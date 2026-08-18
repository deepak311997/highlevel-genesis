/**
 * Resolving a usable HighLevel access token for a user.
 *
 * Split into a decision and an effect: this file owns the decision — *is the
 * stored token still good enough?* — and is pure. Performing a rotation is a
 * Firestore transaction, supplied through {@link TokenDeps} and covered at L4
 * where a real transaction can actually race.
 *
 * **Five minutes early**, because HighLevel rotates refresh tokens on use: two
 * callers who both find an expired access token both try to rotate, one wins, and
 * the loser presents a spent token. The transaction makes that safe; the skew
 * makes it rare, by keeping the window essentially never open.
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

/**
 * The connection is marked dead and only the user can fix it — either because the
 * document already carries the flag or because a refresh came back
 * `invalid_grant`. Both are answered by reconnecting.
 */
export class HlReconnectRequiredError extends Error {
  constructor() {
    super('Your HighLevel connection expired.')
    this.name = 'HlReconnectRequiredError'
  }
}

/**
 * A refresh failed in a way that says nothing about the connection — a 5xx, a
 * network error, a timeout. Distinct from {@link HlReconnectRequiredError} because
 * the *persistence* rule differs: a blip must not be recorded as a dead
 * connection, and a dead connection must not be retried forever.
 */
export class HlRefreshUnavailableError extends Error {
  constructor() {
    super('HighLevel is not responding. Try again.')
    this.name = 'HlRefreshUnavailableError'
  }
}

export interface ConnectionSnapshot {
  accessToken: string
  expiresAtMs: number
  /** The location this token is scoped to — the only one we ever inject. */
  locationId: string
  /** Set when a refresh or an upstream 401 proved the grant is dead. */
  needsReconnect: boolean
}

/** What a proxied call needs: the credential, and the location to name. */
export interface ResolvedConnection {
  accessToken: string
  locationId: string
}

export interface TokenDeps {
  /** Read the stored connection, or undefined when there is none. */
  read: (uid: string) => Promise<ConnectionSnapshot | undefined>
  /** Rotate transactionally and return a fresh access token. */
  refresh: (uid: string) => Promise<string>
}

/**
 * Strictly greater than, so a token expiring exactly at the boundary is treated as
 * stale: erring toward one extra refresh is far cheaper than erring toward a 401
 * mid-flight.
 */
export function isFresh(expiresAtMs: number, now: number): boolean {
  return expiresAtMs - SKEW_MS > now
}

/**
 * One read, both facts. The proxy needs the access token *and* the connection's
 * `locationId`, and a second read for a value the first already returned would be
 * a lookup on every CRM call that changes nothing.
 */
export async function resolveConnection(
  uid: string,
  deps: TokenDeps,
  now = Date.now(),
): Promise<ResolvedConnection> {
  const connection = await deps.read(uid)
  if (connection === undefined) throw new HlNotConnectedError()

  /*
   * Refused before the token is even looked at: a connection marked dead cannot be
   * revived by a refresh — that is what marked it — so attempting one costs a round
   * trip to learn what the document already says.
   */
  if (connection.needsReconnect) throw new HlReconnectRequiredError()

  // Fast path: no transaction, no lock, no round trip. This is what almost every
  // call takes, and keeping it out of a transaction is why a burst of preview
  // requests does not serialise.
  const accessToken = isFresh(connection.expiresAtMs, now)
    ? connection.accessToken
    : await deps.refresh(uid)

  return { accessToken, locationId: connection.locationId }
}
