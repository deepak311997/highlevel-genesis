import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { isRouteEnabled, matchRoute } from '../hl/routes'
import { countHlCalls, extractHlCalls } from './hlCalls'

/**
 * The `hl()` extractor — AC-23 and AC-25.
 *
 * Read the cases below as a description of a **metric, not a parser** (D19). The
 * extractor is a regular expression over generated code: it has no idea what a
 * comment is, what a string literal is, or what scope a call sits in. Several
 * cases here pin that on purpose, because the alternative reading — that these
 * two integers are ground truth about what the generated app does — is the one
 * that would make a future reader trust them further than they can carry.
 *
 * What the counters are actually for: they are the one signal outside a fixture
 * that says whether F3.2 landed at all. A generation whose `hlCallsKnown` is zero
 * every time means the cheat-sheet is not working, and nothing else in this
 * repository can tell us that (D19; the rejected alternative was keeping the
 * extractor test-only).
 */

/** The recorded reply the emulator fake replays, and five suites depend on (Slice 6 R8). */
const REPLY = join(__dirname, '../../../tests/fixtures/llm/reply.json')

/**
 * The text the recorded stream speaks, joined.
 *
 * Parsed rather than indexed: a fixture is a boundary like any other, and a
 * `text_delta` that changed shape should fail here as a parse rather than
 * silently contribute an `undefined` to the corpus.
 */
const textDeltaSchema = z.object({
  type: z.literal('content_block_delta'),
  delta: z.object({ type: z.literal('text_delta'), text: z.string() }),
})

function recordedText(): string {
  const events: unknown = JSON.parse(readFileSync(REPLY, 'utf8'))

  return z
    .array(z.unknown())
    .parse(events)
    .flatMap((event) => {
      const parsed = textDeltaSchema.safeParse(event)
      return parsed.success ? [parsed.data.delta.text] : []
    })
    .join('')
}

describe('extractHlCalls', () => {
  it('returns the method and path of every literal call, in source order', () => {
    const code = [
      "const page = await hl('POST', '/contacts/search', { pageLimit: 20 })",
      "const events = await hl('GET', '/calendars/events', { startTime, endTime, calendarId })",
    ].join('\n')

    expect(extractHlCalls(code)).toEqual([
      { method: 'POST', path: '/contacts/search' },
      { method: 'GET', path: '/calendars/events' },
    ])
  })

  it('returns nothing for text holding no call at all', () => {
    expect(extractHlCalls('const rows = document.getElementById("rows")\nrender(rows)')).toEqual([])
  })

  it('finds a call written with double quotes and odd whitespace', () => {
    const code = 'await hl (\n  "GET" ,\n  "/calendars/"\n)'

    expect(extractHlCalls(code)).toEqual([{ method: 'GET', path: '/calendars/' }])
  })

  /*
   * The near misses. Each one is a shape the regex must *not* claim, because a
   * counter that over-reports is worse than one that under-reports: it says F3.2
   * landed on a generation where it did not.
   */
  it.each([
    ['a longer identifier ending in hl', "myhl('GET', '/contacts/search')"],
    ['a template-literal path', "hl('GET', `/contacts/${id}`)"],
    ['a variable path', 'hl(method, path)'],
    ['a variable method', "hl(method, '/contacts/search')"],
  ])('claims nothing for %s', (_label, code) => {
    expect(extractHlCalls(code)).toEqual([])
  })

  /*
   * **A commented-out call is still counted, and that is not a bug.** Excluding
   * it would mean tracking comment and string context — i.e. parsing JavaScript —
   * to refine a number whose whole job is to be a rough signal. The limitation is
   * asserted rather than merely documented so that nobody "fixes" it without
   * first deciding the metric should become a parser (D19).
   */
  it('counts a commented-out call, because it is a metric and not a parser', () => {
    expect(extractHlCalls("// const page = await hl('POST', '/contacts/search')")).toEqual([
      { method: 'POST', path: '/contacts/search' },
    ])
  })

  /*
   * `DELETE` is not on the allowlist and never will be by accident (Slice 8 D4).
   * The method is captured as `[A-Z]+` rather than as an alternation of the three
   * allowed verbs precisely so this call is *extracted* and then counted unknown —
   * a verb the proxy refuses is exactly the signal the counters exist to carry,
   * and a regex that skipped it would report a clean generation.
   */
  it('extracts a DELETE call so it can be counted as unknown', () => {
    expect(extractHlCalls("await hl('DELETE', '/contacts/JwwI60NJqfc8I4Ay2MiA')")).toEqual([
      { method: 'DELETE', path: '/contacts/JwwI60NJqfc8I4Ay2MiA' },
    ])
  })
})

describe('countHlCalls', () => {
  it('counts an allowlisted call as known and an unmatched route as unknown', () => {
    const calls = extractHlCalls(
      [
        "await hl('POST', '/contacts/search', { pageLimit: 20 })",
        "await hl('DELETE', '/contacts/JwwI60NJqfc8I4Ay2MiA')",
        "await hl('GET', '/opportunities/search')",
      ].join('\n'),
    )

    expect(countHlCalls(calls, {})).toEqual({ known: 1, unknown: 2 })
  })

  /*
   * A flag-gated row is unknown in every environment that has not set the flag —
   * the same answer the proxy gives (`403 route_disabled`), which is the point:
   * the counter reports what would actually happen at runtime, not what the table
   * theoretically holds.
   */
  it('counts a flag-disabled row as unknown until the flag is set', () => {
    const calls = extractHlCalls("await hl('POST', '/conversations/messages', { message })")

    expect(countHlCalls(calls, {})).toEqual({ known: 0, unknown: 1 })
    expect(countHlCalls(calls, { HL_ALLOW_MESSAGE_SEND: 'true' })).toEqual({ known: 1, unknown: 0 })
  })

  it('counts nothing at all as nothing, rather than as an unknown call', () => {
    expect(countHlCalls([], {})).toEqual({ known: 0, unknown: 0 })
  })
})

/**
 * AC-25 — the golden reply is HighLevel-shaped.
 *
 * `reply.json` is what the emulator fake replays and what the e2e walk reads out
 * of the editor, so this case and AC-26 assert the same artefact at two levels.
 * It is **hand-authored** to the shape the system prompt specifies and is not
 * evidence about what the real model does — see `tests/fixtures/llm/README.md`
 * (D20).
 */
describe('the golden reply fixture', () => {
  it('calls only routes the proxy would allow', () => {
    const calls = extractHlCalls(recordedText())

    // Not vacuous: the fixture really does carry calls to check.
    expect(calls.length).toBeGreaterThan(0)

    for (const call of calls) {
      const match = matchRoute(call.method, call.path)
      expect(match.kind).toBe('matched')
      expect(match.kind === 'matched' && isRouteEnabled(match.row, {})).toBe(true)
    }
  })

  it('reports every one of its calls as known', () => {
    expect(countHlCalls(extractHlCalls(recordedText()), {})).toEqual({ known: 2, unknown: 0 })
  })
})
