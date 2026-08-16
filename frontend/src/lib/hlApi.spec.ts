import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getIdToken = vi.hoisted(() => vi.fn())
const currentUser = vi.hoisted(() => ({ value: null as { getIdToken: () => Promise<string> } | null }))

vi.mock('@/lib/firebase', () => ({
  auth: {
    get currentUser() {
      return currentUser.value
    },
  },
}))

vi.mock('@/lib/appCheck', () => ({
  appCheckHeader: () => Promise.resolve({ 'X-Firebase-AppCheck': 'app-check-token' }),
}))

const { disconnect, getConnection, startConnect } = await import('./hlApi')
const { ApiError } = await import('./api')

/**
 * The client for the HighLevel connection endpoints.
 *
 * Every call is authenticated, and the header assembly is the part worth
 * testing: an ID token read once and cached would start failing silently on a
 * tab left open past its hourly rotation, and a missing App Check header turns
 * a working disconnect into a 401.
 */

let fetchMock: ReturnType<typeof vi.fn>

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1) ?? []
  return [String(call[0]), (call[1] ?? {}) as RequestInit]
}

beforeEach(() => {
  vi.clearAllMocks()
  getIdToken.mockResolvedValue('id-token-1')
  currentUser.value = { getIdToken }
  fetchMock = vi.fn().mockResolvedValue(response({ connected: false }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getConnection', () => {
  it('asks the endpoint and returns what it says', async () => {
    fetchMock.mockResolvedValue(response({ connected: true, locationName: 'India Square' }))

    await expect(getConnection()).resolves.toEqual({
      connected: true,
      locationName: 'India Square',
    })
    expect(lastCall()[0]).toContain('/api/hl/connection')
  })

  it('carries the ID token and the App Check header', async () => {
    await getConnection()
    const headers = lastCall()[1].headers as Record<string, string>

    expect(headers['Authorization']).toBe('Bearer id-token-1')
    expect(headers['X-Firebase-AppCheck']).toBe('app-check-token')
  })

  /*
   * Read per request, not cached. Firebase rotates the ID token roughly hourly,
   * and a cached one turns a tab left open into a stream of 401s that look like
   * a broken session.
   */
  it('fetches a fresh token for every request', async () => {
    await getConnection()
    await getConnection()

    expect(getIdToken).toHaveBeenCalledTimes(2)
  })

  it('refuses to call the endpoint at all when nobody is signed in', async () => {
    currentUser.value = null

    await expect(getConnection()).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a network failure as something the user can act on', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(getConnection()).rejects.toThrow(/connection/i)
  })

  it("prefers the server's own message on a failure", async () => {
    fetchMock.mockResolvedValue(response({ error: 'Verify your email address first.' }, 403))

    await expect(getConnection()).rejects.toThrow('Verify your email address first.')
  })

  /*
   * Regression for a duplication that had already diverged: this path used a
   * local copy of the message helper that had lost the 429 case, so a throttled
   * user was told "Something went wrong" instead of to wait.
   */
  it('tells a throttled caller to wait rather than that something went wrong', async () => {
    fetchMock.mockResolvedValue(response({}, 429))

    await expect(getConnection()).rejects.toThrow(/Too many attempts/)
  })
})

describe('startConnect', () => {
  it('POSTs and hands back the URL to navigate to', async () => {
    fetchMock.mockResolvedValue(response({ authorizeUrl: 'https://marketplace.test/auth' }))

    await expect(startConnect()).resolves.toBe('https://marketplace.test/auth')
    expect(lastCall()[1].method).toBe('POST')
    expect(lastCall()[0]).toContain('/api/hl/connect')
  })
})

describe('disconnect', () => {
  it('sends a DELETE to the connection endpoint', async () => {
    fetchMock.mockResolvedValue(response({ ok: true }))

    await disconnect()

    expect(lastCall()[1].method).toBe('DELETE')
    expect(lastCall()[0]).toContain('/api/hl/connection')
  })

  it('surfaces a refusal rather than reporting success', async () => {
    fetchMock.mockResolvedValue(response({ error: 'Sign in and try again.' }, 401))

    await expect(disconnect()).rejects.toThrow('Sign in and try again.')
  })
})
