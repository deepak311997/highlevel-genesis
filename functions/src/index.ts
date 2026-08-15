import { setGlobalOptions } from 'firebase-functions/v2'
import { onRequest } from 'firebase-functions/v2/https'

import { createApiApp } from './api'

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
 * The daily sweep of never-verified accounts is deliberately NOT deployed.
 *
 * `deleteExpiredUnverifiedUsers` in ./auth/cleanup is written and tested, but
 * no trigger is exported, so nothing runs it in production. That leaves one of
 * D18's mitigations unshipped: an account an attacker registered at someone
 * else's address now persists indefinitely rather than expiring after a day.
 *
 * What still holds without it: Firestore rules deny an unverified token every
 * read and write, so such an account can reach nothing, and a registration
 * request can never alter an account that already exists. The residual is a
 * victim who is talked into clicking "verify" on an account they did not
 * create — and that window no longer closes on its own.
 *
 * Re-export an onSchedule trigger here to turn it back on.
 */
