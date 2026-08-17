import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'

import { CONNECTIONS } from './connection'
import { firestoreTimestamp } from '../users/schema'
import { getDb } from '../lib/firebase'
import { isDefinitiveRefreshFailure } from './proxyError'
import { logAuthEvent } from '../lib/log'
import { refreshTokens } from './exchange'
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
 * The Firestore side of {@link TokenDeps} — the adapter Slice 2 deferred.
 *
 * `token.ts` owns the *decision* ("is the stored token still good enough?") and
 * is pure. This file owns the *effect*: reading the document, and rotating it
 * inside a transaction. Slice 2's review cut this half on the grounds that
 * nothing consumed it yet; the proxy is that consumer.
 *
 * ## Parsed, never asserted
 *
 * `snapshot.data() as StoredTokens` is a lie the compiler believes. Firestore
 * returns whatever is in the document, including a half-written one from an
 * interrupted `set` or an older shape. A document that cannot describe a usable
 * connection is therefore *known* not to, and is reported as **no connection**
 * — `handleGetConnection`'s precedent, and the truthful answer, because
 * reconnecting overwrites the document and repairs it.
 *
 * The log line that stops that being silent carries **no field of the
 * document**: this one holds a live access token and a refresh token, so
 * "which field failed to parse" is not a diagnostic worth the risk.
 */

/**
 * The token fields, which `connection.ts`'s projection schema deliberately does
 * not list — nothing that parses *that* can accidentally forward a credential.
 * This is the one schema that may see them, and its output never leaves the
 * server.
 *
 * `needsReconnect` gets a `.catch(false)` and the other four do not: a missing
 * flag is safely read as "not marked", while a missing token or expiry is a
 * document we cannot use at all.
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
  return parsed.data
}

/**
 * The projection the port sees — and it is **narrower on purpose**.
 *
 * `ConnectionSnapshot` carries no `refreshToken`, so `token.ts`'s pure decision
 * layer cannot hold one, cannot log one and cannot return one. The refresh
 * token is read exactly once, inside the transaction below, where the only
 * thing done with it is to spend it. Projecting here rather than passing
 * `parsed.data` around is what keeps that true by construction instead of by
 * everyone remembering.
 */
function snapshotOf(stored: StoredTokens): ConnectionSnapshot {
  const { accessToken, expiresAt, locationId, needsReconnect } = stored
  return { accessToken, expiresAtMs: expiresAt.toMillis(), locationId, needsReconnect }
}

/**
 * Record that only the user can fix this connection (D20, D26).
 *
 * A plain `update`, not a transaction: there is nothing to read first, and
 * setting a flag that is already set is the same document either way. It
 * deliberately touches **nothing else** — in particular it does not clear the
 * refresh token, because §3's first rule is never to destroy a token that may
 * still be valid, and reconnecting overwrites the document anyway.
 */
export async function markNeedsReconnect(uid: string): Promise<void> {
  await getDb()
    .doc(`${CONNECTIONS}/${uid}`)
    .update({ needsReconnect: true, updatedAt: FieldValue.serverTimestamp() })
}

export function firestoreTokenDeps(): TokenDeps {
  return {
    /**
     * One read, outside any transaction.
     *
     * This is the path almost every proxied call takes, and keeping it out of a
     * transaction is why a burst of preview requests against a fresh token does
     * not serialise.
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
 * Rotate the connection's tokens, transactionally (D22, D23).
 *
 * ## Why the network call is inside the transaction
 *
 * Because that is what makes it safe, not in spite of it. HighLevel rotates
 * refresh tokens on use: each refresh issues a new one and invalidates the one
 * presented. So two callers who both find an expired access token would both
 * try to rotate, one would win, and the loser would present a token that had
 * already been spent — `invalid_grant`, and a connection dead until the user
 * reinstalls.
 *
 * Two properties close that, and both live in this function:
 *
 * 1. Firestore read-write transactions are **pessimistic**. The second caller's
 *    `tx.get` on this document blocks until the first commits, so the two do not
 *    race — they queue.
 * 2. The body **re-reads and short-circuits**. Having waited, the second caller
 *    finds a token the first already rotated and returns it, and a transaction
 *    that Firestore *retried* re-enters here and does the same. That is what
 *    stops a retry from re-spending a refresh token.
 *
 * The honest residue, which the PRD measured rather than assumed: if locking
 * ever failed to serialise the two, both would refresh, both would succeed, and
 * one refresh token would be orphaned — survivable, because HighLevel accepts a
 * reused refresh token at least once (§3, corrected 2026-08-16).
 *
 * ## The mistake this shape exists to avoid
 *
 * **On `invalid_grant` the transaction must commit.** The refusal is carried out
 * as a returned sentinel and thrown *after* `runTransaction` resolves, because
 * throwing from inside the body would abort it and discard `needsReconnect:
 * true` along with everything else — and the failure would read like a
 * Firestore bug rather than a control-flow one.
 *
 * The rejected alternative is a `lease` field claimed in one transaction with
 * the network call outside it: correct, and the right answer for a system with
 * real concurrency, but it buys a lock with an expiry policy, a stale-lease
 * sweep and a third failure mode, for a hazard that has been measured to be
 * survivable.
 */
async function rotate(uid: string): Promise<string> {
  const db = getDb()
  const ref = db.doc(`${CONNECTIONS}/${uid}`)

  const outcome = await db.runTransaction<Rotation>(async (tx) => {
    const snapshot = await tx.get(ref)
    const stored = snapshot.exists ? parseStored(snapshot.data()) : undefined
    if (stored === undefined) return { kind: 'gone' }

    // Property 2. Somebody else may have rotated while this caller was blocked
    // on their lock, and a retried transaction re-enters here.
    if (isFresh(stored.expiresAt.toMillis(), Date.now())) {
      return { kind: 'reused', accessToken: stored.accessToken }
    }

    let next: TokenResponse
    try {
      next = await refreshTokens(stored.refreshToken)
    } catch (err) {
      if (isDefinitiveRefreshFailure(err)) {
        /*
         * The flag, and **nothing else**. In particular the refresh token is
         * left exactly as it is: §3's first rule is never to destroy a token
         * that may still be valid, and reconnecting overwrites the document
         * anyway, so clearing it buys nothing and costs the one piece of
         * evidence a support conversation would want.
         */
        tx.update(ref, { needsReconnect: true, updatedAt: FieldValue.serverTimestamp() })
        return { kind: 'dead' }
      }

      // Aborts the transaction, so nothing at all is written (D26). A 5xx, a
      // network error and a timeout say nothing about the connection, and a
      // blip recorded as a dead connection is unrecoverable without a
      // reinstall.
      throw new HlRefreshUnavailableError()
    }

    tx.update(ref, {
      accessToken: next.access_token,
      refreshToken: next.refresh_token,
      expiresAt: Timestamp.fromMillis(Date.now() + next.expires_in * 1000),
      updatedAt: FieldValue.serverTimestamp(),
    })
    return { kind: 'rotated', accessToken: next.access_token }
  })

  if (outcome.kind === 'gone') throw new HlNotConnectedError()
  if (outcome.kind === 'dead') throw new HlReconnectRequiredError()
  return outcome.accessToken
}
