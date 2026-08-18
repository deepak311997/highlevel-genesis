/**
 * The LLM module's public surface.
 *
 * `generate.ts` imports one path rather than five, so the handler reads as
 * composition — parse, build context, build params, open, map — and the module's
 * internals stay free to move.
 *
 * **One rule, applied to every sibling: a module is re-exported only when
 * something outside this directory imports it.** `fake.ts`, `hlKnowledge.ts`,
 * `budget.ts` and `projectState.ts` are all internal — each is the input to
 * exactly one neighbour here (`client.ts`, `prompt.ts`, `context.ts`/
 * `projectState.ts`, and `params.ts` respectively) — so none of them appears
 * below. The shortest import is the one somebody reaches for by accident, and a
 * barrel entry nobody consumes is what makes that accident available.
 *
 * Slice 9 briefly re-exported `budget` and `projectState` anyway, which is why
 * the rule is now stated once rather than argued per module. Note in particular
 * that `fake.ts` reads `PROJECT_FILE_OPEN` straight from `./projectState` — the
 * delimiter having a single definition is a property of that import, and never
 * depended on a barrel entry.
 */
export { ANTHROPIC_API_KEY, openStream } from './client'
export { buildContext } from './context'
export { createFileCollector, writtenText } from './fileops'
export { countHlCalls, extractHlCalls } from './hlCalls'
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
