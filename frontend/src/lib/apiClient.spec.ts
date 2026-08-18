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

const { authHeaders, registerSessionExpiredHook, request } = await import('./apiClient')
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
  // The latch and the hook are module state; without this a case that fired the
  // hook would decide the result of the next one (R4).
  registerSessionExpiredHook(null)
  getIdToken.mockResolvedValue('id-token-1')
  currentUser.value = { getIdToken }
  fetchMock = vi.fn().mockResolvedValue(response({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  registerSessionExpiredHook(null)
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

    await expect(request('/api/profile')).resolves.toEqual({ profile: null })
  })
})

/**
 * The session-expiry hook (AC-10, AC-13, AC-14, AC-15).
 *
 * The branch is on `code`, not on `status`, because a 401 is two unrelated
 * conditions: `unauthenticated` means the session is dead, and
 * `app_check_failed` means the *page* could not be attested and reloading fixes
 * it. Signing a user out for the second destroys a perfectly good session and
 * loses whatever is in their editor buffers.
 */
describe('the session-expiry hook', () => {
  it('invokes the session hook for a 401 unauthenticated, and still throws', async () => {
    const hook = vi.fn()
    registerSessionExpiredHook(hook)
    fetchMock.mockResolvedValue(
      response({ error: 'Sign in and try again.', code: 'unauthenticated' }, 401),
    )

    await expect(request('/api/anything')).rejects.toBeInstanceOf(ApiError)
    expect(hook).toHaveBeenCalledTimes(1)
  })

  /* AC-13, D8. The page failed attestation; the session is fine. */
  it('leaves app_check_failed alone', async () => {
    const hook = vi.fn()
    registerSessionExpiredHook(hook)
    fetchMock.mockResolvedValue(
      response(
        {
          error: 'Request could not be verified. Reload the page and try again.',
          code: 'app_check_failed',
        },
        401,
      ),
    )

    await expect(request('/api/anything')).rejects.toThrow(
      'Request could not be verified. Reload the page and try again.',
    )
    expect(hook).not.toHaveBeenCalled()
  })

  /* AC-14. Signed in, just not verified — signing them out helps nobody. */
  it('leaves a 403 email_unverified alone', async () => {
    const hook = vi.fn()
    registerSessionExpiredHook(hook)
    fetchMock.mockResolvedValue(
      response({ error: 'Verify your email address first.', code: 'email_unverified' }, 403),
    )

    await expect(request('/api/anything')).rejects.toThrow('Verify your email address first.')
    expect(hook).not.toHaveBeenCalled()
  })

  /* AC-15. A screen that loads three panels 401s three times, and the user must
   * be signed out once — not sent through three navigations. */
  it('fires once for three concurrent 401s', async () => {
    const hook = vi.fn()
    registerSessionExpiredHook(hook)
    fetchMock.mockResolvedValue(
      response({ error: 'Sign in and try again.', code: 'unauthenticated' }, 401),
    )

    await Promise.allSettled([request('/api/one'), request('/api/two'), request('/api/three')])

    expect(hook).toHaveBeenCalledTimes(1)
  })

  /* A call that succeeded proves the session is alive, so the next death is a
   * new one rather than the same one already reported. */
  it('fires again after a call that succeeded', async () => {
    const hook = vi.fn()
    registerSessionExpiredHook(hook)
    const dead = response({ error: 'Sign in and try again.', code: 'unauthenticated' }, 401)

    fetchMock.mockResolvedValue(dead)
    await expect(request('/api/anything')).rejects.toThrow()

    fetchMock.mockResolvedValue(response({ ok: true }))
    await request('/api/anything')

    fetchMock.mockResolvedValue(dead)
    await expect(request('/api/anything')).rejects.toThrow()

    expect(hook).toHaveBeenCalledTimes(2)
  })

  /* R4. Nothing is registered until main.ts runs, and every unit test above
   * calls through this module without one. */
  it('does nothing when no hook is registered', async () => {
    fetchMock.mockResolvedValue(
      response({ error: 'Sign in and try again.', code: 'unauthenticated' }, 401),
    )

    await expect(request('/api/anything')).rejects.toMatchObject({ status: 401 })
  })

  /*
   * `authHeaders` throws its own 401 when nobody is signed in, and a server can
   * answer 401 with no envelope at all. Neither says the session died — one is
   * the app noticing there never was one.
   */
  it('ignores a 401 with no code', async () => {
    const hook = vi.fn()
    registerSessionExpiredHook(hook)

    fetchMock.mockResolvedValue(response({ error: 'Sign in and try again.' }, 401))
    await expect(request('/api/anything')).rejects.toThrow()

    currentUser.value = null
    await expect(request('/api/anything')).rejects.toThrow()

    expect(hook).not.toHaveBeenCalled()
  })
})

/**
 * The credential minting, shared rather than repeated (D32).
 *
 * A streaming call cannot use `request` — it must not read the body as JSON —
 * so the choice was to share this or to write it twice. `apiClient` exists
 * *because* the same logic once lived privately inside two typed clients and the
 * copies diverged; adding a third copy for `generateApi` would be repeating the
 * exact mistake this module was extracted to fix.
 */
describe('authHeaders', () => {
  it('returns both headers that authenticate a call', async () => {
    await expect(authHeaders()).resolves.toEqual({
      Authorization: 'Bearer id-token-1',
      'X-Firebase-AppCheck': 'app-check-token',
    })
  })

  /* Rotated roughly hourly, so a cached one turns an open tab into 401s. */
  it('reads a fresh ID token each time', async () => {
    await authHeaders()
    await authHeaders()

    expect(getIdToken).toHaveBeenCalledTimes(2)
  })

  it('rejects with a 401 ApiError when nobody is signed in', async () => {
    currentUser.value = null

    await expect(authHeaders()).rejects.toBeInstanceOf(ApiError)
    await expect(authHeaders()).rejects.toMatchObject({ status: 401 })
  })

  /* One implementation, so `request` and the stream opener cannot drift. */
  it('is what request sends', async () => {
    await request('/api/anything')

    expect(lastCall()[1].headers).toMatchObject(await authHeaders())
  })
})
