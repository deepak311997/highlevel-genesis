/**
 * How much context one generation may spend, and in what unit.
 *
 * **Two budgets, never one pool.** A pooled budget makes a long conversation able
 * to evict the project's code, which is precisely the context this exists to
 * preserve — and it makes every failure mode global where two make each one local.
 *
 * **Characters, because tokens cost a round trip.** An exact count needs a network
 * call and a charge on every generation to decide what a conservative estimate
 * already decides safely. Four characters per token is the documented rule of
 * thumb, and {@link estimateTokens} rounds up so the estimate never understates.
 */

/** The rule of thumb. Not the tokenizer, and deliberately not pretending to be. */
export const CHARS_PER_TOKEN = 4

/** Rounded up, so a budget check is never optimistic about what it is sending. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 120,000 characters — about 30,000 tokens — of project files. The pathological
 * case is 20 × 100 KB, some 500,000 tokens; a realistic generated app is three to
 * six files totalling 20–120 KB.
 */
export const PROJECT_FILE_BUDGET = 120_000

/**
 * 80,000 characters — about 20,000 tokens — of transcript, which is at least
 * twenty full-length prompts.
 *
 * **It does not bound an assistant turn**: the stored schema carries no maximum on
 * content, so a reply is bounded only by the 800,000-byte output cap. One long
 * generation can consume this whole budget by itself, which is what makes
 * `context.ts`'s floor a path that really runs.
 */
export const TRANSCRIPT_BUDGET = 80_000
