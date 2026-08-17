import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Router, urlencoded, type Request, type Response } from 'express'

/**
 * A stand-in for HighLevel, mounted only under the emulator.
 *
 * ## Why this exists
 *
 * The e2e test has to walk the whole OAuth loop — click Connect, land on an
 * authorize page, approve, come back with a code, exchange it. Pointing that at
 * the real marketplace would make the suite depend on a network, a live app and
 * a sandbox that expires in six months. Pointing it here keeps the loop
 * identical and hermetic: the SPA, the callback and the redirect are all the
 * real ones, and only the far side is substituted.
 *
 * ## Why it is gated on FUNCTIONS_EMULATOR and nothing else
 *
 * It issues access tokens to anyone who asks and never checks a client secret.
 * Deployed, that is not a test double but an open door. `FUNCTIONS_EMULATOR` is
 * the one signal an operator cannot set by hand and a deploy cannot carry —
 * the same reasoning Slice 1 used for its fake mail transport (D21) and its
 * test-only cleanup route. A config flag here would be a remotely-settable way
 * to switch on a token minting service.
 *
 * ## Behaviour is selected by the authorization code
 *
 * Rather than a control API, the code itself says what should happen, so a test
 * reads as `approve('company-multi')` and the intent is on the page:
 *
 *   `loc-*`          a Location token — the shape a per-location install gives
 *   `company-one-*`  a Company token whose install covers exactly one location
 *   `company-multi-*` a Company token covering two — the ambiguous case
 *   `company-none-*` a Company token covering none
 *   `bad-*`          a 400, standing in for an expired or malformed code
 *
 * Refresh tokens follow the same idea: `dead-*` answers `invalid_grant`,
 * `boom-*` answers 500, anything else rotates.
 */

const LOCATION_ID = 'lUanVn0CtZJTlymH8ySo'
const LOCATION_NAME = 'India Square'
const COMPANY_ID = 'swdGTJYeSOLEHFfgZgPf'
const SECOND_LOCATION_ID = 'aB9zzQ1CtZJTlymH8ySo'

/**
 * Codes already exchanged.
 *
 * HighLevel consumes an authorization code on first use, and a replayed
 * callback URL therefore fails at the exchange rather than at the state check —
 * which is the behaviour that made a single-use state store unnecessary. The
 * callback's replay test depends on this being modelled.
 */
const consumedCodes = new Set<string>()

/**
 * How many requests the stub has received since the last reset.
 *
 * **The only way to observe a call that was never made.** A refusal that
 * short-circuits before the upstream request and one that forwards and then
 * fails are indistinguishable from the caller's side — both answer an error —
 * so the tests for "no upstream call was made" need the far side to say so.
 *
 * Module state, which assumes the request and the read land in the same
 * process. `consumedCodes` above already makes that assumption and the functions
 * emulator has honoured it; unlike the token exchange there is nothing to carry
 * this on the input instead, because the whole point is to count requests that
 * carry nothing.
 */
let receivedCalls = 0

/**
 * How many refresh grants have been asked for since the last reset.
 *
 * Separate from {@link receivedCalls} because the property it exists to prove
 * is different in kind: not "was anything sent" but "was it sent **once**". A
 * concurrent rotation that ran twice would still answer every caller
 * successfully, so the count is the only evidence D23's short-circuit is doing
 * anything at all.
 */
let refreshGrants = 0

/**
 * Control routes are spelled `__name` and are not counted.
 *
 * A counter that counted the read of itself would make every assertion in the
 * suite off by however many times it had been read.
 */
function isControlRoute(path: string): boolean {
  return path.startsWith('/__')
}

/** A query parameter as a string — see the same helper in callback.ts. */
function q(req: Request, name: string, fallback = ''): string {
  const value = req.query[name]
  return typeof value === 'string' ? value : fallback
}

/**
 * A body field as a string, narrowed rather than coerced.
 *
 * `String(unknown)` would turn `{"locationId":{"$ne":null}}` into
 * `"[object Object]"` — a value that then matches nothing and looks like a
 * filtering bug rather than a hostile body. Anything that is not a string is
 * treated as absent.
 */
function bodyField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  return typeof value === 'string' ? value : ''
}

/**
 * The five rate-limit headers §5 says HighLevel sends, on **every** response.
 *
 * Values rather than a passthrough, because what is under test is that the
 * proxy copies whatever it was given onto our response — so these need to be
 * distinguishable from anything the proxy could have invented.
 */
const RATE_LIMITS: Record<string, string> = {
  'X-RateLimit-Limit-Daily': '200000',
  'X-RateLimit-Daily-Remaining': '199987',
  'X-RateLimit-Interval-Milliseconds': '10000',
  'X-RateLimit-Max': '100',
  'X-RateLimit-Remaining': '97',
}

/**
 * A recorded HighLevel payload, read **inside the handler**.
 *
 * Anchored on `__dirname` rather than the working directory, and never at
 * module scope: `tests/` is not part of a deploy, so a top-level read would
 * turn a missing fixture into a module that will not load rather than a route
 * that is not reachable. `llm/fake.ts`'s `loadEvents` does exactly this.
 */
function loadFixture(name: string): Record<string, unknown> {
  const path = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'highlevel', name)
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/**
 * What every surface route does before it answers: attach the rate limits, and
 * **require the two headers the real API requires**.
 *
 * That requirement is the point rather than fidelity for its own sake. The
 * proxy attaching `Authorization` and `Version` is otherwise an assertion about
 * an argument; here it is the difference between a 200 and a 401, so AC-12 is
 * measured by whether the call worked at all.
 *
 * Returns false when it has already answered, so a caller reads
 * `if (!surface(req, res)) return`.
 */
function surface(req: Request, res: Response): boolean {
  for (const [name, value] of Object.entries(RATE_LIMITS)) res.set(name, value)

  const authorization = req.header('authorization') ?? ''
  if (!authorization.startsWith('Bearer ') || req.header('version') === undefined) {
    res.status(401).json({
      message: 'This endpoint requires an Authorization bearer token and a Version header.',
    })
    return false
  }
  return true
}

/**
 * `__echo` — a marker id that answers with the request headers received.
 *
 * A marker on an ordinary parameterised row rather than a control API, so it
 * matches the grammar exactly as a real id does and the three surface fixtures
 * keep answering unchanged. That matters: AC-15 measures the proxy's body
 * against those fixtures byte for byte, and a surface that had grown an echo
 * field would have nothing clean to be measured against.
 */
function echoed(req: Request, res: Response, id: string): boolean {
  if (id !== '__echo') return false
  res.json({ headers: req.headers })
  return true
}

/** Longer than the suite's overridden timeout, shorter than the real one. */
const SLOW_MS = 5_000

/** Just past the proxy's 5 MiB cap, and not a byte more than it has to be. */
const OVER_CAP_BYTES = 5 * 1024 * 1024 + 1024

/**
 * The failure markers, recognised in any path parameter.
 *
 * One helper called from every surface, so a route added later inherits the
 * whole failure vocabulary rather than the subset whoever added it remembered.
 * Same idiom as the authorization codes above: **the input says what should
 * happen**, so a case reads as the condition it is testing.
 *
 * `__huge` and `__hugestream` are the same condition reached two ways — one
 * declares a `Content-Length` the proxy can short-circuit on, the other arrives
 * chunked and declares nothing, so only the running byte count can stop it.
 */
function marked(res: Response, id: string): boolean {
  switch (id) {
    case '__401':
      // The shape their errors actually use — see the recorded
      // location-401-missing-scope.json fixture.
      res.status(401).json({ message: 'Invalid JWT' })
      return true
    case '__429':
      res.status(429).json({ message: 'Too many requests, please try again later' })
      return true
    case '__500':
      res.status(500).json({ message: 'Internal server error' })
      return true
    case '__slow':
      setTimeout(() => {
        res.json({ ok: true })
      }, SLOW_MS)
      return true
    case '__huge':
      res.json({ padding: 'x'.repeat(OVER_CAP_BYTES) })
      return true
    case '__hugestream':
      res.type('application/json')
      res.write('{"padding":"')
      for (let sent = 0; sent < OVER_CAP_BYTES; sent += 64 * 1024) {
        res.write('x'.repeat(64 * 1024))
      }
      res.end('"}')
      return true
    default:
      return false
  }
}

/**
 * Replay a fixture, filtered by the `locationId` the request actually carried.
 *
 * The filter is what turns tenant isolation into an observable result: a proxy
 * that failed to inject the caller's own location answers with somebody else's
 * records here, rather than passing an assertion about what it meant to send. A
 * location with no records answers an **empty array**, not a 404 — which is what
 * HighLevel does, and what makes "bob sees nothing of alice's" a readable
 * result.
 *
 * `total` is recomputed when the fixture carries one, so the count and the array
 * cannot disagree.
 */
function replay(res: Response, fixture: string, key: string, locationId: string): void {
  const body = loadFixture(fixture)
  const held = body[key]
  const rows = (Array.isArray(held) ? (held as Record<string, unknown>[]) : []).filter(
    (row) => row['locationId'] === locationId,
  )

  const out: Record<string, unknown> = { ...body, [key]: rows }
  if (typeof body['total'] === 'number') out['total'] = rows.length
  res.json(out)
}

function tokenBase(): Record<string, unknown> {
  return {
    access_token: `fake-access-${String(Math.random()).slice(2, 10)}`,
    refresh_token: `fake-refresh-${String(Math.random()).slice(2, 10)}`,
    expires_in: 86_399,
    token_type: 'Bearer',
    scope: 'locations.readonly contacts.readonly calendars.readonly',
    companyId: COMPANY_ID,
    userId: 'fake-user-id',
  }
}

function locationToken(): Record<string, unknown> {
  return { ...tokenBase(), userType: 'Location', locationId: LOCATION_ID }
}

/**
 * The company id encodes how many sub-accounts the install covers.
 *
 * Stateless on purpose. An earlier version kept the count in a module variable
 * set during the token exchange and read back during `installedLocations`, which
 * assumes both requests land in the same process — an assumption the functions
 * emulator does not guarantee. Carrying it on the `companyId` means each request
 * answers from its own input.
 */
function companyToken(count: number): Record<string, unknown> {
  return {
    ...tokenBase(),
    companyId: `${COMPANY_ID}-${String(count)}`,
    userType: 'Company',
    isBulkInstallation: true,
    approveAllLocations: true,
  }
}

export function buildFakeHlRouter(enabled: boolean): Router {
  const router = Router()
  if (!enabled) return router

  // HighLevel's token endpoint takes form-urlencoded, and so does this, so a
  // JSON body would fail here exactly as it fails there.
  router.use('/__fake-hl', urlencoded({ extended: false }))

  router.use('/__fake-hl', (req, _res, next) => {
    if (!isControlRoute(req.path)) receivedCalls += 1
    next()
  })

  router.get('/__fake-hl/__calls', (_req, res) => {
    res.json({ total: receivedCalls })
  })

  // Reset rather than a fresh process: the tests run against one long-lived
  // emulator, so `beforeEach` needs a way to zero it.
  router.delete('/__fake-hl/__calls', (_req, res) => {
    receivedCalls = 0
    res.json({ ok: true })
  })

  router.get('/__fake-hl/__refresh-count', (_req, res) => {
    res.json({ total: refreshGrants })
  })

  router.delete('/__fake-hl/__refresh-count', (_req, res) => {
    refreshGrants = 0
    res.json({ ok: true })
  })

  /**
   * The consent screen. Two controls, because a demo that cannot be declined
   * leaves the denied path untested.
   */
  router.get('/__fake-hl/v2/oauth/chooselocation', (req, res) => {
    const redirectUri = q(req, 'redirect_uri')
    const state = q(req, 'state')
    const kind = q(req, 'fake_kind', 'loc')
    const code = `${kind}-${String(Math.random()).slice(2, 10)}`

    const approve = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
    const deny = `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`

    res
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Fake HighLevel</title>` +
          `<h1>Fake HighLevel</h1>` +
          `<p>Standing in for the marketplace. Not reachable outside the emulator.</p>` +
          `<a id="approve" href="${approve}">Approve</a>` +
          `<a id="deny" href="${deny}">Deny</a>`,
      )
  })

  router.post('/__fake-hl/oauth/token', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>

    if (body['grant_type'] === 'refresh_token') {
      // Counted before the outcome is decided: what AC-26 asks is how many
      // refresh requests *reached* HighLevel, not how many succeeded.
      refreshGrants += 1
      const token = body['refresh_token'] ?? ''
      if (token.startsWith('dead-')) {
        res
          .status(400)
          .json({ error: 'invalid_grant', error_description: 'This refresh token is invalid' })
        return
      }
      if (token.startsWith('boom-')) {
        res.status(500).json({ message: 'upstream exploded' })
        return
      }
      res.json(locationToken())
      return
    }

    const code = body['code'] ?? ''
    if (code.startsWith('bad-') || consumedCodes.has(code)) {
      res
        .status(400)
        .json({ error: 'invalid_grant', error_description: 'Invalid authorization code' })
      return
    }
    consumedCodes.add(code)

    if (code.startsWith('company-multi')) res.json(companyToken(2))
    else if (code.startsWith('company-none')) res.json(companyToken(0))
    else if (code.startsWith('company-one')) res.json(companyToken(1))
    else res.json(locationToken())
  })

  router.get('/__fake-hl/oauth/installedLocations', (req, res) => {
    const suffix = q(req, 'companyId').split('-').at(-1)
    const count = Number.parseInt(suffix ?? '1', 10)
    const all = [
      { _id: LOCATION_ID, name: LOCATION_NAME, isInstalled: true },
      { _id: SECOND_LOCATION_ID, name: 'Second Sub-Account', isInstalled: true },
    ]
    const locations = all.slice(0, Number.isNaN(count) ? 1 : count)
    res.json({ locations, count: locations.length })
  })

  router.post('/__fake-hl/oauth/locationToken', (_req, res) => {
    res.status(201).json(locationToken())
  })

  /*
   * The three surfaces F7.1 names, replayed from the recorded fixtures.
   *
   * Literal segments are registered before parameterised ones, because Express
   * matches in registration order and `/calendars/events` would otherwise be
   * swallowed by `/calendars/:calendarId`. The proxy's own matcher computes
   * specificity instead and does not depend on this — but the stub is not the
   * thing under test, and a stub that answered the wrong route would make a
   * correct proxy look broken.
   */
  router.post('/__fake-hl/contacts/search', (req, res) => {
    if (!surface(req, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    replay(res, 'contacts-search.json', 'contacts', bodyField(body, 'locationId'))
  })

  // 201, as HighLevel answers a create — so "the status is mirrored, not
  // flattened to 200" has something to be measured on (AC-16).
  router.post('/__fake-hl/contacts/', (req, res) => {
    if (!surface(req, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    res.status(201).json({
      contact: { id: 'fake-created-contact', locationId: body['locationId'] ?? null },
    })
  })

  router.get('/__fake-hl/contacts/:contactId', (req, res) => {
    if (!surface(req, res)) return
    if (marked(res, req.params.contactId)) return
    if (echoed(req, res, req.params.contactId)) return
    res.json({ contact: { id: req.params.contactId, locationId: LOCATION_ID } })
  })

  router.get('/__fake-hl/conversations/search', (req, res) => {
    if (!surface(req, res)) return
    replay(res, 'conversations.json', 'conversations', q(req, 'locationId'))
  })

  router.get('/__fake-hl/calendars/', (req, res) => {
    if (!surface(req, res)) return
    replay(res, 'calendars.json', 'calendars', q(req, 'locationId'))
  })

  router.get('/__fake-hl/calendars/events', (req, res) => {
    if (!surface(req, res)) return
    replay(res, 'calendar-events.json', 'events', q(req, 'locationId'))
  })

  router.get('/__fake-hl/calendars/:calendarId', (req, res) => {
    if (!surface(req, res)) return
    if (marked(res, req.params.calendarId)) return
    if (echoed(req, res, req.params.calendarId)) return
    res.json({ calendar: { id: req.params.calendarId, locationId: LOCATION_ID } })
  })

  /** Wrapped, exactly as the real one is — see locationDetailSchema. */
  router.get('/__fake-hl/locations/:id', (req, res) => {
    if (req.params.id === 'no-such-location') {
      res.status(404).json({ message: 'not found' })
      return
    }
    res.json({ location: { id: req.params.id, name: LOCATION_NAME }, traceId: 'fake-trace' })
  })

  return router
}
