import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  exchangeCode,
  exchangeForLocationToken,
  fetchLocationName,
  refreshTokens,
} from './exchange'

/**
 * The wire shape of our calls to HighLevel.
 *
 * Asserted against a stubbed `fetch` rather than against a live server, because
 * these are the details that fail *silently* or with an unhelpful error, and a
 * server that happens to be lenient would hide them:
 *
 *  - `/oauth/token` takes **form-urlencoded**. Sending JSON is documented as
 *    the single most common failure on this endpoint, and the error it returns
 *    says nothing useful.
 *  - `/oauth/token` is the **one** endpoint that takes no `Version` header.
 *    Every other endpoint rejects a request without one.
 *  - `/oauth/locationToken` disagrees with `/oauth/token` and takes **JSON**.
 */

const LOCATION_TOKEN = {
  access_token: 'a',
  refresh_token: 'r',
  expires_in: 86_399,
  token_type: 'Bearer',
  scope: 'contacts.readonly',
  companyId: 'company-1',
  userType: 'Location',
  locationId: 'loc-1',
}

type FetchStub = (url: string, init: RequestInit) => Promise<Response>

let fetchMock: ReturnType<typeof vi.fn<FetchStub>>
const saved: Record<string, string | undefined> = {}
const KEYS = [
  'HL_CLIENT_ID',
  'HL_CLIENT_SECRET',
  'HL_REDIRECT_URI',
  'HL_API_BASE',
  'FUNCTIONS_EMULATOR',
  'HL_TEST_UPSTREAM_TIMEOUT_MS',
] as const

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

/** The init object of the most recent call. */
function lastInit(): RequestInit {
  return fetchMock.mock.calls.at(-1)?.[1] ?? {}
}

/** The body of the last call, which every call site here sends as a string. */
function lastBody(): string {
  return (lastInit().body ?? '') as string
}

function lastHeaders(): Record<string, string> {
  return (lastInit().headers ?? {}) as Record<string, string>
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key]
  process.env['HL_CLIENT_ID'] = 'client-1'
  process.env['HL_CLIENT_SECRET'] = 'secret-1'
  process.env['HL_REDIRECT_URI'] = 'https://app.test/api/oauth/callback'
  process.env['HL_API_BASE'] = 'https://hl.test'

  fetchMock = vi.fn<FetchStub>().mockResolvedValue(jsonResponse(LOCATION_TOKEN))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

describe('exchangeCode', () => {
  it('posts form-urlencoded, never JSON', async () => {
    await exchangeCode('the-code')

    expect(lastHeaders()['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(typeof lastInit().body).toBe('string')
  })

  it('sends no Version header — the one endpoint that must not have one', async () => {
    await exchangeCode('the-code')

    expect(Object.keys(lastHeaders()).map((k) => k.toLowerCase())).not.toContain('version')
  })

  it('carries the credentials, the grant, and user_type=Location', async () => {
    await exchangeCode('the-code')
    const body = new URLSearchParams(lastBody())

    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('user_type')).toBe('Location')
    expect(body.get('client_id')).toBe('client-1')
    expect(body.get('client_secret')).toBe('secret-1')
  })

  it('sends the redirect_uri, which HighLevel matches exactly', async () => {
    await exchangeCode('the-code')

    expect(new URLSearchParams(lastBody()).get('redirect_uri')).toBe(
      'https://app.test/api/oauth/callback',
    )
  })

  it('rejects a non-2xx rather than parsing an error body as a token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400))

    await expect(exchangeCode('spent')).rejects.toThrow()
  })

  it('rejects a 200 whose body is not a token response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }))

    await expect(exchangeCode('odd')).rejects.toThrow()
  })
})

describe('refreshTokens', () => {
  it('uses the refresh grant and sends the token', async () => {
    await refreshTokens('the-refresh-token')
    const body = new URLSearchParams(lastBody())

    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('the-refresh-token')
  })

  /*
   * The token endpoint is the one upstream call that runs **inside a Firestore
   * transaction** (`tokenStore.ts`), so its duration is a document lock's
   * duration. Unbounded, a HighLevel that accepts the connection and then says
   * nothing holds `hlConnections/{uid}` until the function's own 60-second
   * timeout kills the invocation, and every other proxied call for that user
   * queues behind it, each burning its own budget.
   *
   * The proxy's own upstream call has had a bound since D27; this one is the
   * same bound from the same setting, so there is one number rather than two.
   */
  it('abandons a token call that never answers', async () => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'
    process.env['HL_TEST_UPSTREAM_TIMEOUT_MS'] = '40'
    // A HighLevel that accepts the connection and then never answers: the only
    // thing that ends this call is the signal the implementation attaches.
    const stalls = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    fetchMock.mockImplementation(stalls)

    await expect(refreshTokens('the-refresh-token')).rejects.toThrow()
  })
})

describe('exchangeForLocationToken', () => {
  /*
   * JSON here, unlike /oauth/token. The two endpoints genuinely disagree about
   * their body format, and HighLevel's documentation shows this one as JSON.
   */
  it('posts JSON, and carries the Version header this endpoint requires', async () => {
    await exchangeForLocationToken('agency-token', 'company-1', 'loc-1')

    expect(lastHeaders()['Content-Type']).toBe('application/json')
    expect(lastHeaders()['Version']).toBe('2021-07-28')
    expect(lastHeaders()['Authorization']).toBe('Bearer agency-token')
    expect(JSON.parse(lastBody())).toEqual({
      companyId: 'company-1',
      locationId: 'loc-1',
    })
  })
})

describe('fetchLocationName', () => {
  it('reads the name out of the wrapper HighLevel returns', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ location: { id: 'loc-1', name: 'India Square' } }))

    await expect(fetchLocationName('token', 'loc-1')).resolves.toBe('India Square')
  })

  /*
   * Null rather than a throw, on every failure. This decides whether the panel
   * reads "Connected to India Square" or shows a raw id — a connection that
   * works is worth more than a label, so a failure here must not undo one.
   */
  it.each([
    [
      'the request fails',
      (): void => {
        fetchMock.mockRejectedValue(new Error('network'))
      },
    ],
    [
      'the scope is missing',
      (): void => {
        fetchMock.mockResolvedValue(jsonResponse({}, 401))
      },
    ],
    [
      'the shape is unexpected',
      (): void => {
        fetchMock.mockResolvedValue(jsonResponse({ name: 'x' }))
      },
    ],
  ])('returns null when %s, rather than failing the connection', async (_why, arrange) => {
    arrange()

    await expect(fetchLocationName('token', 'loc-1')).resolves.toBeNull()
  })
})
