import { describe, expect, it } from 'vitest'

import { CHARS_PER_TOKEN, estimateTokens, PROJECT_FILE_BUDGET, TRANSCRIPT_BUDGET } from './budget'

/**
 * The two context budgets, and the estimator that reads them in tokens (D12, D13).
 *
 * Both numbers are stated **twice** — once in characters, which is the unit the
 * trimming code measures in, and once in tokens, which is the unit the decision was
 * made in. That is deliberate: a re-tune is meant to be "one edit and a test", and
 * without the second assertion an edit could quietly change what the PRD claims the
 * budget costs while every character-level test stayed green.
 */

describe('estimateTokens', () => {
  /*
   * Four characters per token, rounded up. Not the tokenizer — an exact count needs
   * `messages.count_tokens`, which is a network round trip and a charge on every
   * generation, to decide something a conservative estimate already decides safely.
   */
  it.each([
    ['an empty string', '', 0],
    ['exactly one token’s worth', 'abcd', 1],
    ['one character over', 'abcde', 2],
    ['a 4,097-character string', 'x'.repeat(4097), 1025],
  ])('estimates %s', (_label, input, expected) => {
    expect(estimateTokens(input)).toBe(expected)
  })

  it('rounds up rather than down, so the estimate never understates', () => {
    expect(estimateTokens('a')).toBe(1)
    expect(CHARS_PER_TOKEN).toBe(4)
  })
})

/**
 * D13's numbers. The worst cases are 20 × 100 KB of files (~500k tokens) and
 * 200 × 4,000 characters of transcript (~200k tokens); at $5/M input that is about a
 * dollar a generation for context nobody reads.
 */
describe('the budgets', () => {
  it('gives project files 120,000 characters, about 30,000 tokens', () => {
    expect(PROJECT_FILE_BUDGET).toBe(120_000)
    expect(estimateTokens('x'.repeat(PROJECT_FILE_BUDGET))).toBe(30_000)
  })

  it('gives the transcript 80,000 characters, about 20,000 tokens', () => {
    expect(TRANSCRIPT_BUDGET).toBe(80_000)
    expect(estimateTokens('x'.repeat(TRANSCRIPT_BUDGET))).toBe(20_000)
  })

  /*
   * Two independent budgets, not one pool (D12). A pooled budget would let a long
   * conversation evict the code — which is precisely the context F3.2 exists to
   * preserve — and it would make each failure mode global instead of local.
   */
  it('keeps the file budget larger than the transcript budget', () => {
    expect(PROJECT_FILE_BUDGET).toBeGreaterThan(TRANSCRIPT_BUDGET)
  })
})
