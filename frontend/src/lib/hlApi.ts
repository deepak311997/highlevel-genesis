import { ApiError, apiUrl, messageForResponse } from './api'
import { appCheckHeader } from './appCheck'
import { auth } from './firebase'

/**
 * The HighLevel connection endpoints.
 *
 * All three are authenticated, and none of them reads Firestore. That is not an
 * oversight: `hlConnections/{uid}` holds a live access token and a refresh
 * token, and security rules deny it to every client including its owner, so the
 * browser has no path to it at all. What comes back from `GET /hl/connection`
 * is a redacted projection the server builds.
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

/**
 * The ID token for the current user.
 *
 * Read per request rather than cached: Firebase rotates it roughly hourly, and
 * a stale one produces a 401 on a tab that has merely been left open.
 */
async function authHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser
  if (user === null) throw new ApiError('Sign in and try again.', 401)
  return { Authorization: `Bearer ${await user.getIdToken()}` }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    ...(await authHeader()),
    ...(await appCheckHeader()),
  }

  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new ApiError('Something went wrong. Check your connection and try again.', 0)
  }

  if (!res.ok) throw new ApiError(await messageForResponse(res), res.status)
  return (await res.json()) as T
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
