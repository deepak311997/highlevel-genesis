import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ensure = vi.hoisted(() => vi.fn())

vi.mock('@/stores/profile', () => ({
  useProfileStore: () => ({ profile: null, loading: false, loaded: false, error: null, ensure }),
}))

import DashboardView from './DashboardView.vue'

/*
 * Both cards are stubbed. Each owns a Pinia store and an endpoint call and has a
 * suite of its own; mounting them here would make this file fail for reasons
 * that have nothing to do with the dashboard.
 */
const MOUNT = { global: { stubs: { ConnectionPanel: true, AccountCard: true } } }

beforeEach(() => {
  vi.clearAllMocks()
  ensure.mockResolvedValue(undefined)
})

describe('DashboardView', () => {
  it('renders the account card', () => {
    const wrapper = mount(DashboardView, MOUNT)

    expect(wrapper.findComponent({ name: 'AccountCard' }).exists()).toBe(true)
  })

  it('ships an empty state, since there is nothing to list yet', () => {
    const wrapper = mount(DashboardView, MOUNT)

    expect(wrapper.find('[data-testid="dashboard-empty"]').exists()).toBe(true)
  })

  // Idempotent, so a sign-up interrupted before the profile existed heals here.
  it('ensures the profile on mount', async () => {
    mount(DashboardView, MOUNT)
    await flushPromises()

    expect(ensure).toHaveBeenCalled()
  })

  /*
   * AC-21, and D17. A profile is a convenience, not a precondition for a
   * session: when the request fails, the failure belongs to the account card and
   * nowhere else. The rest of the dashboard keeps working, and the sign-out
   * control — which lives in App.vue, not here, and is covered by the e2e — is
   * unaffected for the same reason.
   */
  it('still renders the connection panel and the projects card when the profile fails', async () => {
    ensure.mockRejectedValue(new Error('Something went wrong.'))
    const wrapper = mount(DashboardView, MOUNT)
    await flushPromises()

    expect(wrapper.findComponent({ name: 'ConnectionPanel' }).exists()).toBe(true)
    expect(wrapper.find('[data-testid="dashboard-empty"]').exists()).toBe(true)
  })
})
