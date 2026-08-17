import { API_BASE } from '../integration/helpers'

/**
 * Warm the functions runtime before the first test measures anything.
 *
 * The functions emulator does not spin up a Node worker until something calls a
 * function, so the *first* request of an e2e run pays for the whole bundle
 * loading — several seconds — while every request after it costs milliseconds.
 * That cost lands inside whichever assertion happens to be first, and it lands
 * there invisibly: the run that caught this had `auth.spec.ts` fail its 5-second
 * wait for the sign-up confirmation, with the emulator log showing the register
 * handler itself finishing in 134ms *after* the failure was recorded. The
 * preceding run passed the same assertion with the same code. Nothing about the
 * app was slow; the runtime had simply not booted yet.
 *
 * Waiting here instead is the honest fix. It changes no assertion and relaxes no
 * timeout — the first test still has to answer within the same 5 seconds, only
 * now from the same warm runtime every other test enjoys.
 *
 * `/health` is the right thing to call: unauthenticated, so it needs no fixture,
 * and it writes and deletes its own throwaway document, so it warms the Admin
 * SDK's Firestore path too and leaves nothing behind for `resetEmulators` to
 * find.
 */
const ATTEMPTS = 40
const RETRY_MS = 500

export default async function globalSetup(): Promise<void> {
  let lastError = 'no attempt was made'

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${API_BASE}/health`)
      if (res.ok) return
      lastError = `HTTP ${String(res.status)}`
    } catch (error) {
      // Connection refused until the emulator finishes binding its port. That is
      // expected on the first attempts and is not worth reporting unless it is
      // still happening when the attempts run out.
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
  }

  throw new Error(
    `the functions emulator never answered GET ${API_BASE}/health after ` +
      `${String(ATTEMPTS)} attempts (last: ${lastError}). e2e tests must run under ` +
      '`npm run test:e2e`, which starts the emulators around them.',
  )
}
