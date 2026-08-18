import { PROXY_ERROR_CODES } from '../hl/proxyError'
import type { HlRoute } from '../hl/routes'
import { HL_ROUTES, isRouteEnabled } from '../hl/routes'

/**
 * The HighLevel cheat-sheet — the last block of the system prompt's stable
 * prefix, behind the `cache_control` breakpoint, and the only place the model
 * learns that a CRM exists at all.
 *
 * **Rendered from the allowlist, never restated.** The route table is built at
 * module load from `HL_ROUTES`, filtered by `isRouteEnabled` — the same rows the
 * proxy matches against. A hand-written copy would drift on the first allowlist
 * change, and the failure mode is the worst available: the model confidently
 * generating a route the proxy answers `403` on, with nothing failing until a user
 * runs the app.
 *
 * Rendered **once**, at load: the prefix has to be byte-identical on every request
 * or the cache read never happens. Flipping `HL_ALLOW_MESSAGE_SEND` therefore
 * costs exactly one cache write, which is correct rather than a bug.
 *
 * Deliberately absent: **any URL** (generated code cannot reach HighLevel
 * directly, and must not learn the proxy path either — the preview is an
 * opaque-origin iframe that cannot carry an ID token); **the `Version` values**,
 * which are date-shaped and would look volatile inside a cached prefix; **any
 * literal timestamp**, for the same reason; and **`/contacts/search`'s filter
 * grammar**, which is unverified — teaching a guessed DSL yields a 400 the user
 * reads as "Genesis is broken".
 *
 * The derived parts cannot be wrong. The per-surface **notes** below are
 * hand-written and are the part a reviewer has to check against the platform doc;
 * the response examples sit between the two, hand-trimmed with every field name
 * checked against the recorded payload.
 */

/**
 * What each row is *for*, keyed by method **and** pattern: `GET` and
 * `PUT /contacts/:contactId` are one pattern and two different things to say.
 *
 * A row with no note renders {@link NOTE_MISSING} rather than an empty dash, so a
 * route added without a sentence about it is a visible gap in the prompt.
 */
const ROUTE_NOTES: Record<string, string> = {
  'POST /contacts/search': 'one page of contacts. This is the only way to list or search them.',
  'GET /contacts/:contactId': 'one contact, by id. For a detail view — never to fill in a list.',
  'POST /contacts/': 'create a contact.',
  'PUT /contacts/:contactId': 'update a contact, by id. Send only the fields you are changing.',
  'GET /conversations/search': 'one page of conversations, with the contact each one belongs to.',
  'GET /conversations/:conversationId': 'one conversation, by id.',
  'GET /conversations/:conversationId/messages': 'the messages inside one conversation.',
  'POST /conversations/messages':
    'send an SMS or email to a contact. It reaches a real person and costs the account money, so ask before you build a screen that sends one.',
  'GET /calendars/': 'every calendar in the account. Use it to let the person pick one.',
  'GET /calendars/:calendarId': 'one calendar, by id.',
  'GET /calendars/events': 'booked appointments inside a time window. See the note below.',
  'GET /calendars/events/appointments/:eventId': 'one booked appointment, by id.',
  'GET /calendars/:calendarId/free-slots': 'the open slots on one calendar.',
}

/** The visible gap a note-less row leaves. */
const NOTE_MISSING = 'no note yet — ask before using this one.'

function tableLine(row: HlRoute): string {
  return `- ${row.method} ${row.pattern} — ${ROUTE_NOTES[`${row.method} ${row.pattern}`] ?? NOTE_MISSING}`
}

/**
 * One trimmed record per surface, hand-authored from the recorded payloads.
 *
 * Exported as **data** so the spec can walk each example's field names against the
 * fixture it names — the only thing standing between a trimmed example and
 * fiction. A plausible field HighLevel never sends would produce a dashboard
 * rendering blanks over real data, which looks like our bug.
 *
 * Trimmed rather than pasted whole: the fixtures are 2–20 KB each. Temporal values
 * are the one thing not copied verbatim — a literal timestamp would look volatile
 * inside the cached prefix, and the format is the part the model needs anyway.
 */
export const RESPONSE_EXAMPLES: readonly {
  /** The route it comes back from, spelled as the table spells it. */
  surface: string
  /** The recorded payload under `tests/fixtures/highlevel/`, for AC-9. */
  fixture: string
  /** The trimmed record, rendered into the cheat-sheet as pretty JSON. */
  example: unknown
}[] = [
  {
    surface: '/contacts/search',
    fixture: 'contacts-search.json',
    example: {
      contacts: [
        {
          id: 'D6id4dMzevwnm7yO25PS',
          contactName: '(example) jordan smith',
          firstName: '(Example) Jordan',
          lastName: 'Smith',
          email: 'jordan.smith@example.com',
          phone: null,
          companyName: "(Example) MacLaren's Pub",
          country: 'US',
          type: 'customer',
          tags: ['follow-up'],
          dnd: true,
          dateAdded: 'an ISO 8601 timestamp',
        },
      ],
      total: 5,
    },
  },
  {
    surface: '/calendars/events',
    fixture: 'calendar-events.json',
    example: {
      events: [
        {
          id: 'sWUUpNfU7obtpdYjy1QI',
          calendarId: 'j02qMVwUOyDFNMUwWGTL',
          contactId: 'pzTPaMBuKEjmCTTTLV5D',
          title: '(Example) Alex Doe Carter',
          appointmentStatus: 'confirmed',
          startTime: 'an ISO 8601 timestamp with a UTC offset',
          endTime: 'an ISO 8601 timestamp with a UTC offset',
        },
      ],
    },
  },
  {
    surface: '/calendars/',
    fixture: 'calendars.json',
    example: {
      calendars: [
        {
          id: '2oKn7but6Q2WaHIu7pqC',
          name: 'Specialty Bread Baking',
          description: '',
          calendarType: 'service_booking',
          eventType: 'RoundRobin_OptimizeForEqualDistribution',
          slotDuration: 60,
          slotDurationUnit: 'mins',
          isActive: false,
        },
      ],
    },
  },
  {
    surface: '/conversations/search',
    fixture: 'conversations.json',
    example: {
      conversations: [
        {
          id: 'ZK41PMvZ6QIF7JSIi29R',
          contactId: 'D6id4dMzevwnm7yO25PS',
          contactName: '(Example) Jordan Smith',
          email: 'jordan.smith@example.com',
          phone: null,
          type: 'TYPE_PHONE',
          unreadCount: 0,
          lastMessageType: 'TYPE_NO_SHOW',
          lastMessageDate: 'epoch milliseconds',
        },
      ],
      total: 5,
    },
  },
]

/**
 * The calling convention, verbatim as the frontend implements it and as the
 * preview's shim must define it.
 *
 * Told as "already defined in the page" rather than as an API to set up: every
 * line the model spends importing an SDK is a line that cannot run.
 */
const CALLING_CONVENTION = [
  'Talking to the CRM.',
  '',
  'The apps you write run against a HighLevel CRM account. They reach it through',
  'one function, already defined on the page for you. There is nothing to import,',
  'no address to fetch and no key to handle:',
  '',
  "  const page = await hl('POST', '/contacts/search', { pageLimit: 20 })",
  "  const events = await hl('GET', '/calendars/events', { startTime, endTime, calendarId })",
  '',
  '- The third argument is optional. On GET it is sent as the query string; on',
  '  POST and PUT it is sent as the JSON body.',
  "- The call resolves with HighLevel's own JSON body, unwrapped — exactly the",
  '  object shown under "What comes back" below.',
  '- The call rejects when anything goes wrong. See "When a call fails".',
  '- Sign-in and the account it reads are handled for you, on the server.',
]

/**
 * The two rules, stated as rules rather than as advice — the two ways a
 * reasonable-looking generated app fails in front of the person who asked for it:
 * a parameter that is silently discarded, and a list screen that exhausts the
 * burst allowance on its first render.
 */
const HARD_RULES = [
  'Two rules, and neither has an exception.',
  '',
  '1. Never send `locationId` — not in a query, not in a body, not anywhere. The',
  '   account is attached on the server from the CRM connection the person',
  '   already made. A `locationId` you send is removed before the request leaves,',
  '   so code that sends one is code whose most visible parameter does nothing,',
  '   and anyone reading it would wrongly conclude the app spans several',
  '   accounts.',
  '',
  '2. Never make one request per row. Read a page from a list or search route and',
  '   render from that page; if you need a detail the page does not carry, show',
  '   it when the person opens that one row. An account may make 100 requests',
  '   every 10 seconds, so a list of fifty rows that fetches each row separately',
  '   spends half of that allowance drawing one screen and starts failing partway',
  '   through it.',
]

/**
 * Where `HL_ROUTES` becomes prose, filtered by the environment at load. Reading
 * `process.env` here rather than per call is what keeps the prefix a constant
 * within a process — the only symptom of a per-call prefix is the bill.
 */
const ROUTE_TABLE = [
  'The routes you may call.',
  '',
  'This is the whole list. Anything else is refused by the server before it',
  'reaches HighLevel, so an app that calls a route which is not here does not',
  'half-work — it fails. Paths are exact; a segment written like `:contactId` is',
  'an id you substitute.',
  '',
  ...HL_ROUTES.filter((row) => isRouteEnabled(row, process.env)).map(tableLine),
]

/**
 * The per-surface parameters — the hand-written half, and the highest-value lines
 * in the file.
 *
 * The calendar note decides whether the demo shows anything at all: an ISO 8601
 * window does not error, it answers 200 with an empty list, so the wrong format is
 * indistinguishable from an empty calendar. The direction reverses on the way
 * back, which is why both halves are stated together.
 */
const PARAMETER_NOTES = [
  'Parameters worth knowing.',
  '',
  '`/contacts/search` takes `{ pageLimit, page }` and nothing else you should',
  'rely on. It has a filtering and sorting grammar; it is not documented here and',
  'you must not guess one, because a wrong filter is rejected outright and the',
  'person sees an app that will not load. Ask for a page — twenty is a sensible',
  'default — and do any filtering, searching or sorting in the browser, over the',
  'page you were given.',
  '',
  '`/calendars/events` takes `startTime` and `endTime` as **epoch milliseconds**',
  '(what `Date.now()` gives you, and what `date.getTime()` gives you), plus',
  'exactly one of `calendarId`, `userId` or `groupId` to say whose events you',
  'want. Get the calendar id from the calendar list route above.',
  '',
  'The trap: an ISO 8601 string in `startTime` or `endTime` does not fail. It is',
  'an empty success — HTTP 200 with `{"events":[]}` — which looks exactly like a',
  'calendar with nothing booked in it, so the app quietly shows an empty screen',
  'and nobody can tell why. Send numbers.',
  '',
  'Times coming back go the other way. Appointments carry `startTime` and',
  '`endTime` as ISO 8601 strings, and contacts carry `dateAdded` the same way, so',
  'parse them with `new Date(value)`. Conversations are the exception: their',
  'dates are epoch milliseconds, which `new Date(value)` also accepts. Never',
  'print a raw date value at a person — format it.',
]

/** The response shapes: real payloads beat prose, and they are what makes
 * generated code render real data on the first try. */
const RESPONSE_SHAPES = [
  'What comes back.',
  '',
  'One real record per route, trimmed to the fields a small app reads — the real',
  'payloads carry many more, and `total` counts the whole page rather than the one',
  'record shown here. Fields are often `null`; check before you render one.',
  '',
  ...RESPONSE_EXAMPLES.flatMap((entry) => [
    `\`${entry.surface}\` responds with:`,
    '',
    JSON.stringify(entry.example, null, 2),
    '',
  ]),
]

/**
 * The error contract, with the codes read from `proxyError.ts`.
 *
 * A rejection rather than a result union, because `try`/`catch` is the idiom every
 * JavaScript developer already writes. The codes are rendered from the same table
 * the proxy answers with, so generated code cannot branch on a spelling that no
 * longer exists.
 */
const ERROR_CONTRACT = [
  'When a call fails.',
  '',
  'A failed call rejects, so wrap every one of them in try / catch. Never leave a',
  'rejected call unhandled: an app that shows a spinner forever is worse than one',
  'that says what went wrong.',
  '',
  'The error carries three things: `message`, a sentence written for the person —',
  'show it to them as it is; `status`, a number; and `code`, one of exactly these:',
  '',
  ...PROXY_ERROR_CODES.map((code) => `- ${code}`),
  '',
  'Two are worth handling by name. When `code` is `hl_reconnect_required` or',
  '`hl_not_connected`, the account is not reachable and retrying will not help:',
  'tell the person to reconnect HighLevel in Genesis, and stop. When `code` is',
  '`hl_rate_limited`, the app asked for too much too quickly — say so, and see the',
  'second rule above, because that is almost always the cause.',
  '',
  'A call that works and a call that fails, together:',
  '',
  '  try {',
  "    const page = await hl('POST', '/contacts/search', { pageLimit: 20 })",
  '    renderContacts(page.contacts)',
  '  } catch (err) {',
  "    if (err.code === 'hl_reconnect_required') {",
  "      showMessage('Reconnect HighLevel in Genesis, then reload this page.')",
  '    } else {',
  '      showMessage(err.message)',
  '    }',
  '  }',
]

/**
 * The rendered cheat-sheet — one string, built once. One block rather than
 * several, so "the breakpoint is the last element of the stable prefix" stays a
 * one-line assertion.
 */
export const HL_KNOWLEDGE: string = [
  CALLING_CONVENTION,
  HARD_RULES,
  ROUTE_TABLE,
  PARAMETER_NOTES,
  RESPONSE_SHAPES,
  ERROR_CONTRACT,
]
  .map((section) => section.join('\n'))
  .join('\n\n')
