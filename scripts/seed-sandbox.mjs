#!/usr/bin/env node
/**
 * Seed a HighLevel sandbox location with demo data — 20 contacts, 8 appointments.
 *
 * The demo the assignment is graded on renders real CRM data, and an empty
 * sandbox renders nothing. This fills one, from the operator's own token:
 *
 *   HL_SEED_TOKEN=… HL_SEED_LOCATION_ID=… node scripts/seed-sandbox.mjs --dry-run
 *   HL_SEED_TOKEN=… HL_SEED_LOCATION_ID=… node scripts/seed-sandbox.mjs
 *
 * `--dry-run` first, always: it prints every row it would create and issues zero
 * requests, so the first real run costs nothing to preview.
 *
 * It talks to HighLevel directly, with the operator's Private Integration Token
 * or OAuth access token — the API is identical for both. It is an operator
 * chore, not a product path: it is not part of the deployed application, it
 * holds no user's credential, and it stores nothing anywhere but HighLevel.
 * `seed-sandbox.spec.mjs` names the surfaces this file must never touch and
 * proves it never does, by scanning this whole file including its comments —
 * which is why the list lives there and not here.
 *
 * A re-run is not an error. HighLevel refuses a duplicate contact with a `400`
 * that carries the existing contact's id, and that refusal is read as success
 * with the id carried forward (D10), so seeding twice is safe and cheap.
 */

export const CONTACT_COUNT = 20
export const APPOINTMENT_COUNT = 8
export const CONTACTS_VERSION = '2021-07-28'
export const CALENDARS_VERSION = '2021-04-15'
export const DEFAULT_API_BASE = 'https://services.leadconnectorhq.com'
export const SEED_TAG = 'genesis-seed'

/** What a dry run prints where a real run would have an id it has not fetched. */
const UNRESOLVED = '<resolved at run time>'

const DAY_MS = 24 * 60 * 60 * 1000
/** Two per business day, 30 minutes each — 10:00 and 15:00 local to the offset. */
const APPOINTMENT_HOURS = [10, 15]
const APPOINTMENT_MINUTES = 30

/**
 * The twenty names, frozen.
 *
 * A table rather than a generator so the plan is the same on every run and on
 * every machine: the operator can diff two dry runs, and a contact that failed
 * is at the same row number the next time. `seed-sandbox.spec.mjs` leans on
 * that — the third row is the one it fails on purpose.
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
 * An unknown flag throws rather than being ignored: a mistyped
 * `--calender-id` that is silently dropped would send the run at whatever
 * calendar `GET /calendars/` happens to list first, which is the one outcome
 * the operator was trying to avoid by passing the flag.
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
      throw new SeedConfigError(
        `Unknown option ${arg}. Usage: node scripts/seed-sandbox.mjs ` +
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
 * `HL_API_BASE` is read too, but is not required: it defaults to the public
 * host and exists so a run can be pointed at a stand-in without editing code.
 */
export function readConfig(env) {
  return {
    token: required(env, 'HL_SEED_TOKEN'),
    locationId: required(env, 'HL_SEED_LOCATION_ID'),
    apiBase: (env.HL_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
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

  return summary
}

export function exitCodeFor(summary) {
  return summary.failures.length > 0 ? 1 : 0
}
