import { createPinia, setActivePinia } from 'pinia'
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

const { useProfileStore } = await import('./profile')

/**
 * The profile, as far as the browser can see it.
 *
 * Deliberately **not** mocked at the client boundary: `fetch` is what is stubbed, so AC-22 —
 * "the outgoing request is `PUT /api/profile` carrying an Authorization and an App Check header"
 * — is asserted against the request that would actually go on the wire, rather than against a
 * call to a function that is assumed to build one.
 */

const PROFILE = {
  email: 'alice@example.test',
  displayName: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

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
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getIdToken.mockResolvedValue('id-token-1')
  currentUser.value = { getIdToken }
  fetchMock = vi.fn().mockResolvedValue(response({ profile: PROFILE }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensure', () => {
  /** AC-22. */
  it('issues PUT /api/profile carrying both headers', async () => {
    await useProfileStore().ensure()
    const [url, init] = lastCall()
    const headers = init.headers as Record<string, string>

    expect(url).toContain('/api/profile')
    expect(init.method).toBe('PUT')
    expect(headers['Authorization']).toBe('Bearer id-token-1')
    expect(headers['X-Firebase-AppCheck']).toBe('app-check-token')
  })

  it('stores the profile it gets back and marks the store loaded', async () => {
    const store = useProfileStore()

    await store.ensure()

    expect(store.profile).toEqual(PROFILE)
    expect(store.loaded).toBe(true)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  /*
   * D17: a failed profile fetch is a card that says so, never a blocked session.
   * The message is the server's, because that is the one that names the cause.
   */
  it("records the server's message and clears loading on a failure", async () => {
    fetchMock.mockResolvedValue(response({ error: 'Verify your email address first.' }, 403))
    const store = useProfileStore()

    await store.ensure()

    expect(store.error).toBe('Verify your email address first.')
    expect(store.loading).toBe(false)
    expect(store.profile).toBeNull()
  })

  it('clears a previous error on a retry that succeeds', async () => {
    fetchMock.mockResolvedValue(response({}, 500))
    const store = useProfileStore()
    await store.ensure()
    expect(store.error).not.toBeNull()

    fetchMock.mockResolvedValue(response({ profile: PROFILE }))
    await store.ensure()

    expect(store.error).toBeNull()
    expect(store.profile).toEqual(PROFILE)
  })

  /* First load only, so a refetch does not blank a card that already has content. */
  it('shows loading for the first request and not for a later one', async () => {
    const store = useProfileStore()

    const first = store.ensure()
    expect(store.loading).toBe(true)
    await first

    const second = store.ensure()
    expect(store.loading).toBe(false)
    await second
  })
})

describe('load', () => {
  it('GETs the profile', async () => {
    await useProfileStore().load()

    expect(lastCall()[0]).toContain('/api/profile')
    expect(lastCall()[1].method).toBeUndefined()
  })

  /*
   * AC-19's producer. `loaded` with a null profile is what tells the card the
   * difference between "not fetched yet" and "fetched, and there is nothing" —
   * two states that look identical if only `profile` is consulted.
   */
  it('leaves profile null and sets loaded when the server says there is none', async () => {
    fetchMock.mockResolvedValue(response({ profile: null }))
    const store = useProfileStore()

    await store.load()

    expect(store.profile).toBeNull()
    expect(store.loaded).toBe(true)
    expect(store.error).toBeNull()
  })
})
