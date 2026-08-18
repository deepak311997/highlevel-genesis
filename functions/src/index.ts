import { setGlobalOptions } from 'firebase-functions/v2'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'

import { createApiApp } from './api'
import { deleteExpiredUnverifiedUsers } from './auth/cleanup'
import { HL_CLIENT_SECRET } from './hl/config'
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
     * Both of the OAuth flow's secrets, and only they.
     *
     * Declared here rather than beside their readers, which is the opposite of
     * `ANTHROPIC_API_KEY`'s rule and deliberate: a `defineSecret` binds nothing
     * by itself — it is this list that grants the function access — and `api` is
     * one function assembled from a dozen routers, so the grant has to be stated
     * where the function is, not once per module that happens to read one.
     * `index.spec.ts` asserts both, and asserts `generate` has neither, because
     * the emulator resolves a secret from `process.env` whether it was granted
     * or not and so cannot tell a bound one from an unbound one.
     */
    secrets: [HL_CLIENT_SECRET, OAUTH_STATE_SECRET],
  },
  createApiApp(),
)

/**
 * The streaming endpoint lives in its own function so it can carry a long
 * timeout and a warm instance without the CRUD endpoints paying for either.
 *
 * **Its options are declared in `./generate`, not here** — the 540-second
 * timeout, the 512 MiB, and the `ANTHROPIC_API_KEY` secret binding. The secret
 * is the reason: `defineSecret` is called beside the code that reads it, and a
 * binding declared one file away from its reader is a binding that gets dropped
 * in a refactor of the wrong file. `index.spec.ts` asserts all three off
 * `__endpoint`, which is the only place a test can see them.
 */
export { generate } from './generate'

/**
 * The daily sweep of never-verified accounts — D18's fourth mitigation.
 *
 * An attacker can register someone else's address. Rules already make that
 * account inert, and a registration request can never alter an account it does
 * not control, so the account can reach nothing. What remains is that it *sits
 * there*: the real owner could be socially engineered into clicking "verify" on
 * it weeks later, and until then they cannot register the address themselves.
 * Expiring it closes that window instead of leaving it open indefinitely.
 *
 * This trigger was dropped once already, in an unrelated commit, and nothing
 * caught it — every test called the handler directly, so a sweep that no longer
 * ran still looked fully covered. `index.spec.ts` now asserts the export
 * exists, because the deployment surface is the one thing the other test levels
 * cannot see.
 *
 * Timezone is pinned rather than left to the deploy environment: "every 24
 * hours" against a floating zone makes the deletion window drift, and a
 * 24h-age check whose boundary moves is hard to reason about after the fact.
 */
export const cleanupUnverifiedUsers = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'Etc/UTC', memory: '256MiB', timeoutSeconds: 540 },
  async () => {
    await deleteExpiredUnverifiedUsers()
  },
)
