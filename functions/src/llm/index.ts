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
export { estimateTokens, PROJECT_FILE_BUDGET, TRANSCRIPT_BUDGET } from './budget'
export { ANTHROPIC_API_KEY, openStream } from './client'
export { buildContext } from './context'
export { createFileCollector } from './fileops'
export { countHlCalls, extractHlCalls } from './hlCalls'
export type { HlCall } from './hlCalls'
/*
 * `hlKnowledge` is deliberately **not** re-exported: it is `prompt.ts`'s input
 * and nobody else's, and the shortest import is the one somebody reaches for by
 * accident. `PROJECT_FILE_OPEN` is here because the emulator-only fake reads it
 * back out of the assembled block (D25) — the delimiter has one definition, so
 * the builder and the reader cannot drift.
 */
export { buildProjectState, PROJECT_FILE_CLOSE, PROJECT_FILE_OPEN } from './projectState'
export type { ProjectFile } from './projectState'
export type { CollectorFrame, CollectResult, FileCollector } from './fileops'
export { buildParams, EFFORT, MAX_TOKENS, MODEL } from './params'
export { SYSTEM_PROMPT } from './prompt'
export { generateBodySchema } from './schema'
export type {
  DonePayload,
  ErrorPayload,
  FileChunkPayload,
  FileEndPayload,
  FileStartPayload,
  GenerateErrorCode,
  TokenPayload,
} from './schema'
export { mapStream, MAX_OUTPUT_BYTES } from './stream'
export type { LlmEvent, LlmStream, LlmUsage } from './stream'
