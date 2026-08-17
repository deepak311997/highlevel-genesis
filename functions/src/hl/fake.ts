import { Router, urlencoded, type Request } from 'express'

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

/** A query parameter as a string — see the same helper in callback.ts. */
function q(req: Request, name: string, fallback = ''): string {
  const value = req.query[name]
  return typeof value === 'string' ? value : fallback
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
