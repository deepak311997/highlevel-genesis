import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages'
import { describe, expect, it } from 'vitest'

import { buildParams, EFFORT, MAX_TOKENS, MODEL } from './params'
import type { ProjectFile } from './projectState'
import { SYSTEM_PROMPT } from './prompt'

/**
 * The request parameters — AC-6, and three decisions that are easy to undo by accident.
 *
 * The model id and `max_tokens` are `CLAUDE.md`'s non-negotiables, pinned to exact values rather
 * than "starts with claude" so a downgrade is a failing test and not a quieter bill.
 */

const CONTEXT: MessageParam[] = [{ role: 'user', content: 'build a contact dashboard' }]

const FILES: readonly ProjectFile[] = [
  { path: 'index.html', content: '<!doctype html>\n<h1>Contacts</h1>\n' },
  { path: 'app.js', content: 'console.log("contacts")\n' },
]

/**
 * `system` as blocks.
 *
 * The SDK types it `string | TextBlockParam[] | undefined`, and every decision in this slice is
 * about the array form — a string would carry no `cache_control` at all and so no breakpoint.
 */
function systemBlocks(params: MessageStreamParams): TextBlockParam[] {
  const { system } = params
  if (system === undefined || typeof system === 'string') {
    throw new Error('expected system to be an array of blocks')
  }
  return system
}

/** `cache_control` is optional *and* nullable in the SDK's types. */
const hasBreakpoint = (block: TextBlockParam): boolean =>
  block.cache_control !== undefined && block.cache_control !== null

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

  /* AC-22, D17 — the re-tune Slice 5 D15 named, arriving as planned rather than as churn. */
  it('asks for effort high', () => {
    expect(EFFORT).toBe('high')
    expect(buildParams([]).output_config?.effort).toBe('high')
  })

  /*
   * AC-13, and the cache guarantee in one line. A project with no files gets the *same array*,
   * not a copy and not a copy with something appended — asserted by identity, because a
   * structurally equal copy would pass a `toEqual` and still be a different object to reason
   * about.
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

  /* The project's files change what one parameter *contains*, not which
   * parameters exist. */
  it('sends the same five parameters when the project holds files', () => {
    expect(Object.keys(buildParams([], FILES)).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
    ])
  })
})

/**
 * AC-12 and AC-14's wiring — D11, which is one sentence: **the copy is made only when there is
 * something volatile to append, and it is appended after the breakpoint.**
 *
 * Both halves matter and they fail differently. Appending above the breakpoint invalidates the
 * cached prefix on every request whose project changed, which is every request — no error, no
 * frame, just the bill. Copying unconditionally is harmless to the cache and merely makes AC-13
 * unassertable, which is how it would survive review.
 */
describe('the project’s files in the system array', () => {
  it('appends exactly one block, and it is last', () => {
    const blocks = systemBlocks(buildParams([], FILES))
    expect(blocks).toHaveLength(SYSTEM_PROMPT.length + 1)
    expect(blocks.slice(0, SYSTEM_PROMPT.length)).toEqual([...SYSTEM_PROMPT])
    expect(blocks.at(-1)?.text).toContain('app.js')
  })

  /*
   * The whole of AC-12, stated as a position rather than an index: the
   * breakpoint is the last element of the *stable* prefix, so with a volatile
   * block appended it is the second to last element of the array that goes out.
   */
  it('leaves the breakpoint on the block immediately before it', () => {
    const blocks = systemBlocks(buildParams([], FILES))
    expect(blocks.findIndex(hasBreakpoint)).toBe(blocks.length - 2)
    expect(blocks.at(-2)).toBe(SYSTEM_PROMPT.at(-1))
  })

  it('carries exactly one breakpoint in the whole array, files or no files', () => {
    expect(systemBlocks(buildParams([], FILES)).filter(hasBreakpoint)).toHaveLength(1)
    expect(systemBlocks(buildParams([])).filter(hasBreakpoint)).toHaveLength(1)
  })

  /* Nothing volatile to append, so nothing is copied — the same assertion as
   * AC-13's, made from the other side. */
  it('appends nothing at all for a project holding no files', () => {
    expect(systemBlocks(buildParams([], []))).toHaveLength(SYSTEM_PROMPT.length)
    expect(buildParams([], []).system).toBe(SYSTEM_PROMPT)
  })

  /* The appended block is volatile content sitting after the breakpoint; a
   * second `cache_control` on it would write a cache entry per project state
   * and read one back never. */
  it('appends a block carrying no cache_control of its own', () => {
    const appended = systemBlocks(buildParams([], FILES)).at(-1)
    expect(appended === undefined ? true : hasBreakpoint(appended)).toBe(false)
  })
})

/**
 * AC-6's second clause, as a scan rather than a review note.
 *
 * `client.messages.stream()` is a brief requirement, not a style choice, and the way it gets
 * undone is not a decision — it is one call site written the obvious way. `no-
 * firestore.spec.ts`'s technique, applied to the LLM: a scanner tested on synthetic source
 * first, then run over the tree.
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
   * Tested before it is trusted. A scanner that catches less than the rule it enforces is worse
   * than no scanner, because `toEqual([])` reads as proof either way.
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
   * The requirement, and self-enforcing at this size: 64,000 output tokens cannot be delivered
   * inside the SDK's non-streaming HTTP timeout, so the two halves of D13 hold each other up.
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
