import { setGlobalOptions } from 'firebase-functions/v2'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'

import { ALLOWED_ORIGINS, createApiApp } from './api'
import { deleteExpiredUnverifiedUsers } from './auth/cleanup'
import { HL_CLIENT_ID, HL_CLIENT_SECRET, HL_REDIRECT_URI, HL_VERSION_ID } from './hl/config'
import { OAUTH_STATE_SECRET } from './hl/state'

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
    /*
     * Everything the OAuth flow and the CORS layer are configured with.
     *
     * Stated here rather than beside each reader — the opposite of the model key's
     * rule, and deliberate: a `defineSecret` binds nothing by itself, it is *this
     * list* that grants access, and `api` is one function assembled from a dozen
     * routers.
     *
     * Only two are credentials. The other four are configuration that lived in
     * `functions/.env` until that file's synthesis started printing every line into
     * a world-readable deploy log.
     *
     * `index.spec.ts` asserts all six, because the emulator resolves a secret from
     * `process.env` whether it was granted or not.
     */
    secrets: [
      HL_CLIENT_SECRET,
      OAUTH_STATE_SECRET,
      HL_CLIENT_ID,
      HL_VERSION_ID,
      HL_REDIRECT_URI,
      ALLOWED_ORIGINS,
    ],
  },
  createApiApp(),
)

/**
 * The streaming endpoint lives in its own function so it can carry a long timeout
 * and more memory without the CRUD endpoints paying for either.
 *
 * **Its options are declared in `./generate`, not here.** The secret is the
 * reason: `defineSecret` belongs beside the code that reads it, and a binding one
 * file away from its reader gets dropped in a refactor of the wrong file.
 */
export { generate } from './generate'

/**
 * The daily sweep of never-verified accounts.
 *
 * An attacker can register someone else's address. Rules make that account inert
 * and it can reach nothing; what remains is that it *sits there*, so the real
 * owner cannot register the address themselves and could be talked into verifying
 * it weeks later. Expiring it closes that window.
 *
 * This trigger was dropped once already in an unrelated commit and nothing caught
 * it — every test called the handler directly — so `index.spec.ts` asserts the
 * export exists. The timezone is pinned, because a 24-hour age check whose
 * boundary drifts is hard to reason about after the fact.
 */
export const cleanupUnverifiedUsers = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'Etc/UTC', memory: '256MiB', timeoutSeconds: 540 },
  async () => {
    await deleteExpiredUnverifiedUsers()
  },
)
