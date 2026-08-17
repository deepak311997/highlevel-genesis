import { FieldValue } from 'firebase-admin/firestore'
import { z } from 'zod'

import { CONNECTIONS } from './connection'
import { firestoreTimestamp } from '../users/schema'
import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import type { ConnectionSnapshot, TokenDeps } from './token'

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

function snapshotOf(data: unknown): ConnectionSnapshot | undefined {
  const parsed = storedTokensSchema.safeParse(data)
  if (!parsed.success) {
    logAuthEvent('hl.tokens.unreadable', { outcome: 'invalid' })
    return undefined
  }

  const { accessToken, expiresAt, locationId, needsReconnect } = parsed.data
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
      return snapshotOf(snapshot.data())
    },

    // T11 replaces this with the transactional rotation (D22, D23). Left to
    // throw plainly rather than to answer a plausible status, so that reaching
    // it before then is a 500 in a log and not a quiet `502 hl_unavailable`
    // that reads like a HighLevel blip.
    refresh: (): Promise<string> => {
      throw new Error('The transactional refresh lands in T11.')
    },
  }
}
