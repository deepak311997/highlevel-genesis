import type { Request, Response } from 'express'
import type { Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'

import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'

/**
 * Reading and removing a connection.
 *
 * `hlConnections/{uid}` holds a live access token and a refresh token, and
 * `firestore.rules` denies it to every client — including its owner. That is
 * deliberate: a token in the browser is a token in the hands of anyone who
 * opens devtools, scoped to a whole CRM location. So the dashboard cannot read
 * the document, and asks here instead.
 */

export const CONNECTIONS = 'hlConnections'

/** A Firestore Timestamp, recognised structurally rather than by instanceof. */
const timestamp = z.custom<Timestamp>(
  (value) => typeof (value as Timestamp | undefined)?.toMillis === 'function',
)

/**
 * The stored document, **parsed rather than asserted**.
 *
 * A `snapshot.data() as T` is a lie the compiler believes: Firestore returns
 * whatever is there, including a half-written document from an older shape or
 * an interrupted write. Parsing means a document that cannot describe a
 * connection is *known* not to, rather than being read field by field and
 * quietly filled in with blanks.
 *
 * Only the fields the projection needs are listed. The token fields exist and
 * are deliberately absent here — nothing that parses this can accidentally
 * forward them.
 */
const storedConnection = z.object({
  locationId: z.string().min(1),
  locationName: z.string().nullable().catch(null),
  needsReconnect: z.boolean().catch(false),
  connectedAt: timestamp.optional(),
})

/**
 * A discriminated union, not a bag of optionals.
 *
 * `{ connected: boolean, locationId?: string }` permits `{ connected: true }`
 * with no location, which is a state the UI has no way to render — it would
 * show "Connected to" followed by nothing, with no Connect button, because the
 * panel only offers one when it believes you are disconnected. Making the
 * shapes distinct removes that state from the type rather than from the tests.
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
     * Fail closed, and say so in the log.
     *
     * The alternative — reporting a connection with empty strings in it — hides
     * the corruption behind a screen the user cannot act on. Reporting "not
     * connected" is both truthful (we cannot use this) and recoverable, because
     * reconnecting overwrites the document. The log line is what stops it being
     * silent; no field of the document is included in it.
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
 * Deletes our record and nothing else.
 *
 * The app stays installed on HighLevel's side. There is no documented revoke
 * endpoint, and a revoke that failed would leave a half-disconnected state to
 * design around; reconnecting simply replaces the record, which is also how
 * switching to a different location works.
 *
 * Idempotent on purpose. The UI cannot be certain it is connected — a stale
 * panel, a double click, a retry after a timeout — and answering 404 to any of
 * those puts an error on screen for a user who already has what they asked for.
 */
export async function handleDeleteConnection(
  _req: Request,
  res: Response,
  uid: string,
): Promise<void> {
  await getDb().doc(`${CONNECTIONS}/${uid}`).delete()
  res.json({ ok: true })
}
