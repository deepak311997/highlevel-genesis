import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  APPOINTMENT_COUNT,
  CONTACTS_VERSION,
  CALENDARS_VERSION,
  CONTACT_COUNT,
  DEFAULT_API_BASE,
  SeedConfigError,
  exitCodeFor,
  isoWithOffset,
  parseArgs,
  plannedContacts,
  readConfig,
  seed,
} from './seed-sandbox.mjs'

const ROOT = join(import.meta.dirname, '..')

/** The recorded HighLevel responses. Read as JSON, asserted against as data. */
const fixture = (name) =>
  JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/highlevel', `${name}.json`), 'utf8'))

const CONTACT_CREATED = fixture('contact-create')
const APPOINTMENT_CREATED = fixture('appointment-create')

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

/**
 * A run against a stub that answers every create with success.
 *
 * Both ids are passed, so no resolution request is issued and the call log is
 * exactly the 28 creates AC-12 counts.
 */
async function successfulRun() {
  const { fetchImpl, calls } = stubFetch((url) =>
    url.endsWith('/contacts/') ? json(201, CONTACT_CREATED) : json(200, APPOINTMENT_CREATED),
  )
  const { out, errors } = collector()

  const summary = await seed({
    env: ENV,
    argv: ['--calendar-id=cal1', '--assigned-user-id=usr1'],
    fetchImpl,
    now,
    out,
  })

  return { summary, calls, errors }
}

const contactCalls = (calls) => calls.filter((c) => c.url.endsWith('/contacts/'))
const appointmentCalls = (calls) =>
  calls.filter((c) => c.url.endsWith('/calendars/events/appointments'))

describe('seed — creating contacts and appointments (AC-12)', () => {
  it('issues exactly 28 requests: 20 contact creates and 8 appointment creates', async () => {
    const { summary, calls } = await successfulRun()

    expect(calls).toHaveLength(CONTACT_COUNT + APPOINTMENT_COUNT)
    expect(summary.requests).toBe(28)

    expect(contactCalls(calls)).toHaveLength(CONTACT_COUNT)
    expect(appointmentCalls(calls)).toHaveLength(APPOINTMENT_COUNT)

    for (const call of contactCalls(calls)) {
      expect(call.method).toBe('POST')
      expect(call.url).toBe(`${DEFAULT_API_BASE}/contacts/`)
    }
    for (const call of appointmentCalls(calls)) {
      expect(call.method).toBe('POST')
      expect(call.url).toBe(`${DEFAULT_API_BASE}/calendars/events/appointments`)
    }
  })

  it('creates the contacts before the appointments they belong to', async () => {
    const { calls } = await successfulRun()
    const kinds = calls.map((c) => (c.url.endsWith('/contacts/') ? 'contact' : 'appointment'))

    expect(kinds.indexOf('appointment')).toBe(CONTACT_COUNT)
  })

  it('carries the bearer token, Accept and the row Version on every request', async () => {
    const { calls } = await successfulRun()

    for (const call of calls) {
      expect(call.headers.Authorization).toBe(`Bearer ${ENV.HL_SEED_TOKEN}`)
      expect(call.headers.Accept).toBe('application/json')
    }
    for (const call of contactCalls(calls)) {
      expect(call.headers.Version).toBe(CONTACTS_VERSION)
      expect(CONTACTS_VERSION).toBe('2021-07-28')
    }
    for (const call of appointmentCalls(calls)) {
      expect(call.headers.Version).toBe(CALENDARS_VERSION)
      expect(CALENDARS_VERSION).toBe('2021-04-15')
    }
  })

  it('carries the seed location id in every body', async () => {
    const { calls } = await successfulRun()

    for (const call of calls) {
      expect(call.body.locationId).toBe(ENV.HL_SEED_LOCATION_ID)
    }
  })

  it('posts the planned contacts, unchanged and in order', async () => {
    const { calls } = await successfulRun()

    expect(contactCalls(calls).map((c) => c.body)).toEqual(plannedContacts(ENV.HL_SEED_LOCATION_ID))
  })

  it('posts each appointment against the given calendar, assignee and a created contact', async () => {
    const { calls } = await successfulRun()

    for (const call of appointmentCalls(calls)) {
      expect(call.body.calendarId).toBe('cal1')
      expect(call.body.assignedUserId).toBe('usr1')
      expect(call.body.contactId).toBe(CONTACT_CREATED.contact.id)
      expect(call.body.title).toMatch(/\S/)
    }
  })

  it('schedules every appointment inside the next 14 days, ISO 8601 with an offset', async () => {
    const { calls } = await successfulRun()

    for (const call of appointmentCalls(calls)) {
      for (const value of [call.body.startTime, call.body.endTime]) {
        expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
        const at = new Date(value).getTime()
        expect(Number.isNaN(at)).toBe(false)
        expect(at).toBeGreaterThan(NOW.getTime())
        expect(at).toBeLessThanOrEqual(NOW.getTime() + 14 * 24 * 60 * 60 * 1000)
      }
      expect(new Date(call.body.endTime).getTime()).toBeGreaterThan(
        new Date(call.body.startTime).getTime(),
      )
    }
  })

  it('counts what it created and exits 0', async () => {
    const { summary, errors } = await successfulRun()

    expect(summary).toMatchObject({
      dryRun: false,
      contacts: { created: CONTACT_COUNT, existing: 0, failed: 0 },
      appointments: { created: APPOINTMENT_COUNT, failed: 0 },
      failures: [],
    })
    expect(exitCodeFor(summary)).toBe(0)
    expect(errors).toEqual([])
  })
})
