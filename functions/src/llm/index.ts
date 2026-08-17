/**
 * The LLM module's public surface.
 *
 * `generate.ts` imports one path rather than five, so the handler reads as
 * composition — parse, build context, build params, open, map — and the module's
 * internals stay free to move.
 *
 * `fake.ts` is deliberately **not** re-exported. Nothing outside `client.ts` has
 * any business constructing it, and the shortest import is the one somebody
 * reaches for by accident.
 */
export { ANTHROPIC_API_KEY, openStream } from './client'
export { buildContext } from './context'
export { buildParams, EFFORT, MAX_TOKENS, MODEL } from './params'
export { SYSTEM_PROMPT } from './prompt'
export { generateBodySchema } from './schema'
export type { DonePayload, ErrorPayload, GenerateErrorCode, TokenPayload } from './schema'
export { mapStream, MAX_OUTPUT_BYTES } from './stream'
export type { LlmEvent, LlmStream, LlmUsage } from './stream'
