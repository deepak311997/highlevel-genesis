import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Plain values, not refs. A Pinia store auto-unwraps its refs on the store
 * object, so a component reads `hl.loading` as a boolean — mocking it as
 * `{ value: false }` makes every check truthy and every branch collapse to the
 * first one. The mock has to have the shape the component actually sees.
 */
const store = vi.hoisted(() => ({
  status: null,
  loading: false,
  busy: false,
  error: null as string | null,
  lastError: null as string | null,
  isConnected: false,
  needsReconnect: false,
  label: null as string | null,
  refresh: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock('@/stores/hl', () => ({ useHlStore: () => store }))

import ConnectionPanel from './ConnectionPanel.vue'

/**
 * The connection panel's states.
 *
 * The definition of done requires loading, empty and error states for every new
 * screen; this one has six, because its only source of truth is an endpoint and
 * "we could not ask" is therefore a real state rather than a theoretical one.
 */

function reset(): void {
  store.loading = false
  store.busy = false
  store.error = null
  store.lastError = null
  store.isConnected = false
  store.needsReconnect = false
  store.label = null
  vi.clearAllMocks()
}

beforeEach(reset)

describe('ConnectionPanel', () => {
  it('asks for the status as soon as it mounts', async () => {
    mount(ConnectionPanel)
    await flushPromises()

    expect(store.refresh).toHaveBeenCalledTimes(1)
  })

  it('shows a loading state while the first request is in flight', () => {
    store.loading = true

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connection-connect"]').exists()).toBe(false)
  })

  it('shows the empty state with a Connect button when not connected', () => {
    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connection-connect"]').exists()).toBe(true)
  })

  it('shows the location name once connected, and offers Disconnect', () => {
    store.isConnected = true
    store.label = 'India Square'

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-location"]').text()).toBe('India Square')
    expect(wrapper.find('[data-testid="connection-disconnect"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connection-connect"]').exists()).toBe(false)
  })

  /*
   * The `locations.readonly` scope is not guaranteed, and the name lookup is
   * best effort. A connection that works with a worse label is not a failure,
   * so the panel shows the id rather than an empty space or an error.
   */
  it('falls back to the location id when there is no name', () => {
    store.isConnected = true
    store.label = 'lUanVn0CtZJTlymH8ySo'

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-location"]').text()).toBe('lUanVn0CtZJTlymH8ySo')
  })

  it('prompts to reconnect when the connection was definitively rejected', () => {
    store.isConnected = true
    store.needsReconnect = true

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-needs-reconnect"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connection-connect"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connection-disconnect"]').exists()).toBe(false)
  })

  it('shows an error with a working Retry when the status request fails', async () => {
    store.error = 'Could not load the connection status.'

    const wrapper = mount(ConnectionPanel)
    await flushPromises()
    store.refresh.mockClear()

    await wrapper.find('[data-testid="connection-retry"]').trigger('click')

    expect(wrapper.find('[data-testid="connection-error"]').exists()).toBe(true)
    expect(store.refresh).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['denied', 'cancelled'],
    ['invalid_state', 'expired'],
    ['exchange_failed', "Couldn't complete"],
    ['wrong_account_type', 'sub-account'],
  ])('renders copy specific to the %s outcome', (code, fragment) => {
    store.lastError = code

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-callback-error"]').text()).toContain(fragment)
  })

  /*
   * A code the server added and the client has not learned yet must still say
   * something a person can act on, rather than rendering an empty alert.
   */
  it('falls back to a generic message for an unrecognised outcome', () => {
    store.lastError = 'something_new_from_the_server'

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-callback-error"]').text()).toContain(
      "Couldn't complete the connection",
    )
  })

  /*
   * Connect navigates away. A second click before the browser leaves would mint
   * a second state and start a second flow.
   */
  it('disables Connect while a request is in flight', () => {
    store.busy = true

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-connect"]').attributes('disabled')).toBeDefined()
  })

  it('disables Disconnect while a request is in flight', () => {
    store.isConnected = true
    store.busy = true

    const wrapper = mount(ConnectionPanel)

    expect(
      wrapper.find('[data-testid="connection-disconnect"]').attributes('disabled'),
    ).toBeDefined()
  })

  it('calls connect and disconnect from their buttons', async () => {
    const notConnected = mount(ConnectionPanel)
    await notConnected.find('[data-testid="connection-connect"]').trigger('click')
    expect(store.connect).toHaveBeenCalledTimes(1)

    store.isConnected = true
    const connected = mount(ConnectionPanel)
    await connected.find('[data-testid="connection-disconnect"]').trigger('click')
    expect(store.disconnect).toHaveBeenCalledTimes(1)
  })
})
