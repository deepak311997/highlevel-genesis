/**
 * How much context one generation may spend, and in what unit (D12, D13).
 *
 * ## Two budgets, never one pool
 *
 * The project's files and the chat transcript are measured separately. A single
 * pooled budget makes a long conversation able to evict the code, which is
 * precisely the context F3.2 exists to preserve — and it makes every failure
 * mode global, where two budgets make each one local and each test independent.
 *
 * ## Characters, because tokens cost a round trip
 *
 * An exact token count needs `messages.count_tokens`: a network call to
 * Anthropic and a charge, on **every** generation, to decide something a
 * conservative estimate already decides safely. Four characters per token is the
 * documented rule of thumb for English and for code, and {@link estimateTokens}
 * rounds up so the estimate never understates.
 *
 * The numbers are exported constants rather than literals at the two call sites,
 * so a re-tune is one edit and a test — and `budget.spec.ts` states each of them
 * in both units, so a re-tune cannot silently change what the PRD claims the
 * budget costs.
 */

/** The rule of thumb. Not the tokenizer, and deliberately not pretending to be. */
export const CHARS_PER_TOKEN = 4

/** Rounded up, so a budget check is never optimistic about what it is sending. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 120,000 characters — about 30,000 tokens — of project files.
 *
 * The pathological case is `FILE_LIMIT` × `FILE_BYTES_MAX` = 20 × 100 KB, some
 * 500,000 tokens. A realistic generated app is three to six files totalling
 * 20–120 KB, so this truncates only the pathological ones.
 */
export const PROJECT_FILE_BUDGET = 120_000

/**
 * 80,000 characters — about 20,000 tokens — of transcript.
 *
 * `CONTENT_MAX` caps one message at 4,000 characters, so this is at minimum
 * twenty full-length turns, against a collection hard-capped at 200 messages.
 */
export const TRANSCRIPT_BUDGET = 80_000
