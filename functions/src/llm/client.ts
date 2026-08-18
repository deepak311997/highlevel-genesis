import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages'
import { defineSecret } from 'firebase-functions/params'

import { emulatorFlag, isEmulator } from '../lib/env'
import { buildFakeStream } from './fake'
import type { LlmStream } from './stream'

/**
 * The one place a generation is opened — the real model, or the emulator's fake.
 *
 * `defineSecret` rather than a plain environment variable: everything in
 * `functions/.env` is uploaded as plain Cloud Run environment and is readable by
 * anyone with Viewer. The name is bound to `generate` and nothing else.
 *
 * **The SDK is loaded lazily**, and that is not a micro-optimisation: `index.ts`
 * re-exports `generate`, so every function loads the same module graph, and a
 * static import would put the whole SDK on the `api` function's cold-start path
 * for a dependency it never uses. It is also why a client cannot be constructed
 * at module scope — `firebase deploy` analyses every module before injecting
 * config, so that client would have no key.
 *
 * The fake is chosen on `isEmulator()` and nothing else: a config flag would be a
 * remotely-settable way to replace the model with a stub.
 */

export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')

/**
 * The emulator-only opt-in that puts the **real** model behind a local run.
 *
 * Without it, local development could never see a generation: every reply was the
 * same fixture, delivered in about a second, indistinguishable from a working app
 * until you notice it answers every prompt identically.
 *
 * It does not undo the rule above, whose objection is to a *remotely settable*
 * switch. This resolves through `emulatorOverride`, so it is read only under
 * `FUNCTIONS_EMULATOR`, the name is in no `.env` file, and a deployed build
 * ignores it however its environment is set.
 *
 * **Absent means fake**, so every automated entry point keeps the stub by
 * construction rather than by remembering to ask for it. Only `npm run dev`, the
 * one script a human types, opts in.
 */
export const LOCAL_REAL_LLM = 'GENESIS_LOCAL_REAL_LLM'

/**
 * The value `functions/.secret.local.example` ships, and therefore what a fresh
 * clone holds. It is non-blank, so the empty check below waves it through and
 * Anthropic answers 401 — an opaque failure a long way from its cause. Refused by
 * name here instead.
 */
export const PLACEHOLDER_KEY = 'emulator-placeholder-never-used'

/**
 * Open a generation. Called **before** the response headers are flushed, so
 * everything that can go wrong here — a missing key most of all — is still an
 * ordinary JSON 500 rather than an `error` frame on a 200.
 */
export async function openStream(params: MessageStreamParams): Promise<LlmStream> {
  if (isEmulator() && !emulatorFlag(LOCAL_REAL_LLM)) return buildFakeStream(params)

  /*
   * Validated explicitly: `SecretParam.value()` answers `''` for a secret the
   * function was not granted, with only a warning — which would otherwise surface
   * as an opaque 401 a long way from the missing binding.
   */
  const apiKey = ANTHROPIC_API_KEY.value().trim()
  if (apiKey === '') {
    throw new Error(
      'Missing ANTHROPIC_API_KEY. Set it with `firebase functions:secrets:set ' +
        'ANTHROPIC_API_KEY` — see functions/.env.example. Running locally with ' +
        `${LOCAL_REAL_LLM}=1? Put a real key in functions/.secret.local.`,
    )
  }

  // Refused by name rather than sent: the message names the file and the line,
  // because the alternative is a 401 that says nothing about either.
  if (apiKey === PLACEHOLDER_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is still the placeholder that functions/.secret.local ' +
        'ships with. Replace it in functions/.secret.local with a real key — ' +
        'that file is gitignored, and the committed .secret.local.example must ' +
        'keep the placeholder.',
    )
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk')

  // `MessageStream` satisfies `LlmStream` as-is. Nothing downstream knows which
  // implementation it has.
  return new Anthropic({ apiKey }).messages.stream(params)
}
