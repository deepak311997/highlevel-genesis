import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import HealthView from './HealthView.vue'

function mockFetchOnce(impl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl))
}

const payload = {
  ok: true,
  docId: 'abc123',
  writeMs: 12,
  readMs: 8,
  roundTripMs: 20,
  serverTime: '2026-08-14T12:00:00.000Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HealthView', () => {
  it('shows the loading state before the request settles', () => {
    mockFetchOnce(() => new Promise<Response>(() => {}))
    const wrapper = mount(HealthView)

    expect(wrapper.find('[data-testid="health-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="health-ok"]').exists()).toBe(false)
  })

  it('renders the timings once the check succeeds', async () => {
    mockFetchOnce(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const wrapper = mount(HealthView)
    await flushPromises()

    const ok = wrapper.find('[data-testid="health-ok"]')
    expect(ok.exists()).toBe(true)
    expect(ok.text()).toContain('20 ms')
    expect(ok.text()).toContain('12 ms')
  })

  it('surfaces an actionable message when the function is unreachable', async () => {
    mockFetchOnce(async () => new Response('nope', { status: 500 }))
    const wrapper = mount(HealthView)
    await flushPromises()

    const error = wrapper.find('[data-testid="health-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('500')
    expect(error.text()).toContain('npm run emulators')
  })
})
