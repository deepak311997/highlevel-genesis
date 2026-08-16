import type { Request, Response } from 'express'
import type { Timestamp } from 'firebase-admin/firestore'

import { getDb } from '../lib/firebase'

/**
 * Reading and removing a connection.
 *
 * `hlConnections/{uid}` holds a live access token and a refresh token, and
 * `firestore.rules` denies it to every client — including its owner. That is
 * deliberate: a token in the browser is a token in the hands of anyone who
 * opens devtools, scoped to a whole CRM location. So the dashboard cannot read
 * the document, and asks here instead.
 *
 * What comes back is a projection, built by naming the fields to include rather
 * than by removing the ones to hide. An allowlist fails safe when the document
 * grows a field; a denylist ships it.
 */

export const CONNECTIONS = 'hlConnections'

interface ConnectionDocument {
  locationId?: string
  locationName?: string | null
  needsReconnect?: boolean
  connectedAt?: Timestamp
}

export interface ConnectionStatus {
  connected: boolean
  locationId?: string
  locationName?: string | null
  connectedAt?: string
  needsReconnect?: boolean
}

export async function handleGetConnection(
  _req: Request,
  res: Response,
  uid: string,
): Promise<void> {
  const snapshot = await getDb().doc(`${CONNECTIONS}/${uid}`).get()
  const data = snapshot.data() as ConnectionDocument | undefined

  if (data === undefined) {
    res.json({ connected: false })
    return
  }

  // Named one at a time. `...data` would have shipped the tokens the moment
  // someone added a field, and this is the response the browser reads.
  const status: ConnectionStatus = {
    connected: true,
    locationId: data.locationId ?? '',
    locationName: data.locationName ?? null,
    connectedAt: data.connectedAt?.toDate().toISOString() ?? '',
    needsReconnect: data.needsReconnect ?? false,
  }

  res.json(status)
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
