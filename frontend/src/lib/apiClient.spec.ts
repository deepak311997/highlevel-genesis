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

const { request } = await import('./apiClient')
const { ApiError } = await import('./api')

/**
 * The one authenticated fetch, shared by every typed client above it.
 *
 * It exists as its own module because the alternative had already gone wrong
 * once: the same logic lived privately inside two clients, the copies diverged,
 * and the one that had lost its 429 case told a throttled user "something went
 * wrong" instead of to wait. Header assembly is the part worth testing — an ID
 * token read once and cached starts failing silently on a tab left open past its
 * hourly rotation, and a missing App Check header turns a working mutation into
 * a 401.
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
  fetchMock = vi.fn().mockResolvedValue(response({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request', () => {
  it('sends the ID token as a Bearer header', async () => {
    await request('/api/anything')

    expect((lastCall()[1].headers as Record<string, string>)['Authorization']).toBe(
      'Bearer id-token-1',
    )
  })

  it('sends the App Check header', async () => {
    await request('/api/anything')

    expect((lastCall()[1].headers as Record<string, string>)['X-Firebase-AppCheck']).toBe(
      'app-check-token',
    )
  })

  /* Rotated roughly hourly; a cached one turns an open tab into a run of 401s. */
  it('reads a fresh token for every request', async () => {
    await request('/api/anything')
    await request('/api/anything')

    expect(getIdToken).toHaveBeenCalledTimes(2)
  })

  it("keeps the caller's own headers alongside the two it adds", async () => {
    await request('/api/anything', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    })
    const headers = lastCall()[1].headers as Record<string, string>

    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Authorization']).toBe('Bearer id-token-1')
    expect(lastCall()[1].method).toBe('PUT')
  })

  it('throws before fetching when nobody is signed in', async () => {
    currentUser.value = null

    await expect(request('/api/anything')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a network failure to status 0 with copy the user can act on', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(request('/api/anything')).rejects.toMatchObject({
      status: 0,
      message: expect.stringMatching(/connection/i) as unknown as string,
    })
  })

  it("prefers the server's own message on a failure", async () => {
    fetchMock.mockResolvedValue(response({ error: 'Verify your email address first.' }, 403))

    await expect(request('/api/anything')).rejects.toThrow('Verify your email address first.')
  })

  it('tells a throttled caller to wait rather than that something went wrong', async () => {
    fetchMock.mockResolvedValue(response({}, 429))

    await expect(request('/api/anything')).rejects.toThrow(/Too many attempts/)
  })

  it('returns the parsed body on success', async () => {
    fetchMock.mockResolvedValue(response({ profile: null }))

    await expect(request('/api/users/me')).resolves.toEqual({ profile: null })
  })
})
