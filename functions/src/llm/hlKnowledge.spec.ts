import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROXY_ERROR_CODES } from '../hl/proxyError'
import { HL_ROUTES, isRouteEnabled, matchRoute } from '../hl/routes'
import { HL_KNOWLEDGE, RESPONSE_EXAMPLES } from './hlKnowledge'

/**
 * The HighLevel cheat-sheet — what the model is told, checked against the tables
 * it was rendered from (D2, AC-1 to AC-9).
 *
 * The point of every case below is that the cheat-sheet is **derived data**, not
 * prose someone typed once. A hand-written endpoint list drifts on the first
 * allowlist change and the drift is invisible: the model goes on confidently
 * generating a route the proxy answers `403` on, and nothing fails until a user
 * runs the app. So the allowlist is checked in both directions (AC-1 names every
 * enabled row, AC-2 refuses any path the proxy would), the error codes are read
 * from `proxyError.ts` rather than restated, and the response examples are
 * checked field by field against the payloads actually recorded from the sandbox.
 *
 * What no test here can assert is whether the model *complies* — see PRD D20 and
 * R1. These cases pin what it is told, which is the half that is knowable.
 */

const FIXTURES = join(__dirname, '../../../tests/fixtures/highlevel')

/**
 * A legal HighLevel id, substituted for each `:param` before matching.
 *
 * `matchRoute` validates parameters against its own grammar, so a scan that fed
 * it the literal `:contactId` would be testing the grammar rather than the
 * route table — `:` is not in `[A-Za-z0-9_-]` and every parameterised row would
 * come back `invalid_path`.
 */
const SAMPLE_ID = 'aBcD1234efGH5678ijKL'

/** The route table's own lines: `- GET /calendars/events — …`. */
const TABLE_REFERENCE = /\b(GET|POST|PUT)\s+(\/\S+)/g

/** The worked examples in the prose: `hl('POST', '/contacts/search', …)`. */
const CALL_REFERENCE = /hl\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g

interface Reference {
  method: string
  path: string
}

function referencesIn(source: string, pattern: RegExp): Reference[] {
  const found: Reference[] = []
  for (const [, method, path] of source.matchAll(pattern)) {
    if (method === undefined || path === undefined) continue
    found.push({ method, path })
  }
  return found
}

function withSampleIds(path: string): string {
  return path.replace(/:[A-Za-z]+/g, SAMPLE_ID)
}

describe('AC-1 — every enabled row appears, exactly as the proxy spells it', () => {
  /*
   * `method` and `pattern` verbatim, not a paraphrase: the proxy matches on the
   * pattern, so anything else in the prompt is a second spelling of a route and
   * the model has no way to know which one is real.
   */
  it.each(
    HL_ROUTES.filter((row) => row.flag === undefined).map((row) => [row.method, row.pattern]),
  )('names %s %s', (method, pattern) => {
    expect(HL_KNOWLEDGE).toContain(`${method} ${pattern}`)
  })
})

describe('AC-2 — every route it names is one the proxy would allow', () => {
  const scanned = [
    ...referencesIn(HL_KNOWLEDGE, TABLE_REFERENCE),
    ...referencesIn(HL_KNOWLEDGE, CALL_REFERENCE),
  ]

  /*
   * A scan that finds nothing passes vacuously, which is the one way this case
   * could be green while the cheat-sheet named something absurd. The floor is
   * deliberately loose — it asserts the scanners work, not how many routes we
   * chose to document.
   */
  it('finds route references in both the table and the worked examples', () => {
    expect(referencesIn(HL_KNOWLEDGE, TABLE_REFERENCE).length).toBeGreaterThanOrEqual(5)
    expect(referencesIn(HL_KNOWLEDGE, CALL_REFERENCE).length).toBeGreaterThanOrEqual(2)
  })

  it('resolves every reference it names to an enabled row', () => {
    for (const { method, path } of scanned) {
      const match = matchRoute(method, withSampleIds(path))

      expect({ method, path, kind: match.kind }).toEqual({ method, path, kind: 'matched' })
      if (match.kind !== 'matched') continue
      expect(isRouteEnabled(match.row, {})).toBe(true)
    }
  })

  /*
   * The negatives that make the scan meaningful. Neither verb is on the
   * allowlist, and `DELETE /contacts/{id}` in a loop is the exact confused-deputy
   * output `HIGHLEVEL_PLATFORM.md` §8 names — a cheat-sheet that mentioned it,
   * even to forbid it, would be teaching the string.
   */
  it.each(['DELETE', 'PATCH'])('never mentions %s', (verb) => {
    expect(HL_KNOWLEDGE).not.toContain(verb)
  })
})

describe('AC-3 — the flagged row follows the environment', () => {
  /*
   * The cheat-sheet is rendered once, at module load (D3), so the environment
   * cannot be varied by setting it and re-reading the constant. Resetting the
   * module registry and importing again is what actually re-runs the render.
   */
  async function renderedWith(value: string | undefined): Promise<string> {
    vi.resetModules()
    vi.stubEnv('HL_ALLOW_MESSAGE_SEND', value)
    // The extension is TypeScript's, not a mistake: a dynamic `import()` is an
    // ECMAScript import even in a CommonJS file, and `node16` resolution asks for
    // the emitted name. Vite maps it back to the `.ts` source.
    const reloaded = await import('./hlKnowledge.js')
    return reloaded.HL_KNOWLEDGE
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('omits the message-send route when the flag is unset', async () => {
    expect(await renderedWith(undefined)).not.toContain('POST /conversations/messages')
  })

  it('names the message-send route when the flag is true', async () => {
    expect(await renderedWith('true')).toContain('POST /conversations/messages')
  })
})

describe('AC-5 — locationId is never sent', () => {
  /*
   * Named as a key rather than described, because the model has to recognise the
   * field it is about to type. The proxy strips it from every row and re-adds it
   * from the connection (Slice 8 P1), so a `locationId` in generated code is not
   * a security hole — it is code whose most visible parameter silently does
   * nothing, which a reader would take as evidence the app is multi-location.
   */
  it('names the key and forbids sending it', () => {
    expect(HL_KNOWLEDGE).toContain('locationId')
    expect(HL_KNOWLEDGE).toMatch(/never send `locationId`/i)
  })
})

describe('AC-6 — the calendar time format, and the trap', () => {
  it('names both parameters and the unit', () => {
    expect(HL_KNOWLEDGE).toContain('startTime')
    expect(HL_KNOWLEDGE).toContain('endTime')
    expect(HL_KNOWLEDGE).toMatch(/epoch milliseconds/i)
  })

  /*
   * The highest-value line in the cheat-sheet (D7). ISO 8601 on
   * `/calendars/events` does not error — it answers HTTP 200 with an empty list,
   * which is indistinguishable from a calendar with nothing in it. In the demo
   * that is an app that silently shows nothing.
   */
  it('warns that ISO 8601 returns an empty success rather than an error', () => {
    expect(HL_KNOWLEDGE).toMatch(/ISO 8601/)
    expect(HL_KNOWLEDGE).toMatch(/empty success/i)
    expect(HL_KNOWLEDGE).toContain('{"events":[]}')
  })
})

describe('AC-7 — the error contract, read from proxyError.ts', () => {
  it.each([...PROXY_ERROR_CODES])('names the %s code', (code) => {
    expect(HL_KNOWLEDGE).toContain(code)
  })

  it('has twelve codes to name', () => {
    expect(PROXY_ERROR_CODES).toHaveLength(12)
  })

  it.each(['try', 'catch', 'message'])('tells the model to %s', (needle) => {
    expect(HL_KNOWLEDGE).toContain(needle)
  })

  /* F8.3, and the one failure the brief names outright. */
  it('says to tell the user to reconnect when the connection expired', () => {
    expect(HL_KNOWLEDGE).toMatch(/hl_reconnect_required[\s\S]{0,400}?[Rr]econnect HighLevel/)
  })
})

describe('AC-8 — no request per row', () => {
  /*
   * The burst ceiling is named so the rule reads as arithmetic rather than
   * taste: a fifty-row list that fetches each row separately spends half the
   * allowance on one screen (`HIGHLEVEL_PLATFORM.md` §5, D9).
   */
  it('forbids the N+1 shape and names the burst ceiling', () => {
    expect(HL_KNOWLEDGE).toContain('100')
    expect(HL_KNOWLEDGE).toContain('10 seconds')
    expect(HL_KNOWLEDGE).toMatch(/never (make )?one request per row/i)
  })
})

describe('AC-9 — every example field exists in the recorded payload', () => {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /**
   * Every key reachable in a value: an object contributes its keys and then its
   * values are walked, an array's elements are walked. Recursive because the
   * shapes are nested and a hand-trimmed example's *nested* invention is exactly
   * the one a reader would miss.
   */
  function fieldNames(value: unknown, into = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
      for (const item of value) fieldNames(item, into)
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        into.add(key)
        fieldNames(child, into)
      }
    }
    return into
  }

  it('has an example for the two surfaces the demo needs', () => {
    const surfaces = RESPONSE_EXAMPLES.map((entry) => entry.surface)

    expect(surfaces).toContain('/contacts/search')
    expect(surfaces).toContain('/calendars/events')
  })

  /*
   * D10's guard against fiction. A trimmed example is hand-authored, so nothing
   * but this stops a plausible-looking field that HighLevel has never sent — and
   * a generated dashboard reading `contact.fullName` renders blanks over real
   * data, which looks like our bug and is unanswerable without the fixture.
   */
  it.each(RESPONSE_EXAMPLES.map((entry) => [entry.surface, entry] as const))(
    'uses only fields %s actually returns',
    (_surface, entry) => {
      const recorded = JSON.parse(readFileSync(join(FIXTURES, entry.fixture), 'utf8')) as unknown
      const recordedNames = fieldNames(recorded)
      const used = [...fieldNames(entry.example)]

      expect(used.length).toBeGreaterThan(0)
      expect(used.filter((name) => !recordedNames.has(name))).toEqual([])
    },
  )

  it('renders each example into the cheat-sheet', () => {
    for (const entry of RESPONSE_EXAMPLES) {
      expect(HL_KNOWLEDGE).toContain(JSON.stringify(entry.example, null, 2))
    }
  })
})

describe('the cheat-sheet teaches one function and no URL', () => {
  /*
   * AC-4 is asserted over the whole prompt in `prompt.spec.ts`; it is repeated
   * here on the one block that could plausibly carry a URL, so a mistake is
   * reported against the file that made it. `HIGHLEVEL_PLATFORM.md` §8: generated
   * code cannot reach a raw HighLevel URL — no CORS, no token — and it must not
   * be told the proxy path either, because an opaque-origin iframe cannot carry
   * an ID token to it (Slice 8 D16).
   */
  it.each(['services.leadconnectorhq.com', '/api/hl/proxy'])('says nothing about %s', (needle) => {
    expect(HL_KNOWLEDGE).not.toContain(needle)
  })

  it("teaches the hl(' calling convention", () => {
    expect(HL_KNOWLEDGE).toContain("hl('")
  })

  /*
   * The row `version` values are `2021-07-28` and `2021-04-15`, which read as
   * volatile to `prompt.spec.ts`'s scan — and the proxy attaches the header
   * itself, so the model has nothing to do with them.
   */
  it('leaves the API version headers to the proxy', () => {
    for (const row of HL_ROUTES) {
      expect(HL_KNOWLEDGE).not.toContain(row.version)
    }
  })
})
