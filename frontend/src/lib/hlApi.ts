import { request } from './apiClient'

/**
 * The HighLevel connection endpoints.
 *
 * All three are authenticated, and none of them reads Firestore — which is now
 * true of the entire frontend rather than of this module in particular. The
 * reason is sharper here than elsewhere, though: `hlConnections/{uid}` holds a
 * live access token and a refresh token, so it was denied to every client
 * including its owner from the day it was created. What comes back from
 * `GET /hl/connection` is a redacted projection the server builds.
 */

/**
 * Exactly what the status endpoint returns — no tokens, ever.
 *
 * A discriminated union, mirroring the server's. `{ connected: true }` without
 * a location is a state the panel cannot render, so it is not expressible here
 * either; `hl.label` can then read `locationId` without a fallback.
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

export function getConnection(): Promise<ConnectionStatus> {
  return request<ConnectionStatus>('/api/hl/connection')
}

/** Returns the URL to navigate to; the caller does the navigating. */
export async function startConnect(): Promise<string> {
  const { authorizeUrl } = await request<{ authorizeUrl: string }>('/api/hl/connect', {
    method: 'POST',
  })
  return authorizeUrl
}

export async function disconnect(): Promise<void> {
  await request<{ ok: boolean }>('/api/hl/connection', { method: 'DELETE' })
}
