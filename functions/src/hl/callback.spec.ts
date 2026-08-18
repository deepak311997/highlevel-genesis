import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleCallback } from './callback'
import { HlRequestError } from './exchange'
import type { InstalledLocations, TokenResponse } from './schema'
import { sealState } from './state'

/**
 * What the OAuth callback says about itself when it fails.
 *
 * The endpoint's *behaviour* is covered at L4, against the emulator and the fake HighLevel, in
 * `tests/integration/hl-callback.spec.ts`. What is covered here is the other half, and the half
 * production actually needed: an install that fails leaves nothing behind but a redirect the
 * user cannot read and a log line we have to diagnose from. A line saying `HighLevel responded
 * 422` — which is what a real failed install left — names neither the call that was refused nor
 * the reason it gave, so both are asserted here.
 *
 * The counterweight is the last test in every group: none of this may put the authorization
 * code, the state or a token into the sink. The parameters travel in a URL to another company,
 * and a log line is the one place they must not also travel to.
 */

const mocks = vi.hoisted(() => ({
  set: vi.fn<(data: Record<string, unknown>) => Promise<void>>(),
  exchangeCode: vi.fn<(code: string) => Promise<TokenResponse>>(),
  listInstalledLocations: vi.fn<(token: string, company: string) => Promise<InstalledLocations>>(),
  exchangeForLocationToken:
    vi.fn<(token: string, company: string, location: string) => Promise<TokenResponse>>(),
  fetchLocationName: vi.fn<(token: string, location: string) => Promise<string | null>>(),
}))

vi.mock('../lib/firebase', () => ({
  getDb: () => ({ doc: () => ({ set: mocks.set }) }),
}))

// Spread the real module so `HlRequestError` stays the class `callback.ts` tests
// `instanceof` against — a hand-rolled double would pass every assertion here and
// none in production.
vi.mock('./exchange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exchange')>()),
  exchangeCode: mocks.exchangeCode,
  listInstalledLocations: mocks.listInstalledLocations,
  exchangeForLocationToken: mocks.exchangeForLocationToken,
  fetchLocationName: mocks.fetchLocationName,
}))

const SECRET = 'test-secret-not-a-real-key-0123456789'
const REDIRECT_URI = 'https://genesis.test/api/oauth/callback'
const CODE = 'SUPERSECRETCODE'

const LOCATION_TOKEN = {
  access_token: 'live-access-token',
  refresh_token: 'live-refresh-token',
  expires_in: 86_399,
  token_type: 'Bearer',
  scope: 'contacts.readonly',
  companyId: 'company-1',
  userType: 'Location' as const,
  locationId: 'loc-1',
}

const COMPANY_TOKEN = { ...LOCATION_TOKEN, userType: 'Company' as const, locationId: undefined }

let info: ReturnType<typeof vi.fn>
let redirect: ReturnType<typeof vi.fn>
let state: string

/** Every line the handler emitted, parsed back out of the sink. */
function lines(): Record<string, unknown>[] {
  return info.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
}

function line(event: string): Record<string, unknown> | undefined {
  return lines().find((entry) => entry['event'] === event)
}

/** Everything written to the sink, as one string — for the "must not contain" assertions. */
function sink(): string {
  return info.mock.calls.map((call) => String(call[0])).join('\n')
}

function res(): Response {
  return { redirect } as unknown as Response
}

function req(query: Record<string, string>): Request {
  return { query } as unknown as Request
}

/** The location of the single redirect the handler is allowed to answer with. */
function redirectedTo(): string {
  expect(redirect).toHaveBeenCalledTimes(1)
  return String(redirect.mock.calls[0]?.[1])
}

beforeEach(() => {
  process.env['OAUTH_STATE_SECRET'] = SECRET
  process.env['HL_TOKEN_SECRET'] = SECRET
  process.env['HL_REDIRECT_URI'] = REDIRECT_URI
  state = sealState('PZ9kQxLm3nR7vB2t')

  info = vi.fn()
  redirect = vi.fn()
  vi.stubGlobal('console', { ...console, info, error: vi.fn() })

  mocks.set.mockResolvedValue(undefined)
  mocks.exchangeCode.mockResolvedValue(LOCATION_TOKEN)
  mocks.fetchLocationName.mockResolvedValue('India Square')
  mocks.listInstalledLocations.mockResolvedValue({ locations: [{ _id: 'loc-1' }] })
  mocks.exchangeForLocationToken.mockResolvedValue(LOCATION_TOKEN)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  delete process.env['OAUTH_STATE_SECRET']
  delete process.env['HL_TOKEN_SECRET']
  delete process.env['HL_REDIRECT_URI']
})

describe('what arrived', () => {
  it('records which parameters the callback carried, and the redirect URI it was configured with', async () => {
    await handleCallback(req({ code: CODE, state }), res())

    const received = line('hl.callback.received')
    expect(received?.['hasCode']).toBe(true)
    expect(received?.['hasState']).toBe(true)
    expect(received?.['redirectUri']).toBe(REDIRECT_URI)
  })

  it('records a callback with no code as its own step rather than as a failed exchange', async () => {
    await handleCallback(req({ state }), res())

    expect(line('hl.callback.no_code')).toBeDefined()
    expect(redirectedTo()).toContain('code=exchange_failed')
  })

  /*
   * The user is told one thing for all four rejections, deliberately — but the log may say which,
   * because a prober cannot read it and "the state was missing" and "the state was rejected" are
   * different bugs.
   */
  it.each([
    ['absent', ''],
    ['rejected', 'not-a-real-state'],
  ])('distinguishes a state that is %s, in the log only', async (detail, value) => {
    await handleCallback(req({ code: CODE, state: value }), res())

    expect(line('hl.callback.invalid_state')?.['detail']).toBe(detail)
    expect(redirectedTo()).toContain('code=invalid_state')
  })

  it('puts neither the code nor the state in the sink', async () => {
    await handleCallback(req({ code: CODE, state }), res())

    expect(sink()).not.toContain(CODE)
    expect(sink()).not.toContain(state)
  })
})

describe('an exchange HighLevel refuses', () => {
  it('names the endpoint, the status and the reason the body gave', async () => {
    mocks.exchangeCode.mockRejectedValue(
      new HlRequestError(400, '{"error":"invalid_grant"}', '/oauth/token'),
    )

    await handleCallback(req({ code: CODE, state }), res())

    const failed = line('hl.callback.exchange_failed')
    expect(failed?.['status']).toBe(400)
    expect(failed?.['endpoint']).toBe('/oauth/token')
    expect(String(failed?.['detail'])).toContain('invalid_grant')
    expect(redirectedTo()).toContain('code=exchange_failed')
  })

  it('records a thrown value that is not an upstream failure at all', async () => {
    mocks.exchangeCode.mockRejectedValue(new Error('Missing HL_CLIENT_SECRET.'))

    await handleCallback(req({ code: CODE, state }), res())

    expect(String(line('hl.callback.exchange_failed')?.['detail'])).toContain('HL_CLIENT_SECRET')
  })
})

/*
 * The production failure, reproduced. A real install answered `userType: "Company"`, the agency
 * path ran, and one of its two calls came back 422 — with the log naming neither which call nor
 * what the body said, which is the entire reason this file exists.
 */
describe('the agency path', () => {
  it('records the install shape before the calls that depend on it', async () => {
    mocks.exchangeCode.mockResolvedValue(COMPANY_TOKEN)

    await handleCallback(req({ code: CODE, state }), res())

    expect(line('hl.callback.exchanged')?.['userType']).toBe('Company')
  })

  it('names the refused call and its body when listing sub-accounts fails', async () => {
    mocks.exchangeCode.mockResolvedValue(COMPANY_TOKEN)
    mocks.listInstalledLocations.mockRejectedValue(
      new HlRequestError(
        422,
        '{"message":["appId must be a string"]}',
        '/oauth/installedLocations',
      ),
    )

    await handleCallback(req({ code: CODE, state }), res())

    const failed = line('hl.callback.resolve_failed')
    expect(failed?.['status']).toBe(422)
    expect(failed?.['endpoint']).toBe('/oauth/installedLocations')
    expect(String(failed?.['detail'])).toContain('appId must be a string')
  })

  it('records how many sub-accounts a bulk install covers before refusing it', async () => {
    mocks.exchangeCode.mockResolvedValue(COMPANY_TOKEN)
    mocks.listInstalledLocations.mockResolvedValue({
      locations: [{ _id: 'loc-1' }, { _id: 'loc-2' }],
    })

    await handleCallback(req({ code: CODE, state }), res())

    const refused = line('hl.callback.wrong_account_type')
    expect(refused?.['locationCount']).toBe(2)
    expect(refused?.['userType']).toBe('Company')
    expect(redirectedTo()).toContain('code=wrong_account_type')
  })
})

describe('the write at the end', () => {
  /*
   * Before this, a Firestore write that threw escaped to the error handler and answered a JSON
   * 500 — on a top-level navigation, which means an unstyled page outside the SPA. The file's
   * own invariant is that every path answers with a 302, and this is the path that broke it.
   */
  it('logs a failed write and still sends the browser into the SPA', async () => {
    mocks.set.mockRejectedValue(new Error('PERMISSION_DENIED'))

    await handleCallback(req({ code: CODE, state }), res())

    expect(line('hl.callback.store_failed')).toBeDefined()
    expect(redirectedTo()).toContain('code=exchange_failed')
  })

  it('records the connection it wrote, and no part of the token it wrote it from', async () => {
    await handleCallback(req({ code: CODE, state }), res())

    const connected = line('hl.callback.connected')
    expect(connected?.['userType']).toBe('Location')
    expect(typeof connected?.['durationMs']).toBe('number')
    expect(sink()).not.toContain('live-access-token')
    expect(sink()).not.toContain('live-refresh-token')
  })
})
