#!/usr/bin/env node
/**
 * Seed a HighLevel sandbox location with demo data — 20 contacts, 8 appointments.
 *
 * The demo the assignment is graded on renders real CRM data, and an empty sandbox renders
 * nothing. This fills one, from the operator's own token:
 *
 *   HL_SEED_TOKEN=… HL_SEED_LOCATION_ID=… node scripts/seed-sandbox.mjs --dry-run
 *   HL_SEED_TOKEN=… HL_SEED_LOCATION_ID=… node scripts/seed-sandbox.mjs
 *
 * `--dry-run` first, always: it prints every row it would create and issues zero requests. A
 * re-run is not an error either — HighLevel refuses a duplicate contact with a 400 carrying the
 * existing id, which is read as success with that id carried forward.
 *
 * It is an operator chore, not a product path: not part of the deployed application, holding no
 * user's credential, and storing nothing anywhere but HighLevel. `seed-sandbox.spec.mjs` names
 * the surfaces it must never touch and proves it never does, by scanning this whole file.
 */
import { pathToFileURL } from 'node:url'

export const CONTACT_COUNT = 20
export const APPOINTMENT_COUNT = 8
export const CONTACTS_VERSION = '2021-07-28'
export const CALENDARS_VERSION = '2021-04-15'
export const DEFAULT_API_BASE = 'https://services.leadconnectorhq.com'
export const SEED_TAG = 'genesis-seed'

/** What a dry run prints where a real run would have an id it has not fetched. */
const UNRESOLVED = '<resolved at run time>'

const DAY_MS = 24 * 60 * 60 * 1000
/**
 * Two per business day, 30 minutes each, at 10:00 and 15:00 **UTC**.
 *
 * `plannedAppointments` takes an `offsetMinutes`, but `seed()` passes none, so
 * every run renders `+00:00`. For a sandbox in a distant timezone that is not
 * the local business hours the README describes — see the note in
 * `release-checklist.md`, and the `--utc-offset` flag named there as the fix.
 */
const APPOINTMENT_HOURS = [10, 15]
const APPOINTMENT_MINUTES = 30

/**
 * The twenty names, frozen.
 *
 * A table rather than a generator so the plan is the same on every run and on every machine: the
 * operator can diff two dry runs, and a contact that failed is at the same row number the next
 * time. `seed-sandbox.spec.mjs` leans on that — the third row is the one it fails on purpose.
 */
const SEED_NAMES = Object.freeze([
  ['Amara', 'Osei'],
  ['Ben', 'Carter'],
  ['Dana', 'Ruiz'],
  ['Elena', 'Fischer'],
  ['Farid', 'Haddad'],
  ['Grace', 'Lin'],
  ['Hugo', 'Moreau'],
  ['Ingrid', 'Larsen'],
  ['Jonas', 'Weber'],
  ['Kavya', 'Nair'],
  ['Liam', 'Brennan'],
  ['Mei', 'Tanaka'],
  ['Nadia', 'Petrova'],
  ['Omar', 'Farouk'],
  ['Priya', 'Sharma'],
  ['Quinn', 'Delaney'],
  ['Rosa', 'Alvarez'],
  ['Samuel', 'Adeyemi'],
  ['Tara', 'Whitfield'],
  ['Viktor', 'Novak'],
])

/** Configuration the operator did not supply. Never carries a token value. */
export class SeedConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SeedConfigError'
  }
}

const VALUE_FLAGS = new Map([
  ['--calendar-id', 'calendarId'],
  ['--assigned-user-id', 'assignedUserId'],
])

/**
 * Supports both `--flag value` and `--flag=value`.
 *
 * An unknown flag throws rather than being ignored: a mistyped `--calender-id` that is silently
 * dropped would send the run at whatever calendar `GET /calendars/` happens to list first, which
 * is the one outcome the operator was trying to avoid by passing the flag.
 */
export function parseArgs(argv) {
  const parsed = { dryRun: false, calendarId: null, assignedUserId: null }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)

    if (name === '--dry-run') {
      parsed.dryRun = true
      continue
    }

    const key = VALUE_FLAGS.get(name)
    if (key === undefined) {
      // `name`, never `arg`: an operator who guesses at a `--token=…` flag must
      // not have the token echoed to stderr, where it outlives the run.
      throw new SeedConfigError(
        `Unknown option ${name}. Usage: node scripts/seed-sandbox.mjs ` +
          '[--dry-run] [--calendar-id ID] [--assigned-user-id ID]',
      )
    }

    let value
    if (eq === -1) {
      value = argv[index + 1]
      index += 1
    } else {
      value = arg.slice(eq + 1)
    }

    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new SeedConfigError(`${name} needs a value, for example ${name} 2oKn7but6Q2WaHIu7pqC.`)
    }

    parsed[key] = value
  }

  return parsed
}

function required(env, name) {
  const value = env[name]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()

  throw new SeedConfigError(
    `${name} is not set. It is documented in the root .env.example under "Operator ` +
      'scripts"; export it in your shell before running this script. No request was issued.',
  )
}

/**
 * Throws `SeedConfigError` naming the missing variable, before any request.
 *
 * `HL_API_BASE` is read too, but is not required: it defaults to the public host and exists so a
 * run can be pointed at a stand-in without editing code. **Blank counts as unset**, as it does
 * for the two variables above — it is a documented, blank-by-default line in both `.env.example`
 * files, so an operator who sources one arrives here with `''`, and an empty base makes every
 * URL relative and every one of the 28 requests fail on a message that reads like HighLevel's
 * fault.
 */
export function readConfig(env) {
  const apiBase = (env.HL_API_BASE ?? '').trim()

  return {
    token: required(env, 'HL_SEED_TOKEN'),
    locationId: required(env, 'HL_SEED_LOCATION_ID'),
    apiBase: (apiBase === '' ? DEFAULT_API_BASE : apiBase).replace(/\/+$/, ''),
  }
}

export function headersFor(version, token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: version,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

/** 20 deterministic contacts. Pure — same input, same output, every run. */
export function plannedContacts(locationId) {
  return SEED_NAMES.map(([firstName, lastName], index) => ({
    locationId,
    firstName,
    lastName,
    email: `${firstName}.${lastName}@genesis-seed.example.com`.toLowerCase(),
    // A 555 number, which is reserved for fiction and reaches nobody.
    phone: `+1555010${String(index + 1).padStart(4, '0')}`,
    tags: [SEED_TAG],
  }))
}

/**
 * ISO 8601 with an explicit numeric offset — never a bare `Z` (D11).
 *
 * The epoch-millisecond finding in `docs/HIGHLEVEL_PLATFORM.md` §6.3 is about
 * the `GET /calendars/events` *query*, not about a create body: a create takes
 * ISO 8601, and a bare `Z` is the form we have never verified. Rendering the
 * offset explicitly means the string says what it means in either reading.
 */
export function isoWithOffset(date, offsetMinutes = 0) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000)
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const absolute = Math.abs(offsetMinutes)

  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  )
}

/**
 * 8 appointments: two per business day (10:00 and 15:00, 30 minutes each),
 * starting the day after `now`, weekends skipped, contacts taken in order.
 *
 * `now` is a `Date`; `contactIds` may be shorter than `APPOINTMENT_COUNT` — if
 * some contact creates failed, the ids that did come back are reused in order,
 * because eight appointments over a handful of contacts still demos.
 */
export function plannedAppointments({
  locationId,
  calendarId,
  assignedUserId,
  contactIds,
  now,
  offsetMinutes = 0,
}) {
  if (contactIds.length === 0) return []

  const appointments = []
  // UTC fields of the shifted instant are the wall-clock fields in `offsetMinutes`.
  const local = new Date(now.getTime() + offsetMinutes * 60_000)
  let midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())

  while (appointments.length < APPOINTMENT_COUNT) {
    midnight += DAY_MS
    const weekday = new Date(midnight).getUTCDay()
    if (weekday === 0 || weekday === 6) continue

    for (const hour of APPOINTMENT_HOURS) {
      if (appointments.length >= APPOINTMENT_COUNT) break

      const index = appointments.length
      const start = new Date(midnight + hour * 60 * 60_000 - offsetMinutes * 60_000)
      const end = new Date(start.getTime() + APPOINTMENT_MINUTES * 60_000)

      appointments.push({
        locationId,
        calendarId,
        contactId: contactIds[index % contactIds.length],
        assignedUserId,
        startTime: isoWithOffset(start, offsetMinutes),
        endTime: isoWithOffset(end, offsetMinutes),
        title: `Genesis seed appointment ${index + 1}`,
      })
    }
  }

  return appointments
}

/** The plan, printed. What `--dry-run` shows instead of issuing anything. */
function printPlan({ config, calendarId, assignedUserId, contacts, appointments, out }) {
  out.log('Genesis sandbox seed — plan')
  out.log(`  location:  ${config.locationId}`)
  out.log(`  API base:  ${config.apiBase}`)
  out.log(`  calendar:  ${calendarId}`)
  out.log(`  assignee:  ${assignedUserId}`)
  out.log('')

  out.log(`${contacts.length} contacts — POST ${config.apiBase}/contacts/`)
  contacts.forEach((contact, index) => {
    out.log(
      `  contact ${index + 1} — ${contact.firstName} ${contact.lastName} · ` +
        `${contact.email} · ${contact.phone}`,
    )
  })
  out.log('')

  out.log(
    `${appointments.length} appointments — POST ${config.apiBase}/calendars/events/appointments`,
  )
  appointments.forEach((appointment, index) => {
    out.log(
      `  appointment ${index + 1} — ${appointment.startTime} → ${appointment.endTime} · ` +
        `${appointment.contactId} · ${appointment.title}`,
    )
  })
}

/**
 * One create, sent and read.
 *
 * Returns the status alongside the parsed body whatever the status is, rather than throwing on a
 * non-2xx: HighLevel's duplicate refusal is a `400` whose body is the most useful thing in the
 * whole run, so the caller decides what a status means. A body that is not JSON becomes `null` —
 * a create that answers HTML is a failure with a status, not a crash mid-run.
 */
async function postJson(fetchImpl, url, version, token, body) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: headersFor(version, token),
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }

  return { status: response.status, body: parsed }
}

/** The id HighLevel gives a created contact back under. */
function contactIdOf(body) {
  const id = body?.contact?.id ?? body?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * HighLevel's duplicate refusal, or null. Accepts `meta.contactId` and `contactId`.
 *
 * This is the whole of the script's idempotency. A location that refuses duplicates answers a
 * second seed with `400` and the *existing* contact's id, which is exactly what the appointment
 * step needs — so the refusal is read as success and the id carried forward. The alternative,
 * `POST /contacts/search`, would hang a re-run's correctness on the least-verified call in the
 * platform (`docs/HIGHLEVEL_PLATFORM.md` §6.1).
 */
export function duplicateContactId(status, body) {
  if (status !== 400) return null

  const id = body?.meta?.contactId ?? body?.contactId
  return typeof id === 'string' && id !== '' ? id : null
}

/** What HighLevel said went wrong. `message` is sometimes an array of them. */
function messageOf(status, body) {
  const message = body?.message ?? body?.error
  if (Array.isArray(message)) return `HTTP ${status}: ${message.join('; ')}`
  if (typeof message === 'string' && message !== '') return `HTTP ${status}: ${message}`
  return `HTTP ${status}`
}

/** A non-2xx that is not a duplicate refusal. Carries the status for the summary. */
class SeedRequestError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'SeedRequestError'
    this.status = status
  }
}

/**
 * `GET /calendars/?locationId=` when either id is missing. Throws, naming the fix.
 *
 * The script creates no calendar, deliberately: `calendars.write` is a scope we chose not to
 * request (`docs/HIGHLEVEL_PLATFORM.md` §4), so a location with no calendar is a thing only a
 * human can fix in the sandbox UI — and saying so is more use than a 4xx echoed back. Each of
 * the three ways this can fail names the exact flag or step that fixes it.
 */
export async function resolveCalendar({ fetchImpl, config, calendarId, assignedUserId }) {
  // Nothing to resolve, nothing to ask. The 28-request run depends on this.
  if (calendarId !== null && assignedUserId !== null) return { calendarId, assignedUserId }

  const response = await fetchImpl(
    `${config.apiBase}/calendars/?locationId=${encodeURIComponent(config.locationId)}`,
    { method: 'GET', headers: headersFor(CALENDARS_VERSION, config.token) },
  )

  const text = await response.text()
  let body = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = null
  }

  if (response.status < 200 || response.status >= 300) {
    throw new SeedConfigError(
      `Could not list the calendars in ${config.locationId} — ` +
        `${messageOf(response.status, body)}. Check HL_SEED_LOCATION_ID and the token's ` +
        'scopes, or pass the calendar directly with --calendar-id.',
    )
  }

  const calendars = Array.isArray(body?.calendars) ? body.calendars : []
  const named =
    calendarId === null ? undefined : calendars.find((entry) => entry?.id === calendarId)

  /* A --calendar-id the location does not have is a typo, not a preference. */
  if (calendarId !== null && named === undefined) {
    throw new SeedConfigError(
      `No calendar ${calendarId} in location ${config.locationId}. It lists ` +
        `${calendars.length === 0 ? 'none' : calendars.map((entry) => entry?.id).join(', ')}. ` +
        'Check --calendar-id, or pass --assigned-user-id as well to skip this lookup ' +
        'entirely if the calendar exists but is not listed.',
    )
  }

  const calendar = named ?? calendars[0]

  if (calendar === undefined || typeof calendar.id !== 'string') {
    throw new SeedConfigError(
      `No calendar in location ${config.locationId}. This script does not create one — ` +
        'calendars.write is not a granted scope — so create one in the sandbox UI ' +
        '(Calendars → Create Calendar) and run this again.',
    )
  }

  const resolvedUserId = assignedUserId ?? calendar.teamMembers?.[0]?.userId ?? null
  if (typeof resolvedUserId !== 'string' || resolvedUserId === '') {
    throw new SeedConfigError(
      `Calendar ${calendar.id} ("${calendar.name ?? 'unnamed'}") has no team member to ` +
        'assign appointments to. Add one in the sandbox UI, or pass the user directly ' +
        'with --assigned-user-id.',
    )
  }

  return { calendarId: calendarId ?? calendar.id, assignedUserId: resolvedUserId }
}

function emptySummary(dryRun) {
  return {
    dryRun,
    contacts: { created: 0, existing: 0, failed: 0 },
    appointments: { created: 0, failed: 0 },
    failures: [],
    requests: 0,
  }
}

/** The run. Every dependency injected; no globals, no clock, no network of its own. */
export async function seed({
  env = process.env,
  argv = process.argv.slice(2),
  fetchImpl = fetch,
  now = () => new Date(),
  out = console,
} = {}) {
  const args = parseArgs(argv)
  // Before anything else, and before any request: a run that cannot finish
  // should not have started (AC-14).
  const config = readConfig(env)

  const summary = emptySummary(args.dryRun)
  const contacts = plannedContacts(config.locationId)

  if (args.dryRun) {
    const calendarId = args.calendarId ?? UNRESOLVED
    const assignedUserId = args.assignedUserId ?? UNRESOLVED

    printPlan({
      config,
      calendarId,
      assignedUserId,
      contacts,
      appointments: plannedAppointments({
        locationId: config.locationId,
        calendarId,
        assignedUserId,
        // A dry run has created nothing, so the rows name themselves.
        contactIds: contacts.map((_, index) => `contact ${index + 1}`),
        now: now(),
      }),
      out,
    })

    return summary
  }

  // Every request the run issues goes through here, so `requests` counts what
  // actually went out rather than what the loops meant to send.
  const counted = (url, init) => {
    summary.requests += 1
    return fetchImpl(url, init)
  }

  // First request of the run, and counted like every other. A run that cannot
  // place its appointments should not create twenty contacts first.
  const { calendarId, assignedUserId } = await resolveCalendar({
    fetchImpl: counted,
    config,
    calendarId: args.calendarId,
    assignedUserId: args.assignedUserId,
  })

  /* Per item, not per run. */
  const record = (bucket, item, err) => {
    bucket.failed += 1
    summary.failures.push({
      item,
      status: err instanceof SeedRequestError ? err.status : null,
      message: err instanceof Error ? err.message : String(err),
    })
  }

  out.log(`Creating ${contacts.length} contacts in ${config.locationId}…`)

  const contactIds = []
  for (const [index, contact] of contacts.entries()) {
    const item = `contact ${index + 1} — ${contact.firstName} ${contact.lastName}`

    try {
      const { status, body } = await postJson(
        counted,
        `${config.apiBase}/contacts/`,
        CONTACTS_VERSION,
        config.token,
        contact,
      )

      const existingId = duplicateContactId(status, body)
      if (existingId !== null) {
        summary.contacts.existing += 1
        contactIds.push(existingId)
        continue
      }

      if (status < 200 || status >= 300) throw new SeedRequestError(status, messageOf(status, body))

      const id = contactIdOf(body)
      if (id === null) throw new SeedRequestError(status, 'the response carried no contact id')

      summary.contacts.created += 1
      contactIds.push(id)
    } catch (err) {
      record(summary.contacts, item, err)
    }
  }

  const appointments = plannedAppointments({
    locationId: config.locationId,
    calendarId,
    assignedUserId,
    contactIds,
    now: now(),
  })

  out.log(`Creating ${appointments.length} appointments on calendar ${calendarId}…`)

  for (const [index, appointment] of appointments.entries()) {
    const item = `appointment ${index + 1} — ${appointment.startTime}`

    try {
      const { status, body } = await postJson(
        counted,
        `${config.apiBase}/calendars/events/appointments`,
        CALENDARS_VERSION,
        config.token,
        appointment,
      )

      if (status < 200 || status >= 300) throw new SeedRequestError(status, messageOf(status, body))

      summary.appointments.created += 1
    } catch (err) {
      record(summary.appointments, item, err)
    }
  }

  return summary
}

/**
 * The run, in four lines. Shared by `--dry-run` and by a real run, so an
 * operator reads the same shape whichever they did.
 */
export function printSummary(summary, out) {
  const { contacts, appointments } = summary

  out.log('')
  out.log(summary.dryRun ? 'Dry run — nothing was created.' : 'Seed complete.')
  out.log(
    `  contacts:     ${contacts.created} created, ${contacts.existing} existing, ` +
      `${contacts.failed} failed`,
  )
  out.log(`  appointments: ${appointments.created} created, ${appointments.failed} failed`)
  out.log(`  ${summary.requests} requests issued.`)

  if (summary.failures.length === 0) return

  out.error(`${summary.failures.length} item(s) failed:`)
  for (const failure of summary.failures) {
    out.error(`  ${failure.item} — ${failure.status ?? 'no response'}: ${failure.message}`)
  }
}

export function exitCodeFor(summary) {
  return summary.failures.length > 0 ? 1 : 0
}

// Guarded so importing this module from the spec seeds nothing.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  seed()
    .then((summary) => {
      printSummary(summary, console)
      process.exit(exitCodeFor(summary))
    })
    .catch((err) => {
      // A SeedConfigError is the operator's to fix and says how; anything else
      // is a bug, and its message is the most useful thing we have.
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
}
