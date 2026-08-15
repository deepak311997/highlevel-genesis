import { apiGet } from './api'

/** Response shape of `GET /api/health`. Mirrors functions/src/api/health.ts. */
export interface HealthResult {
  ok: boolean
  docId: string
  writeMs: number
  readMs: number
  roundTripMs: number
  serverTime: string
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResult> {
  return apiGet<HealthResult>('/api/health', signal)
}
