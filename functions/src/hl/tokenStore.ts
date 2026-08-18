import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'

import { CONNECTIONS } from './connection'
import { firestoreTimestamp } from '../users/schema'
import { getDb } from '../lib/firebase'
import { isDefinitiveRefreshFailure } from './proxyError'
import { logAuthEvent } from '../lib/log'
import { refreshTokens } from './exchange'
import { openToken, sealToken } from './tokenCrypto'
import {
  HlNotConnectedError,
  HlReconnectRequiredError,
  HlRefreshUnavailableError,
  isFresh,
  type ConnectionSnapshot,
  type TokenDeps,
} from './token'
import type { TokenResponse } from './schema'

/**
 * The Firestore side of {@link TokenDeps}.
 *
 * `token.ts` owns the decision — is the stored token still good enough — and is
 * pure; this file owns the effect: reading the document, and rotating it inside a
 * transaction.
 *
 * **Parsed, never asserted.** Firestore returns whatever is in the document,
 * including a half-written one from an interrupted `set`. A document that cannot
 * describe a usable connection is reported as **no connection**, which is the
 * truthful answer because reconnecting overwrites it. The log line that keeps
 * that from being silent carries **no field of the document** — this one holds a
 * live access token and a refresh token.
 */

/**
 * The token fields, which `connection.ts`'s projection schema deliberately does
 * not list. This is the one schema that may see them, and its output never leaves
 * the server.
 *
 * `needsReconnect` gets a `.catch(false)` and the other four do not: a missing
 * flag is safely "not marked", a missing token or expiry is a document we cannot
 * use at all.
 */
const storedTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: firestoreTimestamp,
  locationId: z.string().min(1),
  needsReconnect: z.boolean().catch(false),
})

type StoredTokens = z.infer<typeof storedTokensSchema>

function parseStored(data: unknown): StoredTokens | undefined {
  const parsed = storedTokensSchema.safeParse(data)
  if (!parsed.success) {
    logAuthEvent('hl.tokens.unreadable', { outcome: 'invalid' })
    return undefined
  }

  /*
   * **Unsealed here, in the one place that reads them.** Both callers below come
   * through this function, so the tokens are ciphertext everywhere above Firestore
   * and plaintext for exactly as long as a request needs them.
   *
   * A value that will not open — a rotated secret, a truncated document — is
   * reported as *no connection*, the same answer an unparseable one gets and for
   * the same reason: reconnecting overwrites the document, so it is the fix.
   */
  try {
    return {
      ...parsed.data,
      accessToken: openToken(parsed.data.accessToken),
      refreshToken: openToken(parsed.data.refreshToken),
    }
  } catch {
    logAuthEvent('hl.tokens.unreadable', { outcome: 'invalid' })
    return undefined
  }
}

/**
 * The projection the port sees — **narrower on purpose**.
 *
 * `ConnectionSnapshot` carries no `refreshToken`, so the pure decision layer
 * cannot hold one, log one or return one. The refresh token is read exactly once,
 * inside the transaction below, where the only thing done with it is to spend it.
 */
function snapshotOf(stored: StoredTokens): ConnectionSnapshot {
  const { accessToken, expiresAt, locationId, needsReconnect } = stored
  return { accessToken, expiresAtMs: expiresAt.toMillis(), locationId, needsReconnect }
}

/**
 * Record that only the user can fix this connection.
 *
 * A plain `update`: there is nothing to read first. It touches **nothing else** —
 * in particular it does not clear the refresh token, because the first rule is
 * never to destroy a token that may still be valid, and reconnecting overwrites
 * the document anyway.
 *
 * **Best effort, and that is the point.** This write races a disconnect, which
 * hard-deletes; unguarded, the rejection would escape and answer `500 internal`,
 * so the marking — an optimisation for the *next* call — would have eaten the
 * `409 hl_reconnect_required` this one is owed.
 */
export async function markNeedsReconnect(uid: string): Promise<void> {
  try {
    await getDb()
      .doc(`${CONNECTIONS}/${uid}`)
      .update({ needsReconnect: true, updatedAt: FieldValue.serverTimestamp() })
  } catch {
    // No field of the document, and no uid: this collection holds live tokens,
    // and "which write failed" is not a diagnostic worth the risk.
    logAuthEvent('hl.mark_reconnect_failed', { outcome: 'invalid' })
  }
}

export function firestoreTokenDeps(): TokenDeps {
  return {
    /**
     * One read, outside any transaction — the path almost every proxied call
     * takes, so a burst against a fresh token does not serialise.
     */
    read: async (uid: string): Promise<ConnectionSnapshot | undefined> => {
      const snapshot = await getDb().doc(`${CONNECTIONS}/${uid}`).get()
      if (!snapshot.exists) return undefined
      const stored = parseStored(snapshot.data())
      return stored === undefined ? undefined : snapshotOf(stored)
    },

    refresh: (uid: string): Promise<string> => rotate(uid),
  }
}

/** What the transaction body decided, so the throwing happens outside it. */
type Rotation =
  | { kind: 'gone' }
  | { kind: 'dead' }
  | { kind: 'reused'; accessToken: string }
  | { kind: 'rotated'; accessToken: string }

/**
 * Rotate the connection's tokens, transactionally.
 *
 * **The network call is inside the transaction because that is what makes it
 * safe.** HighLevel rotates refresh tokens on use: each refresh issues a new one
 * and invalidates the one presented, so two callers finding an expired access
 * token would both rotate, one would win, and the loser would present a spent
 * token — `invalid_grant`, and a connection dead until the user reinstalls.
 *
 * Three properties close that, all of them here:
 *
 * 1. Firestore read-write transactions are **pessimistic**, so the second caller
 *    queues on `tx.get` rather than racing.
 * 2. The body **re-reads and short-circuits**, finding the token the first caller
 *    already rotated.
 * 3. A **retry of this same transaction reuses the grant it already bought**.
 *
 * The third is not the second. A retried transaction re-enters the body against a
 * document its own aborted attempt did not change — the staged `tx.update` was
 * rolled back — so the re-read finds the same stale token and short-circuits on
 * neither, and would present a refresh token the first attempt had already spent.
 * A rollback cannot un-spend a network call, so the fix is not to make it twice:
 * `spent` lives outside the body and survives a retry.
 *
 * **On `invalid_grant` the transaction must commit.** The refusal is returned as
 * a sentinel and thrown after `runTransaction` resolves, because throwing inside
 * the body would abort it and discard `needsReconnect: true` with everything else.
 *
 * The rejected alternative is a `lease` field claimed in one transaction with the
 * call outside it: correct, and the right answer for a system with real
 * concurrency, but it buys an expiry policy, a stale-lease sweep and a third
 * failure mode for a hazard measured to be survivable.
 */
async function rotate(uid: string): Promise<string> {
  const db = getDb()
  const ref = db.doc(`${CONNECTIONS}/${uid}`)

  /*
   * What this call has already bought from HighLevel, held **outside** the
   * transaction body so a retry can see it.
   *
   * Keyed by the refresh token that was presented: if the document has moved on to
   * one we did not spend, somebody else rotated and their grant is current —
   * writing ours over it would orphan theirs.
   */
  let spent: { refreshToken: string; issued: TokenResponse } | undefined

  const outcome = await db.runTransaction<Rotation>(async (tx) => {
    const snapshot = await tx.get(ref)
    const stored = snapshot.exists ? parseStored(snapshot.data()) : undefined
    if (stored === undefined) return { kind: 'gone' }

    // Somebody else may have rotated while this caller was blocked on their lock,
    // and a retried transaction re-enters here.
    if (isFresh(stored.expiresAt.toMillis(), Date.now())) {
      return { kind: 'reused', accessToken: stored.accessToken }
    }

    let next: TokenResponse
    if (spent?.refreshToken === stored.refreshToken) {
      // A retry. The grant is bought and paid for; re-presenting the token that
      // bought it is what would kill the connection.
      next = spent.issued
    } else {
      try {
        next = await refreshTokens(stored.refreshToken)
        spent = { refreshToken: stored.refreshToken, issued: next }
      } catch (err) {
        if (isDefinitiveRefreshFailure(err)) {
          /*
           * The flag, and **nothing else** — in particular the refresh token is
           * left as it is: never destroy a token that may still be valid, and
           * reconnecting overwrites the document anyway.
           */
          tx.update(ref, { needsReconnect: true, updatedAt: FieldValue.serverTimestamp() })
          return { kind: 'dead' }
        }

        // Aborts the transaction, so nothing is written. A 5xx, a network error
        // and a timeout say nothing about the connection, and a blip recorded as
        // a dead connection is unrecoverable without a reinstall.
        throw new HlRefreshUnavailableError()
      }
    }

    // Sealed on the way down, which is also the migration: a connection stored
    // before this existed is read as plaintext once and written back sealed.
    tx.update(ref, {
      accessToken: sealToken(next.access_token),
      refreshToken: sealToken(next.refresh_token),
      expiresAt: Timestamp.fromMillis(Date.now() + next.expires_in * 1000),
      updatedAt: FieldValue.serverTimestamp(),
    })
    return { kind: 'rotated', accessToken: next.access_token }
  })

  if (outcome.kind === 'gone') throw new HlNotConnectedError()
  if (outcome.kind === 'dead') throw new HlReconnectRequiredError()
  return outcome.accessToken
}
