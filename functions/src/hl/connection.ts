import type { Request, Response } from 'express'
import type { Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'

import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'

/**
 * Reading and removing a connection.
 *
 * `hlConnections/{uid}` holds a live access token and a refresh token, and
 * `firestore.rules` denies it to every client including its owner: a token in the
 * browser is a token in the hands of anyone who opens devtools, scoped to a whole
 * CRM location. So the dashboard asks here instead.
 */

export const CONNECTIONS = 'hlConnections'

/** A Firestore Timestamp, recognised structurally rather than by instanceof. */
const timestamp = z.custom<Timestamp>(
  (value) => typeof (value as Timestamp | undefined)?.toMillis === 'function',
)

/**
 * The stored document, **parsed rather than asserted** — Firestore returns
 * whatever is there, including a half-written document from an older shape.
 *
 * Only the fields the projection needs are listed: the token fields exist and are
 * deliberately absent, so nothing that parses this can forward them.
 */
const storedConnection = z.object({
  locationId: z.string().min(1),
  locationName: z.string().nullable().catch(null),
  needsReconnect: z.boolean().catch(false),
  connectedAt: timestamp.optional(),
})

/**
 * A discriminated union, not a bag of optionals. `{ connected: boolean,
 * locationId?: string }` permits `{ connected: true }` with no location — a state
 * the UI would render as "Connected to" followed by nothing, with no Connect
 * button. Distinct shapes remove it from the type rather than from the tests.
 */
export type ConnectionStatus =
  | { connected: false }
  | {
      connected: true
      locationId: string
      locationName: string | null
      connectedAt: string | null
      needsReconnect: boolean
    }

export async function handleGetConnection(
  _req: Request,
  res: Response,
  uid: string,
): Promise<void> {
  const snapshot = await getDb().doc(`${CONNECTIONS}/${uid}`).get()

  if (!snapshot.exists) {
    res.json({ connected: false } satisfies ConnectionStatus)
    return
  }

  const parsed = storedConnection.safeParse(snapshot.data())
  if (!parsed.success) {
    /*
     * Fail closed, and say so in the log. Reporting a connection with empty
     * strings hides corruption behind a screen the user cannot act on; "not
     * connected" is truthful and recoverable, because reconnecting overwrites the
     * document.
     */
    logAuthEvent('hl.connection.unreadable', { outcome: 'invalid' })
    res.json({ connected: false } satisfies ConnectionStatus)
    return
  }

  const { locationId, locationName, needsReconnect, connectedAt } = parsed.data
  res.json({
    connected: true,
    locationId,
    locationName,
    needsReconnect,
    connectedAt: connectedAt?.toDate().toISOString() ?? null,
  } satisfies ConnectionStatus)
}

/**
 * Deletes our record and nothing else — the app stays installed on HighLevel's
 * side, since there is no documented revoke endpoint and a revoke that failed
 * would leave a half-disconnected state to design around.
 *
 * Idempotent: a stale panel, a double click and a retry after a timeout all arrive
 * here, and answering 404 puts an error on screen for a user who has what they
 * asked for.
 */
export async function handleDeleteConnection(
  _req: Request,
  res: Response,
  uid: string,
): Promise<void> {
  await getDb().doc(`${CONNECTIONS}/${uid}`).delete()
  res.json({ ok: true })
}
