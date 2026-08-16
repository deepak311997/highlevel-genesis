import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ensureProfile = vi.hoisted(() => vi.fn())

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ email: 'alice@example.test', ensureProfile }),
}))

import DashboardView from './DashboardView.vue'

/*
 * The connection panel is stubbed. It owns a Pinia store and an endpoint call,
 * and it has fifteen tests of its own — mounting it here would make this file
 * fail for reasons that have nothing to do with the dashboard.
 */
const MOUNT = { global: { stubs: { ConnectionPanel: true } } }

beforeEach(() => {
  vi.clearAllMocks()
  ensureProfile.mockResolvedValue(undefined)
})

describe('DashboardView', () => {
  it('shows who is signed in', () => {
    const wrapper = mount(DashboardView, MOUNT)

    expect(wrapper.find('[data-testid="dashboard-email"]').text()).toBe('alice@example.test')
  })

  it('ships an empty state, since there is nothing to list yet', () => {
    const wrapper = mount(DashboardView, MOUNT)

    expect(wrapper.find('[data-testid="dashboard-empty"]').exists()).toBe(true)
  })

  // Idempotent, so an interrupted sign-up heals on the next visit.
  it('writes the profile for the session', async () => {
    mount(DashboardView, MOUNT)
    await flushPromises()

    expect(ensureProfile).toHaveBeenCalled()
  })

  it('still renders when the profile write fails', async () => {
    ensureProfile.mockRejectedValue(new Error('permission-denied'))
    const wrapper = mount(DashboardView, MOUNT)
    await flushPromises()

    expect(wrapper.find('[data-testid="dashboard-email"]').exists()).toBe(true)
  })
})
