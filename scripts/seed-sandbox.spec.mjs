import { describe, expect, it } from 'vitest'

import {
  APPOINTMENT_COUNT,
  CONTACT_COUNT,
  SeedConfigError,
  isoWithOffset,
  parseArgs,
  plannedContacts,
  readConfig,
  seed,
} from './seed-sandbox.mjs'

/**
 * AC-11 … AC-16 — the sandbox seeder.
 *
 * Everything the script touches is injected: `fetchImpl`, `now` and `out`. No
 * test here opens a socket, reads a clock, or spends a write against the real
 * sandbox — the live run is a human-owned line in
 * `docs/slices/13-deliverables/release-checklist.md`, deliberately.
 */

const ENV = {
  HL_SEED_TOKEN: 'pit-0123456789abcdef',
  HL_SEED_LOCATION_ID: 'lUanVn0CtZJTlymH8ySo',
}

/** A Tuesday, so the plan's first four business days are Wed, Thu, Fri, Mon. */
const NOW = new Date('2026-08-18T09:00:00.000Z')
const now = () => NOW

/** Collects what the run printed, so the plan can be asserted on. */
function collector() {
  const lines = []
  const errors = []
  return {
    out: {
      log: (line) => lines.push(String(line)),
      error: (line) => errors.push(String(line)),
    },
    lines,
    errors,
  }
}

/**
 * A stubbed HighLevel. `respond(url, index, request)` returns a real `Response`,
 * so the script is exercised against the same shape `fetch` really hands back.
 */
function stubFetch(respond) {
  const calls = []
  const fetchImpl = (url, init = {}) => {
    const request = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    }
    calls.push(request)
    return Promise.resolve(respond(request.url, calls.length - 1, request))
  }
  return { fetchImpl, calls }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Fails loudly rather than silently answering a request no test expected. */
const noFetch = () => {
  throw new Error('the run issued a request it should not have')
}

describe('readConfig — AC-14', () => {
  it('throws SeedConfigError naming HL_SEED_TOKEN when it is unset', () => {
    expect(() => readConfig({ HL_SEED_LOCATION_ID: 'loc' })).toThrow(SeedConfigError)
    expect(() => readConfig({ HL_SEED_LOCATION_ID: 'loc' })).toThrow(/HL_SEED_TOKEN/)
  })

  it('throws SeedConfigError naming HL_SEED_LOCATION_ID when it is unset', () => {
    expect(() => readConfig({ HL_SEED_TOKEN: 'tok' })).toThrow(SeedConfigError)
    expect(() => readConfig({ HL_SEED_TOKEN: 'tok' })).toThrow(/HL_SEED_LOCATION_ID/)
  })

  it('names the root .env.example, so the operator knows where the variable belongs', () => {
    expect(() => readConfig({})).toThrow(/\.env\.example/)
  })

  it('defaults the API base and trims a trailing slash', () => {
    expect(readConfig(ENV).apiBase).toBe('https://services.leadconnectorhq.com')
    expect(readConfig({ ...ENV, HL_API_BASE: 'https://example.test/' }).apiBase).toBe(
      'https://example.test',
    )
  })
})

describe('seed — the config guard runs before any request (AC-14)', () => {
  it('rejects with SeedConfigError naming HL_SEED_TOKEN and issues zero requests', async () => {
    const { fetchImpl, calls } = stubFetch(noFetch)

    await expect(
      seed({
        env: { HL_SEED_LOCATION_ID: 'loc' },
        argv: [],
        fetchImpl,
        now,
        out: collector().out,
      }),
    ).rejects.toThrow(/HL_SEED_TOKEN/)

    expect(calls).toHaveLength(0)
  })

  it('rejects with SeedConfigError naming HL_SEED_LOCATION_ID and issues zero requests', async () => {
    const { fetchImpl, calls } = stubFetch(noFetch)

    const rejection = seed({
      env: { HL_SEED_TOKEN: 'tok' },
      argv: ['--dry-run'],
      fetchImpl,
      now,
      out: collector().out,
    })

    await expect(rejection).rejects.toBeInstanceOf(SeedConfigError)
    await expect(rejection).rejects.toThrow(/HL_SEED_LOCATION_ID/)
    expect(calls).toHaveLength(0)
  })
})

describe('parseArgs', () => {
  it('reads `--flag value` and `--flag=value` alike', () => {
    expect(parseArgs(['--dry-run', '--calendar-id', 'cal1', '--assigned-user-id', 'usr1'])).toEqual(
      {
        dryRun: true,
        calendarId: 'cal1',
        assignedUserId: 'usr1',
      },
    )

    expect(parseArgs(['--calendar-id=cal1', '--assigned-user-id=usr1'])).toEqual({
      dryRun: false,
      calendarId: 'cal1',
      assignedUserId: 'usr1',
    })
  })

  it('defaults every flag, so a bare run is a real run against a resolved calendar', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, calendarId: null, assignedUserId: null })
  })

  it('throws SeedConfigError on an unknown flag rather than ignoring a typo', () => {
    expect(() => parseArgs(['--dry-runn'])).toThrow(SeedConfigError)
  })

  it('throws SeedConfigError when a flag that takes a value has none', () => {
    expect(() => parseArgs(['--calendar-id'])).toThrow(SeedConfigError)
  })
})

describe('plannedContacts', () => {
  it('plans 20 contacts, every email unique', () => {
    const contacts = plannedContacts('loc1')

    expect(contacts).toHaveLength(CONTACT_COUNT)
    expect(CONTACT_COUNT).toBe(20)
    expect(new Set(contacts.map((c) => c.email)).size).toBe(CONTACT_COUNT)
    expect(new Set(contacts.map((c) => c.phone)).size).toBe(CONTACT_COUNT)
  })

  it('is pure — two calls are deeply equal, so a re-run plans the same rows', () => {
    expect(plannedContacts('loc1')).toEqual(plannedContacts('loc1'))
  })

  it('carries the location id and the seed tag on every contact', () => {
    for (const contact of plannedContacts('loc1')) {
      expect(contact.locationId).toBe('loc1')
      expect(contact.tags).toEqual(['genesis-seed'])
      expect(contact.firstName).not.toBe('')
      expect(contact.lastName).not.toBe('')
    }
  })
})

describe('isoWithOffset — D11', () => {
  it('renders an explicit numeric offset, never a bare Z', () => {
    const rendered = isoWithOffset(new Date('2026-08-19T10:00:00.000Z'), 0)

    expect(rendered).toBe('2026-08-19T10:00:00+00:00')
    expect(rendered).not.toMatch(/Z$/)
  })

  it('shifts the wall clock to the offset it renders', () => {
    const instant = new Date('2026-08-19T10:00:00.000Z')

    expect(isoWithOffset(instant, 330)).toBe('2026-08-19T15:30:00+05:30')
    expect(isoWithOffset(instant, -240)).toBe('2026-08-19T06:00:00-04:00')
  })

  it('round-trips: what it renders parses back to the same instant', () => {
    const instant = new Date('2026-08-19T10:00:00.000Z')

    expect(new Date(isoWithOffset(instant, 330)).getTime()).toBe(instant.getTime())
  })
})

describe('seed --dry-run — AC-11', () => {
  it('prints 20 contact lines and 8 appointment lines and issues zero requests', async () => {
    const { fetchImpl, calls } = stubFetch(noFetch)
    const { out, lines } = collector()

    const summary = await seed({ env: ENV, argv: ['--dry-run'], fetchImpl, now, out })

    expect(calls).toHaveLength(0)
    expect(summary.dryRun).toBe(true)
    expect(summary.requests).toBe(0)
    expect(lines.filter((l) => /^ {2}contact \d+ — /.test(l))).toHaveLength(CONTACT_COUNT)
    expect(lines.filter((l) => /^ {2}appointment \d+ — /.test(l))).toHaveLength(APPOINTMENT_COUNT)
    expect(APPOINTMENT_COUNT).toBe(8)
  })

  it('needs no calendar — it prints <resolved at run time> for an omitted id', async () => {
    const { fetchImpl, calls } = stubFetch(noFetch)
    const { out, lines } = collector()

    await seed({ env: ENV, argv: ['--dry-run'], fetchImpl, now, out })

    expect(calls).toHaveLength(0)
    expect(lines.join('\n')).toMatch(/<resolved at run time>/)
  })

  it('prints the resolved ids when both flags are given', async () => {
    const { fetchImpl } = stubFetch(noFetch)
    const { out, lines } = collector()

    await seed({
      env: ENV,
      argv: ['--dry-run', '--calendar-id=cal1', '--assigned-user-id=usr1'],
      fetchImpl,
      now,
      out,
    })

    const printed = lines.join('\n')
    expect(printed).toMatch(/cal1/)
    expect(printed).toMatch(/usr1/)
    expect(printed).not.toMatch(/<resolved at run time>/)
  })

  it('plans every appointment inside the next 14 days', async () => {
    const { fetchImpl } = stubFetch(noFetch)
    const { out, lines } = collector()

    await seed({ env: ENV, argv: ['--dry-run'], fetchImpl, now, out })

    const times = lines
      .filter((l) => /^ {2}appointment \d+ — /.test(l))
      .flatMap((l) => l.match(/\d{4}-\d{2}-\d{2}T[\d:]+\+00:00/g) ?? [])

    expect(times).toHaveLength(APPOINTMENT_COUNT * 2)
    for (const time of times) {
      const at = new Date(time).getTime()
      expect(Number.isNaN(at)).toBe(false)
      expect(at).toBeGreaterThan(NOW.getTime())
      expect(at).toBeLessThanOrEqual(NOW.getTime() + 14 * 24 * 60 * 60 * 1000)
    }
  })
})
