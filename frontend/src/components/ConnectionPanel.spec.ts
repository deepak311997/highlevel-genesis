import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { ProbeResult, ProbeState, SurfaceProbe } from '@/stores/hl'

/*
 * Plain values, not refs. A Pinia store auto-unwraps its refs on the store
 * object, so a component reads `hl.loading` as a boolean — mocking it as
 * `{ value: false }` makes every check truthy and every branch collapse to the
 * first one. The mock has to have the shape the component actually sees.
 *
 * Annotated rather than asserted field by field, so `probe` keeps the whole
 * union and a typo'd state in a test is a compile error rather than a branch
 * that silently renders nothing.
 */
interface StoreMock {
  status: null
  loading: boolean
  busy: boolean
  error: string | null
  lastError: string | null
  isConnected: boolean
  needsReconnect: boolean
  label: string | null
  probe: ProbeState
  probeResult: ProbeResult | null
  refresh: Mock
  connect: Mock
  disconnect: Mock
  checkDataAccess: Mock
}

const store = vi.hoisted<StoreMock>(() => ({
  status: null,
  loading: false,
  busy: false,
  error: null,
  lastError: null,
  isConnected: false,
  needsReconnect: false,
  label: null,
  probe: 'idle',
  probeResult: null,
  refresh: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  checkDataAccess: vi.fn(),
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
  store.probe = 'idle'
  store.probeResult = null
  vi.clearAllMocks()
}

beforeEach(reset)

/** A surface that answered, unless the case says otherwise. */
function probed(over: Partial<SurfaceProbe> = {}): SurfaceProbe {
  return { count: 1, error: null, reconnect: false, ...over }
}

function result(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    contacts: probed(),
    conversations: probed(),
    calendars: probed(),
    ...over,
  }
}

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

  /*
   * AC-2. The loading state's placeholders are the shared `Skeleton`, not a
   * hand-rolled pulsing div — the testid still resolves to the same
   * element, and what it holds carries the primitive's slot attribute.
   */
  it('renders Skeleton placeholders while loading', () => {
    store.loading = true

    const wrapper = mount(ConnectionPanel)

    const loading = wrapper.find('[data-testid="connection-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.findAll('[data-slot="skeleton"]')).toHaveLength(2)
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

/**
 * The Data access section.
 *
 * It lives inside the connected branch, so "not connected" needs no guard of its
 * own — and the probe is on demand, never on mount, because three HighLevel
 * calls per dashboard visit spend a rate-limit budget to answer a question
 * nobody asked (D30).
 */
describe('ConnectionPanel — data access', () => {
  it('offers Check data access when connected, and issues nothing on mount', async () => {
    store.isConnected = true

    const wrapper = mount(ConnectionPanel)
    await flushPromises()

    expect(wrapper.find('[data-testid="data-access"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="data-access-check"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="data-access-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="data-access-row-contacts"]').exists()).toBe(false)
    expect(store.checkDataAccess).not.toHaveBeenCalled()
  })

  it('runs the probe when Check data access is pressed', async () => {
    store.isConnected = true

    const wrapper = mount(ConnectionPanel)
    await wrapper.find('[data-testid="data-access-check"]').trigger('click')

    expect(store.checkDataAccess).toHaveBeenCalledTimes(1)
  })

  it('shows a loading state and disables the button while the probe runs', () => {
    store.isConnected = true
    store.probe = 'loading'

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="data-access-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="data-access-check"]').attributes('disabled')).toBeDefined()
  })

  /* AC-2, the probe's own placeholders — one per surface, so three. */
  it('renders Skeleton placeholders while the probe runs', () => {
    store.isConnected = true
    store.probe = 'loading'

    const wrapper = mount(ConnectionPanel)

    const loading = wrapper.find('[data-testid="data-access-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.findAll('[data-slot="skeleton"]')).toHaveLength(3)
  })

  it('renders one row per surface with its count', () => {
    store.isConnected = true
    store.probe = 'ready'
    store.probeResult = result({
      contacts: probed({ count: 20 }),
      conversations: probed({ count: 5 }),
      calendars: probed({ count: 3 }),
    })

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="data-access-row-contacts"]').text()).toContain('Contacts')
    expect(wrapper.find('[data-testid="data-access-row-contacts"]').text()).toContain('20')
    expect(wrapper.find('[data-testid="data-access-row-conversations"]').text()).toContain(
      'Conversations',
    )
    expect(wrapper.find('[data-testid="data-access-row-conversations"]').text()).toContain('5')
    expect(wrapper.find('[data-testid="data-access-row-calendars"]').text()).toContain('Calendars')
    expect(wrapper.find('[data-testid="data-access-row-calendars"]').text()).toContain('3')
    expect(wrapper.find('[data-testid="data-access-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="data-access-loading"]').exists()).toBe(false)
  })

  /*
   * Zero is falsy, and a `v-if="row.count"` would render the "we could not read
   * a number" branch for a location that genuinely has no contacts yet. That
   * mistake is the whole reason this case exists.
   */
  it('renders an empty state for a surface that answered zero', () => {
    store.isConnected = true
    store.probe = 'ready'
    store.probeResult = result({ contacts: probed({ count: 0 }) })

    const wrapper = mount(ConnectionPanel)
    const row = wrapper.find('[data-testid="data-access-row-contacts"]')

    expect(row.text()).toContain('None yet')
    expect(row.text()).not.toContain('—')
    expect(wrapper.find('[data-testid="data-access-error"]').exists()).toBe(false)
  })

  it('renders an em dash for a surface with no usable count', () => {
    store.isConnected = true
    store.probe = 'ready'
    store.probeResult = result({ contacts: probed({ count: null }) })

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="data-access-row-contacts"]').text()).toContain('—')
  })

  it('offers Reconnect HighLevel when a surface needs one, and calls connect once', async () => {
    store.isConnected = true
    store.probe = 'ready'
    store.probeResult = result({
      contacts: probed({ count: null, error: 'Reconnect HighLevel to continue.', reconnect: true }),
    })

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="data-access-error"]').text()).toContain(
      'Reconnect HighLevel to continue.',
    )
    const button = wrapper.find('[data-testid="data-access-reconnect"]')
    expect(button.exists()).toBe(true)
    // Distinct from the panel's own Connect button, which is not on this screen.
    expect(wrapper.find('[data-testid="connection-connect"]').exists()).toBe(false)

    await button.trigger('click')

    expect(store.connect).toHaveBeenCalledTimes(1)
  })

  it('shows an error state when every surface failed', () => {
    store.isConnected = true
    store.probe = 'error'
    store.probeResult = result({
      contacts: probed({ count: null, error: 'Could not reach HighLevel.' }),
      conversations: probed({ count: null, error: 'Could not reach HighLevel.' }),
      calendars: probed({ count: null, error: 'Could not reach HighLevel.' }),
    })

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="data-access-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="data-access-reconnect"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="data-access-row-contacts"]').text()).toContain(
      'Could not reach HighLevel.',
    )
  })

  /*
   * AC-17, at the level the user sees it. The store composes upstream's own
   * words onto the message; the row's job is to render the whole sentence
   * rather than truncating it back to the shrug.
   */
  it('renders the composed failure in the row', () => {
    store.isConnected = true
    store.probe = 'ready'
    store.probeResult = result({
      contacts: probed({ count: null, error: 'Could not read contacts. (Invalid JWT)' }),
    })

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="data-access-row-contacts"]').text()).toContain(
      'Could not read contacts. (Invalid JWT)',
    )
  })

  /*
   * AC-18. `h4` because `CardTitle` is the card's `h3` and `DashboardView` owns
   * the `h1` — a styled `<p>` looks like a heading and is not one, which is
   * exactly what a screen-reader heading list is for.
   */
  it('titles the section with a heading', () => {
    store.isConnected = true

    const wrapper = mount(ConnectionPanel)
    const heading = wrapper.findAll('h4').find((el) => el.text() === 'Data access')

    expect(heading).toBeDefined()
  })

  /*
   * AC-18, E14. The live region has to exist *before* the counts land — a
   * wrapper that only appears once there is a result was never being observed,
   * so nothing is ever announced.
   */
  it.each([
    ['idle', 'idle', null],
    ['loading', 'loading', null],
    ['ready', 'ready', result()],
    ['error', 'error', result({ contacts: probed({ count: null, error: 'Nope.' }) })],
  ] as const)('announces its results politely — %s', (_name, probe, probeResult) => {
    store.isConnected = true
    store.probe = probe
    store.probeResult = probeResult

    const wrapper = mount(ConnectionPanel)
    const region = wrapper.find('[data-testid="data-access-results"]')

    expect(region.exists()).toBe(true)
    expect(region.attributes('aria-live')).toBe('polite')
  })

  /*
   * AC-19, E13. Keyed off the probe state rather than off `probeResult`, which
   * is null both before the first check and during every one after it — so a
   * button keyed off the result says "Check data access" again mid-probe.
   */
  it.each([
    ['idle', 'idle', 'Check data access'],
    ['loading', 'loading', 'Checking…'],
    ['ready', 'ready', 'Check again'],
    ['error', 'error', 'Check again'],
  ] as const)('labels the check button off the probe state — %s', (_name, probe, label) => {
    store.isConnected = true
    store.probe = probe
    store.probeResult = probe === 'ready' || probe === 'error' ? result() : null

    const wrapper = mount(ConnectionPanel)
    const button = wrapper.find('[data-testid="data-access-check"]')

    expect(button.text()).toBe(label)
    expect(button.attributes('disabled') === undefined).toBe(probe !== 'loading')
  })

  it('renders nothing at all when the user is not connected', () => {
    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="data-access"]').exists()).toBe(false)
  })

  /*
   * A connection that needs reconnecting has its own panel state with its own
   * button; probing it would only produce three copies of the same 409.
   */
  it('keeps the reconnect-required panel on its own screen', () => {
    store.isConnected = true
    store.needsReconnect = true

    const wrapper = mount(ConnectionPanel)

    expect(wrapper.find('[data-testid="connection-needs-reconnect"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="data-access"]').exists()).toBe(false)
  })
})
