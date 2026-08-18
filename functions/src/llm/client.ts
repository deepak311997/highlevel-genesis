import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages'
import { defineSecret } from 'firebase-functions/params'

import { emulatorFlag, isEmulator } from '../lib/env'
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
 * The emulator-only opt-in that puts the **real** model behind a local run.
 *
 * ## Why the fake needed an off switch
 *
 * `isEmulator()` alone meant local development could never see a generation.
 * Every local reply was `tests/fixtures/llm/reply.json` — real product prose,
 * two file blocks, delivered in about a second — which is indistinguishable from
 * a working app right up until you notice it answers every prompt identically.
 * That is a stub doing its job for the suites and actively misleading a human,
 * and the cost is a debugging session aimed at a streaming stack that was never
 * broken.
 *
 * ## Why this does not undo D20
 *
 * D20's objection is to a **remotely settable** way to replace the model, and to
 * anything a deploy could carry. `emulatorFlag` is neither. It resolves through
 * `emulatorOverride`, so it is read only under `FUNCTIONS_EMULATOR`; the name is
 * in no `.env` file, so it cannot be set by editing configuration; and a deployed
 * build ignores it however its environment is set — which `client.spec.ts`
 * asserts directly rather than leaving to the reader.
 *
 * The direction of the default is the other half. **Absent means fake**, so every
 * automated entry point — `test:unit`, `test:integration`, `test:e2e` — keeps the
 * stub by construction rather than by remembering to ask for it. CLAUDE.md's "the
 * LLM is always stubbed in automated tests" therefore survives a new test harness
 * written by somebody who has never read this comment. Only `npm run dev`, the
 * one script a human types, opts in.
 */
export const LOCAL_REAL_LLM = 'GENESIS_LOCAL_REAL_LLM'

/**
 * The value `functions/.secret.local.example` ships, and therefore the value a
 * fresh clone's `.secret.local` holds.
 *
 * It is non-blank, so the `=== ''` check below waves it through and Anthropic
 * answers `401` — an opaque upstream failure, reported to the user as "the reply
 * was interrupted", a long way from the file that caused it. That was harmless
 * while nothing local ever constructed an SDK client; {@link LOCAL_REAL_LLM} is
 * exactly the switch that makes it reachable, so it is refused by name here.
 */
export const PLACEHOLDER_KEY = 'emulator-placeholder-never-used'

/**
 * Open a generation.
 *
 * Called **before** the response headers are flushed, so everything that can go
 * wrong here — a missing key most of all — is still an ordinary JSON 500 rather
 * than an `error` frame on a 200 (D9).
 */
export async function openStream(params: MessageStreamParams): Promise<LlmStream> {
  if (isEmulator() && !emulatorFlag(LOCAL_REAL_LLM)) return buildFakeStream(params)

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
        'ANTHROPIC_API_KEY` — see functions/.env.example. Running locally with ' +
        `${LOCAL_REAL_LLM}=1? Put a real key in functions/.secret.local.`,
    )
  }

  /*
   * Refused by name rather than sent. See {@link PLACEHOLDER_KEY}: the message
   * names the file and the line, because the alternative is a 401 that says
   * nothing about either.
   */
  if (apiKey === PLACEHOLDER_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is still the placeholder that functions/.secret.local ' +
        'ships with. Replace it in functions/.secret.local with a real key — ' +
        'that file is gitignored, and the committed .secret.local.example must ' +
        'keep the placeholder.',
    )
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk')

  // `MessageStream` satisfies `LlmStream` as-is: an async iterable of events with
  // an `abort()`. Nothing downstream knows which implementation it has.
  return new Anthropic({ apiKey }).messages.stream(params)
}
