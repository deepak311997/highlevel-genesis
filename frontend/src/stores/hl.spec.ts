import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getConnection = vi.hoisted(() => vi.fn())
const startConnect = vi.hoisted(() => vi.fn())
const disconnectRequest = vi.hoisted(() => vi.fn())
const hlProxy = vi.hoisted(() => vi.fn())

vi.mock('@/lib/hlApi', () => ({
  getConnection,
  startConnect,
  disconnect: disconnectRequest,
}))

vi.mock('@/lib/hlProxyApi', () => ({ hlProxy }))

const { useHlStore } = await import('./hl')
const { ApiError } = await import('@/lib/api')

/**
 * The connection store.
 *
 * Its whole job is turning one endpoint into the six states the panel renders,
 * so the interesting behaviour is what happens when that endpoint misbehaves —
 * and what the panel is told in the meantime. The panel's own tests mock this
 * store away, which is why it needs covering here rather than through them.
 */

const CONNECTED = {
  connected: true,
  locationId: 'lUanVn0CtZJTlymH8ySo',
  locationName: 'India Square',
  connectedAt: '2026-08-16T10:00:00.000Z',
  needsReconnect: false,
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getConnection.mockResolvedValue({ connected: false })
  startConnect.mockResolvedValue('https://marketplace.test/authorize')
  disconnectRequest.mockResolvedValue(undefined)
  hlProxy.mockResolvedValue({ total: 0, calendars: [] })
})

describe('refresh', () => {
  it('shows loading for the first load only, so a refresh does not blank the panel', async () => {
    const hl = useHlStore()

    const first = hl.refresh()
    expect(hl.loading).toBe(true)
    await first
    expect(hl.loading).toBe(false)

    const second = hl.refresh()
    expect(hl.loading).toBe(false)
    await second
  })

  it('surfaces a failure as a message the panel can render', async () => {
    getConnection.mockRejectedValue(new Error('Could not load the connection status.'))
    const hl = useHlStore()

    await hl.refresh()

    expect(hl.error).toBe('Could not load the connection status.')
    expect(hl.isConnected).toBe(false)
  })

  it('clears a previous error once the request succeeds', async () => {
    getConnection.mockRejectedValueOnce(new Error('boom'))
    const hl = useHlStore()
    await hl.refresh()
    expect(hl.error).toBe('boom')

    getConnection.mockResolvedValue(CONNECTED)
    await hl.refresh()

    expect(hl.error).toBeNull()
    expect(hl.isConnected).toBe(true)
  })

  it('reports a connection that needs reconnecting', async () => {
    getConnection.mockResolvedValue({ ...CONNECTED, needsReconnect: true })
    const hl = useHlStore()

    await hl.refresh()

    expect(hl.needsReconnect).toBe(true)
  })
})

describe('label', () => {
  it('prefers the location name', async () => {
    getConnection.mockResolvedValue(CONNECTED)
    const hl = useHlStore()
    await hl.refresh()

    expect(hl.label).toBe('India Square')
  })

  /*
   * `locations.readonly` is not guaranteed and the name lookup is best effort,
   * so a connection can legitimately arrive without one. Showing the id beats
   * showing nothing, and it is still enough to tell two locations apart.
   */
  it('falls back to the location id when the name lookup had failed', async () => {
    getConnection.mockResolvedValue({ ...CONNECTED, locationName: null })
    const hl = useHlStore()
    await hl.refresh()

    expect(hl.label).toBe('lUanVn0CtZJTlymH8ySo')
  })

  it('is null while not connected, so the panel has nothing to render', async () => {
    const hl = useHlStore()
    await hl.refresh()

    expect(hl.label).toBeNull()
  })
})

describe('connect', () => {
  it('navigates to the URL the server minted', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    const hl = useHlStore()

    await hl.connect()

    expect(assign).toHaveBeenCalledWith('https://marketplace.test/authorize')
    vi.unstubAllGlobals()
  })

  /*
   * `busy` deliberately stays true on success: the browser is navigating away,
   * and re-enabling the button in that window lets a second click mint a second
   * state and start a second flow.
   */
  it('leaves the button disabled while the browser navigates away', async () => {
    vi.stubGlobal('location', { assign: vi.fn() })
    const hl = useHlStore()

    await hl.connect()

    expect(hl.busy).toBe(true)
    vi.unstubAllGlobals()
  })

  it('re-enables the button when the request fails, so the user can retry', async () => {
    startConnect.mockRejectedValue(new Error('Could not start the connection.'))
    const hl = useHlStore()

    await hl.connect()

    expect(hl.busy).toBe(false)
    expect(hl.error).toBe('Could not start the connection.')
  })

  it('clears a stale callback error when a new attempt starts', async () => {
    vi.stubGlobal('location', { assign: vi.fn() })
    const hl = useHlStore()
    hl.noteCallbackError('denied')

    await hl.connect()

    expect(hl.lastError).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('disconnect', () => {
  it('reports not connected without waiting for another round trip', async () => {
    getConnection.mockResolvedValue(CONNECTED)
    const hl = useHlStore()
    await hl.refresh()

    await hl.disconnect()

    expect(hl.isConnected).toBe(false)
    expect(hl.label).toBeNull()
    expect(hl.busy).toBe(false)
  })

  it('keeps the connection on screen when the request fails', async () => {
    getConnection.mockResolvedValue(CONNECTED)
    disconnectRequest.mockRejectedValue(new Error('Could not disconnect.'))
    const hl = useHlStore()
    await hl.refresh()

    await hl.disconnect()

    expect(hl.error).toBe('Could not disconnect.')
    // Still connected as far as we know — claiming otherwise would be a lie the
    // next refresh contradicts.
    expect(hl.isConnected).toBe(true)
    expect(hl.busy).toBe(false)
  })

  it('clears a callback error, since the user has moved on', async () => {
    const hl = useHlStore()
    hl.noteCallbackError('exchange_failed')

    await hl.disconnect()

    expect(hl.lastError).toBeNull()
  })
})

describe('noteCallbackError', () => {
  it('holds the code for the panel to turn into copy', () => {
    const hl = useHlStore()

    hl.noteCallbackError('wrong_account_type')

    expect(hl.lastError).toBe('wrong_account_type')
  })
})

/**
 * The data-access probe.
 *
 * One call per HighLevel surface, on demand (D30, D31). The behaviour worth
 * covering is what happens when *some* of it works: three surfaces is three
 * independent outcomes, and a store that collapsed them into one would blank
 * two working counts because a third failed.
 */
describe('checkDataAccess', () => {
  const CONTACTS = { contacts: [{ id: 'a' }], total: 20 }
  const CONVERSATIONS = { conversations: [{ id: 'b' }], total: 5 }
  const CALENDARS = { calendars: [{ id: 'c' }, { id: 'd' }, { id: 'e' }] }

  function answerEachSurface(): void {
    hlProxy.mockImplementation((_method: string, path: string) => {
      if (path === '/contacts/search') return Promise.resolve(CONTACTS)
      if (path === '/conversations/search') return Promise.resolve(CONVERSATIONS)
      return Promise.resolve(CALENDARS)
    })
  }

  it('starts idle, with nothing fetched', () => {
    const hl = useHlStore()

    expect(hl.probe).toBe('idle')
    expect(hl.probeResult).toBeNull()
    expect(hlProxy).not.toHaveBeenCalled()
  })

  // AC-40 — all three succeed.
  it('holds a count per surface when all three succeed', async () => {
    answerEachSurface()
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probe).toBe('ready')
    expect(hl.probeResult?.contacts.count).toBe(20)
    expect(hl.probeResult?.conversations.count).toBe(5)
    expect(hl.probeResult?.calendars.count).toBe(3)
  })

  it('shows loading while the calls are in flight', async () => {
    answerEachSurface()
    const hl = useHlStore()

    const pending = hl.checkDataAccess()
    expect(hl.probe).toBe('loading')
    await pending
  })

  // D31 — exactly these three, and no more.
  it('issues exactly the three probe calls', async () => {
    answerEachSurface()
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hlProxy.mock.calls).toEqual([
      ['POST', '/contacts/search', { pageLimit: 1 }],
      ['GET', '/conversations/search', { limit: 1 }],
      ['GET', '/calendars/'],
    ])
  })

  /*
   * AC-40's second half. One failure is a row-level outcome, not a
   * section-level one: blanking two working counts because a third surface is
   * unavailable throws away the answer the user actually asked for.
   */
  it('keeps the other two counts when one surface fails', async () => {
    hlProxy.mockImplementation((_method: string, path: string) => {
      if (path === '/conversations/search') {
        return Promise.reject(new ApiError('HighLevel refused that request for this account.', 403))
      }
      if (path === '/contacts/search') return Promise.resolve(CONTACTS)
      return Promise.resolve(CALENDARS)
    })
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probe).toBe('ready')
    expect(hl.probeResult?.contacts.count).toBe(20)
    expect(hl.probeResult?.calendars.count).toBe(3)
    expect(hl.probeResult?.conversations.count).toBeNull()
    expect(hl.probeResult?.conversations.error).toBe(
      'HighLevel refused that request for this account.',
    )
  })

  it('is an error state only when every surface failed', async () => {
    hlProxy.mockRejectedValue(new ApiError('HighLevel is not responding. Try again.', 502))
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probe).toBe('error')
    expect(hl.probeResult?.contacts.error).toBe('HighLevel is not responding. Try again.')
  })

  /*
   * AC-41. `total` is HighLevel's field and this slice forwards their body
   * verbatim, so a shape change upstream must render as "—" rather than as
   * `NaN` in a panel nobody can debug from.
   */
  it.each([
    ['a missing total', {}],
    ['a non-numeric total', { total: 'lots' }],
    ['a null total', { total: null }],
    ['an infinite total', { total: Number.POSITIVE_INFINITY }],
  ])('reads %s as no count rather than NaN', async (_name, body) => {
    hlProxy.mockResolvedValue(body)
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probeResult?.contacts.count).toBeNull()
    expect(hl.probeResult?.contacts.error).toBeNull()
  })

  it('reads a missing calendars array as no count', async () => {
    hlProxy.mockResolvedValue({})
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probeResult?.calendars.count).toBeNull()
  })

  it('reports an honest zero as a count, not as an absence', async () => {
    hlProxy.mockResolvedValue({ total: 0, calendars: [] })
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probeResult?.contacts.count).toBe(0)
    expect(hl.probeResult?.calendars.count).toBe(0)
  })

  /*
   * P11. The PRD's failure table gives 409 exactly two meanings —
   * `hl_reconnect_required` and `hl_not_connected` — and both are answered by
   * the same button, so the status is enough and no error code has to be
   * threaded through `ApiError` for this slice.
   */
  it('flags a 409 as needing a reconnect', async () => {
    hlProxy.mockRejectedValue(new ApiError('Your HighLevel connection expired.', 409))
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probeResult?.contacts.reconnect).toBe(true)
  })

  it('does not flag any other failure as needing a reconnect', async () => {
    hlProxy.mockRejectedValue(new ApiError('HighLevel rejected that request.', 400))
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probeResult?.contacts.reconnect).toBe(false)
  })

  it('describes a non-ApiError failure in words the panel can render', async () => {
    hlProxy.mockRejectedValue('a string, thrown')
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probeResult?.contacts.error).toMatch(/\w/)
  })

  // AC-42 — a probe belongs to one account, like everything else here.
  it('clears the probe on reset', async () => {
    answerEachSurface()
    const hl = useHlStore()
    await hl.checkDataAccess()

    hl.reset()

    expect(hl.probe).toBe('idle')
    expect(hl.probeResult).toBeNull()
  })

  /*
   * The PRD's edge case — "the user signs out while a probe is in flight" —
   * and the half `reset()` alone cannot deliver.
   *
   * Signing out is a route change rather than a page load, so Pinia survives it
   * (`auth.ts`'s `signOutNow` exists for exactly that reason). Three proxy
   * calls left in flight resolve *after* `reset()` has run, and a store that
   * writes them unconditionally puts the previous account's contact,
   * conversation and calendar counts into the panel the next person to sign in
   * on this browser sees — with `probe` at `ready`, so nothing ever clears it,
   * because they never ran a probe of their own.
   *
   * `workspace.ts` already carries the answer and says so in as many words: a
   * generation counter that `reset()` bumps, so a request in flight when the
   * session ends cannot repopulate the store afterwards.
   */
  it('drops a probe that lands after the session ended', async () => {
    let release = (): void => {}
    const held = new Promise<unknown>((resolve) => {
      release = () => {
        resolve(CONTACTS)
      }
    })
    hlProxy.mockReturnValue(held)
    const hl = useHlStore()

    const pending = hl.checkDataAccess()
    hl.reset()
    release()
    await pending

    expect(hl.probe).toBe('idle')
    expect(hl.probeResult).toBeNull()
  })

  it('still records a probe the session did not interrupt', async () => {
    answerEachSurface()
    const hl = useHlStore()

    await hl.checkDataAccess()

    expect(hl.probe).toBe('ready')
    expect(hl.probeResult?.contacts.count).toBe(20)
  })
})
