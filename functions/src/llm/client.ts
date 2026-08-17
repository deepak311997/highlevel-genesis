import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages'
import { defineSecret } from 'firebase-functions/params'

import { isEmulator } from '../lib/env'
import { buildFakeStream } from './fake'
import type { LlmStream } from './stream'

/**
 * The one place a generation is opened — the real model, or the emulator's fake.
 *
 * ## The secret
 *
 * `defineSecret` rather than a plain environment variable (D19): everything in
 * `functions/.env` is uploaded as a plain environment variable on the Cloud Run
 * service and is readable by anyone with Viewer on the project. The name is bound
 * to the `generate` function and to nothing else, so the CRUD function cannot
 * read it at all.
 *
 * ## The SDK is loaded lazily, and that is not a micro-optimisation
 *
 * `index.ts` re-exports `generate`, so **every** function in this codebase loads
 * the same module graph — a static `import Anthropic from '@anthropic-ai/sdk'`
 * would put the whole SDK on the `api` function's cold-start path for a
 * dependency it never uses. `import type` everywhere else and one
 * `await import()` here keeps it off. That is why this returns a promise.
 *
 * It is also `getDb()`'s rule: `firebase deploy` loads and analyses every module
 * *before* injecting config, so a client constructed at module scope is a client
 * constructed with no key.
 *
 * ## The fake is chosen on `isEmulator()` and nothing else (D20)
 *
 * See `fake.ts`. A config flag would be a remotely-settable way to replace the
 * model with a stub.
 */

export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')

/**
 * Open a generation.
 *
 * Called **before** the response headers are flushed, so everything that can go
 * wrong here — a missing key most of all — is still an ordinary JSON 500 rather
 * than an `error` frame on a 200 (D9).
 */
export async function openStream(params: MessageStreamParams): Promise<LlmStream> {
  if (isEmulator()) return buildFakeStream(params)

  /*
   * Validated explicitly, `getDb()`'s way. `SecretParam.value()` answers `''`
   * for a secret the function was not granted, with only a `warn` in the log —
   * which would otherwise surface as an opaque 401 from Anthropic on every
   * request, a long way from the binding that is actually missing.
   */
  const apiKey = ANTHROPIC_API_KEY.value().trim()
  if (apiKey === '') {
    throw new Error(
      'Missing ANTHROPIC_API_KEY. Set it with `firebase functions:secrets:set ' +
        'ANTHROPIC_API_KEY` — see functions/.env.example.',
    )
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk')

  // `MessageStream` satisfies `LlmStream` as-is: an async iterable of events with
  // an `abort()`. Nothing downstream knows which implementation it has.
  return new Anthropic({ apiKey }).messages.stream(params)
}
