import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'

import { buildParams, EFFORT, MAX_TOKENS, MODEL } from './params'
import { SYSTEM_PROMPT } from './prompt'

/**
 * The request parameters — AC-6, and three decisions that are easy to undo by
 * accident.
 *
 * The model id and `max_tokens` are `CLAUDE.md`'s non-negotiables, pinned to
 * exact values rather than "starts with claude" so a downgrade is a failing test
 * and not a quieter bill.
 *
 * **There is no `thinking` key, and that is the decision** (D14). Thinking is on
 * by default on `claude-opus-5`, so omitting the field is a choice either way;
 * `{ type: 'disabled' }` carries a documented Opus-5 failure mode this slice
 * cannot afford — with thinking off the model can leak `<thinking>` tags into its
 * *visible* output, which is ugly in a chat bubble today and corruption from
 * Slice 6, when that same text is parsed into files. A key appearing here later
 * should be a deliberate change with this case rewritten, not a silent one.
 */

const CONTEXT: MessageParam[] = [{ role: 'user', content: 'build a contact dashboard' }]

describe('buildParams', () => {
  /** `CLAUDE.md`'s non-negotiable, pinned exactly. */
  it('asks for claude-opus-5', () => {
    expect(MODEL).toBe('claude-opus-5')
    expect(buildParams([]).model).toBe('claude-opus-5')
  })

  /*
   * 64,000, which also *requires* streaming to avoid the SDK's HTTP timeout —
   * the same constraint the brief states from the other side.
   */
  it('asks for 64,000 output tokens', () => {
    expect(MAX_TOKENS).toBe(64_000)
    expect(buildParams([]).max_tokens).toBe(64_000)
  })

  /*
   * D15. `low` for this slice: it keeps thinking short, so D14's pause before
   * the first token stays small, and it keeps a whole turn well inside the
   * window a Hosting rewrite is known to tolerate (R2). **Slice 9 re-tunes this**
   * against real HighLevel prompts, where `high` or `xhigh` is the documented
   * starting point — recorded so that change reads as planned rather than churn.
   */
  it('asks for effort low', () => {
    expect(EFFORT).toBe('low')
    expect(buildParams([]).output_config?.effort).toBe('low')
  })

  /*
   * The *same array*, not a copy and not a copy with something appended. Anything
   * added above the breakpoint per call would make every request a cache miss
   * once Slice 9 makes caching real, and nothing would report it.
   */
  it('sends the system prompt itself, with nothing appended', () => {
    expect(buildParams([]).system).toBe(SYSTEM_PROMPT)
  })

  /** D14. Absence is the assertion. */
  it('carries no thinking key at all', () => {
    expect(Object.keys(buildParams([]))).not.toContain('thinking')
    expect('thinking' in buildParams([])).toBe(false)
  })

  it('passes the context through untouched', () => {
    expect(buildParams(CONTEXT).messages).toBe(CONTEXT)
  })

  /* Nothing else. A parameter that arrived by accident is a parameter nobody
   * decided, and this endpoint spends money. */
  it('sends exactly the five parameters that were decided', () => {
    expect(Object.keys(buildParams([])).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
    ])
  })
})

/**
 * AC-6's second clause, as a scan rather than a review note.
 *
 * `client.messages.stream()` is a brief requirement, not a style choice (D13),
 * and the way it gets undone is not a decision — it is one call site written the
 * obvious way. `no-firestore.spec.ts`'s technique, applied to the LLM: a scanner
 * tested on synthetic source first, then run over the tree.
 *
 * **Comments are stripped before scanning**, and that is not a convenience. Prose
 * in this repository names both call shapes constantly — the module header a few
 * lines up names them in the same sentence — so a scan over raw text reports the
 * documentation and misses nothing else. The ban is on the *call*.
 */
const NON_STREAMING = /\.\s*messages\s*\.\s*create\s*[(<]/
const STREAMING = /\.\s*messages\s*\.\s*stream\s*[(<]/

/** Skipped so the scan does not trip on its own source. */
const SELF = 'params.spec.ts'

/** Vitest's cwd for this package is `functions/`, as `npm run test` gives it. */
const SRC = join(process.cwd(), 'src')

/**
 * Line and block comments removed.
 *
 * The `[^:]` guard is what stops `https://…` inside a string being read as the
 * start of a comment — imperfect in general, exact for the shapes this codebase
 * contains, and the cases below are that sentence as tests.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (entry.name === SELF) return []
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

const matching = (pattern: RegExp): string[] =>
  sourceFiles(SRC).filter((path) => pattern.test(stripComments(readFileSync(path, 'utf8'))))

describe('the scan itself', () => {
  /*
   * Tested before it is trusted. A scanner that catches less than the rule it
   * enforces is worse than no scanner, because `toEqual([])` reads as proof
   * either way.
   */
  it.each([
    ['a direct call', 'const m = await client.messages.create({ model })'],
    ['whitespace around the members', 'client . messages . create ({})'],
    ['a generic call', 'client.messages.create<Parsed>({})'],
    ['a call on something else named client', 'anthropic.messages.create({})'],
  ])('catches %s', (_label, source) => {
    expect(NON_STREAMING.test(stripComments(source))).toBe(true)
  })

  it.each([
    ['a line comment about it', '// never use client.messages.create() here'],
    ['a block comment about it', '/** `messages.create` is a brief violation. */'],
    ['the streaming call', 'client.messages.stream(params)'],
    ['a bare mention with no call', 'the messages.create shape is banned'],
  ])('does not fire on %s', (_label, source) => {
    expect(NON_STREAMING.test(stripComments(source))).toBe(false)
  })

  it('leaves a URL inside a string alone', () => {
    expect(stripComments("const u = 'https://api.anthropic.com/v1'")).toContain('api.anthropic.com')
  })
})

describe('the LLM call shape, scanned over functions/src', () => {
  /*
   * The requirement, and self-enforcing at this size: 64,000 output tokens
   * cannot be delivered inside the SDK's non-streaming HTTP timeout, so the two
   * halves of D13 hold each other up.
   */
  it('calls messages.stream somewhere', () => {
    expect(matching(STREAMING).length).toBeGreaterThan(0)
  })

  it('calls messages.create nowhere', () => {
    // Reported by path, so a failure names the file rather than merely asserting
    // that one exists somewhere.
    expect(matching(NON_STREAMING)).toEqual([])
  })
})
