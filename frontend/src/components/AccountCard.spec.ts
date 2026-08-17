import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ensure = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({
  value: {
    profile: null as Record<string, unknown> | null,
    loading: false,
    loaded: false,
    error: null as string | null,
  },
}))

vi.mock('@/stores/profile', () => ({
  useProfileStore: () => ({ ...state.value, ensure }),
}))

import AccountCard from './AccountCard.vue'

/**
 * The account card — the only place the profile is visible, and the reason this
 * slice is a vertical one rather than a refactor.
 *
 * Four states, and all four ship: loading, loaded, empty and error-with-retry.
 * The last two are the ones that get skipped, and both are ordinary here — a
 * user sits in the empty state between verifying and their first ensure, and the
 * card's only source of truth is an endpoint, so "we could not ask" is real.
 */

const PROFILE = {
  email: 'alice@example.test',
  displayName: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

function mountWith(overrides: Partial<(typeof state)['value']>) {
  state.value = { profile: null, loading: false, loaded: false, error: null, ...overrides }
  return mount(AccountCard)
}

beforeEach(() => {
  vi.clearAllMocks()
  ensure.mockResolvedValue(undefined)
})

describe('AccountCard', () => {
  /** AC-17. */
  it('shows the loading state and no address while the request is in flight', () => {
    const wrapper = mountWith({ loading: true })

    expect(wrapper.find('[data-testid="account-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="dashboard-email"]').exists()).toBe(false)
  })

  /** AC-18. */
  it('shows the display name when there is one', () => {
    const wrapper = mountWith({ profile: { ...PROFILE, displayName: 'Alice' }, loaded: true })

    expect(wrapper.find('[data-testid="account-name"]').text()).toBe('Alice')
  })

  it('falls back to the address when there is no display name', () => {
    const wrapper = mountWith({ profile: PROFILE, loaded: true })

    expect(wrapper.find('[data-testid="account-name"]').text()).toBe('alice@example.test')
  })

  /* The e2e suite reads this id, and it is the assertion that the address now
   * comes from the API rather than from a Firestore read. */
  it('puts the address in dashboard-email', () => {
    const wrapper = mountWith({ profile: PROFILE, loaded: true })

    expect(wrapper.find('[data-testid="dashboard-email"]').text()).toBe('alice@example.test')
  })

  /*
   * Formatted with an explicit locale and time zone. Left unpinned, this
   * assertion would depend on whichever machine CI happened to run on.
   */
  it('renders a member-since date from createdAt', () => {
    const wrapper = mountWith({ profile: PROFILE, loaded: true })

    expect(wrapper.find('[data-testid="account-member-since"]').text()).toContain('17 Aug 2026')
  })

  /** AC-19. */
  it('shows the empty state and no error when there is no profile yet', () => {
    const wrapper = mountWith({ profile: null, loaded: true })

    expect(wrapper.find('[data-testid="account-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="account-error"]').exists()).toBe(false)
  })

  /*
   * AC-19's other half, and what makes the case above load-bearing.
   *
   * "We asked and there is nothing yet" and "we have not asked" both have a null
   * profile, and only `loaded` tells them apart. A card that branches on the
   * profile alone shows "Setting up your profile…" to anyone rendering it before
   * a request has started — which is every mount, for the tick between this
   * component's own `onMounted` and its parent's.
   */
  it('shows the loading state, not the empty one, before anything has been fetched', () => {
    const wrapper = mountWith({ profile: null, loaded: false })

    expect(wrapper.find('[data-testid="account-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="account-empty"]').exists()).toBe(false)
  })

  /** AC-20. */
  it("shows the server's message with a Retry button on a failure", () => {
    const wrapper = mountWith({ error: 'Verify your email address first.', loaded: true })

    expect(wrapper.find('[data-testid="account-error"]').text()).toContain(
      'Verify your email address first.',
    )
    expect(wrapper.find('[data-testid="account-retry"]').exists()).toBe(true)
  })

  it('re-issues the request when Retry is clicked', async () => {
    const wrapper = mountWith({ error: 'Something went wrong.', loaded: true })

    await wrapper.find('[data-testid="account-retry"]').trigger('click')

    expect(ensure).toHaveBeenCalled()
  })

  /* An error wins over stale content: showing a profile beside a failure notice
   * leaves the user unable to tell which of the two is current. */
  it('prefers the error over a previously loaded profile', () => {
    const wrapper = mountWith({ profile: PROFILE, error: 'Could not reach the server.' })

    expect(wrapper.find('[data-testid="account-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="dashboard-email"]').exists()).toBe(false)
  })
})
