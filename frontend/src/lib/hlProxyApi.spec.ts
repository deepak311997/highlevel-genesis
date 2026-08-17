import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getIdToken = vi.hoisted(() => vi.fn())
const currentUser = vi.hoisted(() => ({
  value: null as { getIdToken: () => Promise<string> } | null,
}))

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

const { hlProxy } = await import('./hlProxyApi')
const { ApiError } = await import('./api')

/**
 * The browser's half of the proxy.
 *
 * Thin on purpose: the argument order is `HIGHLEVEL_PLATFORM.md` §8's `hl()`
 * convention, so the string Slice 9 teaches the model, the string Slice 10's
 * shim receives and the string in the URL are all the same string. Anything
 * clever here — a per-surface method, a re-shaped response — would be a
 * translation table with nothing on the other side of it.
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
  fetchMock = vi.fn().mockResolvedValue(response({ contacts: [], total: 0 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hlProxy', () => {
  // AC-38, the write half.
  it('POSTs a JSON body to the proxy path', async () => {
    await hlProxy('POST', '/contacts/search', { pageLimit: 1 })
    const [url, init] = lastCall()

    expect(url).toBe('/api/hl/proxy/contacts/search')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ pageLimit: 1 }))
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('carries the ID token and the App Check header', async () => {
    await hlProxy('POST', '/contacts/search', { pageLimit: 1 })
    const headers = lastCall()[1].headers as Record<string, string>

    expect(headers['Authorization']).toBe('Bearer id-token-1')
    expect(headers['X-Firebase-AppCheck']).toBe('app-check-token')
  })

  // AC-38, the read half.
  it('GETs with no body at all', async () => {
    await hlProxy('GET', '/calendars/')
    const [url, init] = lastCall()

    expect(url).toBe('/api/hl/proxy/calendars/')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })

  it('turns a GET payload into a query string', async () => {
    await hlProxy('GET', '/conversations/search', { limit: 1 })

    expect(lastCall()[0]).toBe('/api/hl/proxy/conversations/search?limit=1')
    expect(lastCall()[1].body).toBeUndefined()
  })

  it('omits the query string entirely for an empty GET payload', async () => {
    await hlProxy('GET', '/calendars/', {})

    expect(lastCall()[0]).toBe('/api/hl/proxy/calendars/')
  })

  it('returns the body HighLevel sent, unwrapped', async () => {
    fetchMock.mockResolvedValue(response({ contacts: [{ id: 'a' }], total: 20 }))

    await expect(hlProxy('POST', '/contacts/search', { pageLimit: 1 })).resolves.toEqual({
      contacts: [{ id: 'a' }],
      total: 20,
    })
  })

  /*
   * AC-39. The status travels with the message because the panel keys its
   * Reconnect button on 409 — the PRD's failure table gives that status exactly
   * two meanings and both are answered by the same button (P11).
   */
  it("rejects with an ApiError carrying the server's message and status", async () => {
    fetchMock.mockResolvedValue(
      response({ error: 'Your HighLevel connection expired.', code: 'hl_reconnect_required' }, 409),
    )

    await expect(hlProxy('GET', '/calendars/')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Your HighLevel connection expired.',
      status: 409,
    })
  })

  it('refuses to call the proxy at all when nobody is signed in', async () => {
    currentUser.value = null

    await expect(hlProxy('GET', '/calendars/')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a network failure as something the user can act on', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(hlProxy('GET', '/calendars/')).rejects.toThrow(/connection/i)
  })
})
