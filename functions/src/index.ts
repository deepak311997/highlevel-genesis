import { setGlobalOptions } from 'firebase-functions/v2'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'

import { createApiApp } from './api'
import { deleteExpiredUnverifiedUsers } from './auth/cleanup'

setGlobalOptions({ region: 'asia-south1', maxInstances: 10 })

/**
 * Short-lived request/response endpoints: OAuth callback, HighLevel proxy,
 * anything security rules cannot express. Fast cold start, small memory.
 */
export const api = onRequest(
  {
    timeoutSeconds: 60,
    memory: '256MiB',
    // firebase-functions wraps the handler in its own CORS layer, and left
    // unset it reflects whatever Origin it is given — outside the Express app,
    // so an allowlist inside it never gets a say. Turned off here so the
    // allowlist in ./api is the only thing answering.
    cors: false,
  },
  createApiApp(),
)

/**
 * The streaming endpoint lives in its own function so it can carry a long
 * timeout and a warm instance without the CRUD endpoints paying for either.
 */
export { generate } from './generate'

/**
 * Daily sweep of accounts that were never verified.
 *
 * The last of the account pre-hijacking mitigations: an attacker can register
 * someone else's address, and although that account can reach nothing, leaving
 * it in place leaves the victim available to be talked into verifying it. This
 * bounds that window to a day and frees the address for its real owner.
 */
export const cleanupUnverifiedUsers = onSchedule(
  { schedule: 'every 24 hours', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    await deleteExpiredUnverifiedUsers()
  },
)
