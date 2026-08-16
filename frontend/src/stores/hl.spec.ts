import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getConnection = vi.hoisted(() => vi.fn())
const startConnect = vi.hoisted(() => vi.fn())
const disconnectRequest = vi.hoisted(() => vi.fn())

vi.mock('@/lib/hlApi', () => ({
  getConnection,
  startConnect,
  disconnect: disconnectRequest,
}))

const { useHlStore } = await import('./hl')

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
