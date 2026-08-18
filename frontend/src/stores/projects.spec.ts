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

const { useProjectsStore } = await import('./projects')

/**
 * The project list, as far as the browser can see it.
 *
 * Deliberately **not** mocked at the client boundary: `fetch` is what is stubbed, so AC-33 —
 * "every request carries an Authorization and an App Check header" — is asserted against the
 * request that would actually go on the wire.
 */

const PROJECT = {
  id: 'proj-1',
  name: 'Contact dashboard',
  description: null,
  locationId: null,
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

/** Every request the store made, as `METHOD path` — order included. */
function requests(): string[] {
  return fetchMock.mock.calls.map((call) => {
    const init = (call[1] ?? {}) as RequestInit
    return `${init.method ?? 'GET'} ${new URL(String(call[0]), 'http://test.local').pathname}`
  })
}

function headersOf(index = 0): Record<string, string> {
  const init = (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit
  return init.headers as Record<string, string>
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getIdToken.mockResolvedValue('id-token-1')
  currentUser.value = { getIdToken }
  fetchMock = vi.fn().mockResolvedValue(response({ projects: [PROJECT] }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('load', () => {
  /** AC-33. */
  it('issues GET /api/projects carrying both headers', async () => {
    await useProjectsStore().load()

    expect(requests()).toEqual(['GET /api/projects'])
    expect(headersOf()['Authorization']).toBe('Bearer id-token-1')
    expect(headersOf()['X-Firebase-AppCheck']).toBe('app-check-token')
  })

  it('fills the list, marks the store loaded, and clears loading', async () => {
    const store = useProjectsStore()

    await store.load()

    expect(store.projects).toEqual([PROJECT])
    expect(store.loaded).toBe(true)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  /* The card's error state renders this message, so it is the server's. */
  it("records the server's message and leaves the list alone on a failure", async () => {
    const store = useProjectsStore()
    await store.load()

    fetchMock.mockResolvedValue(response({ error: 'Sign in and try again.' }, 401))
    await store.load()

    expect(store.error).toBe('Sign in and try again.')
    expect(store.projects).toEqual([PROJECT])
    expect(store.loading).toBe(false)
  })

  it('clears a previous error on a retry that succeeds', async () => {
    fetchMock.mockResolvedValue(response({}, 500))
    const store = useProjectsStore()
    await store.load()
    expect(store.error).not.toBeNull()

    fetchMock.mockResolvedValue(response({ projects: [] }))
    await store.load()

    expect(store.error).toBeNull()
    expect(store.projects).toEqual([])
  })

  /* First load only, so a refetch does not blank a card that already has rows. */
  it('shows loading for the first request and not for a later one', async () => {
    const store = useProjectsStore()

    const first = store.load()
    expect(store.loading).toBe(true)
    await first

    const second = store.load()
    expect(store.loading).toBe(false)
    await second
  })
})

/*
 * Each mutation is followed by a `GET`, in that order — D14's liveness rule, and `CLAUDE.md`'s:
 * a refetch after a mutation, never `onSnapshot`.
 */
describe.each([
  ['create', 'POST', () => useProjectsStore().create({ name: 'Contact dashboard' })],
  ['rename', 'PATCH', () => useProjectsStore().rename('proj-1', { name: 'Contacts' })],
  ['remove', 'DELETE', () => useProjectsStore().remove('proj-1')],
])('%s', (label, method, call) => {
  const path = method === 'POST' ? '/api/projects' : '/api/projects/proj-1'

  beforeEach(() => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT, ok: true }))
    fetchMock.mockResolvedValue(response({ projects: [PROJECT] }))
  })

  it(`issues the ${method} and then refetches the list`, async () => {
    await call()

    expect(requests()).toEqual([`${method} ${path}`, 'GET /api/projects'])
  })

  it('carries both headers on the mutation', async () => {
    await call()

    expect(headersOf()['Authorization']).toBe('Bearer id-token-1')
    expect(headersOf()['X-Firebase-AppCheck']).toBe('app-check-token')
  })

  /*
   * A failed mutation rethrows and never touches `error`: `error` belongs to the list request
   * and is what the *card* renders, while a failed create belongs inside the dialog that issued
   * it.
   */
  it('rejects without refetching and without setting error, when the mutation fails', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(response({ error: 'Check the details and try again.' }, 400))
    const store = useProjectsStore()

    await expect(call()).rejects.toThrow('Check the details and try again.')

    expect(requests()).toEqual([`${method} ${path}`])
    expect(store.error).toBeNull()
  })

  it('clears busy afterwards, whether it succeeded or failed', async () => {
    const store = useProjectsStore()
    await call()
    expect(store.busy).toBe(false)

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(response({ error: 'Nope.' }, 400))
    await expect(call()).rejects.toThrow('Nope.')
    expect(store.busy).toBe(false)
  })

  it(`is busy while the ${label} is in flight`, async () => {
    const store = useProjectsStore()

    const pending = call()
    expect(store.busy).toBe(true)
    await pending
  })
})

describe('reset', () => {
  /*
   * A project list belongs to one account, and signing out is a route change rather than a page
   * load — so without this the next person to sign in on the same browser sees the last one's
   * projects until their own load lands.
   */
  it('empties everything', async () => {
    const store = useProjectsStore()
    await store.load()

    store.reset()

    expect(store.projects).toEqual([])
    expect(store.loaded).toBe(false)
    expect(store.loading).toBe(false)
    expect(store.busy).toBe(false)
    expect(store.error).toBeNull()
  })
})
