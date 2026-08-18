import { RouterLinkStub, flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ensure = vi.hoisted(() => vi.fn())

vi.mock('@/stores/profile', () => ({
  useProfileStore: () => ({ profile: null, loading: false, loaded: false, error: null, ensure }),
}))

/*
 * Plain values, not refs — a Pinia store auto-unwraps its refs on the store
 * object. Mocked here rather than only in `ProjectsCard.spec` because AC-28 is
 * about the *dashboard* when the card's request has failed, which needs the real
 * card mounted inside the real view.
 */
const projects = vi.hoisted(() => ({
  projects: [] as unknown[],
  loading: false,
  loaded: false,
  busy: false,
  error: null as string | null,
  load: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@/stores/projects', () => ({ useProjectsStore: () => projects }))

import DashboardView from './DashboardView.vue'

/*
 * All three cards are stubbed. Each owns a Pinia store and an endpoint call and
 * has a suite of its own; mounting them here would make this file fail for
 * reasons that have nothing to do with the dashboard.
 */
const MOUNT = {
  global: { stubs: { ConnectionPanel: true, AccountCard: true, ProjectsCard: true } },
}

beforeEach(() => {
  vi.clearAllMocks()
  ensure.mockResolvedValue(undefined)
  projects.projects = []
  projects.loading = false
  projects.loaded = false
  projects.error = null
})

describe('DashboardView', () => {
  it('renders the account card', () => {
    const wrapper = mount(DashboardView, MOUNT)

    expect(wrapper.findComponent({ name: 'AccountCard' }).exists()).toBe(true)
  })

  it('renders the projects card', () => {
    const wrapper = mount(DashboardView, MOUNT)

    expect(wrapper.findComponent({ name: 'ProjectsCard' }).exists()).toBe(true)
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
    expect(wrapper.findComponent({ name: 'ProjectsCard' }).exists()).toBe(true)
  })

  /*
   * AC-28, and the one case the stub above cannot express: the projects card is
   * mounted for real, and its list request has failed.
   *
   * Every other test of the failure renders the card in isolation, where a card
   * that threw on its error path would fail only its own suite. Here it would
   * take the whole view down and the account card and connection panel with it —
   * which is precisely the claim AC-28 makes. The sign-out control lives in
   * `App.vue` rather than this view, and the e2e covers it.
   */
  it('keeps the rest of the dashboard when the project list has failed', async () => {
    projects.error = 'Could not load your projects.'

    const wrapper = mount(DashboardView, {
      // `RouterLink` is stubbed because the real card mounted here now renders one
      // per project name (Slice 4, D23), and this test provides no router.
      global: {
        stubs: { ConnectionPanel: true, AccountCard: true, RouterLink: RouterLinkStub },
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="projects-error"]').text()).toContain(
      'Could not load your projects.',
    )
    expect(wrapper.findComponent({ name: 'AccountCard' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'ConnectionPanel' }).exists()).toBe(true)
  })

  /*
   * The rail is ordered by how often you look at it: who you are signed in as
   * first, then the HighLevel connection under it. Asserted on DOM order rather
   * than on presence, because "both are rendered" is the one thing a reordering
   * cannot break.
   */
  it('puts the account above the HighLevel connection in the rail', () => {
    const html = mount(DashboardView, MOUNT).html()

    expect(html.indexOf('account-card')).toBeLessThan(html.indexOf('connection-panel'))
  })
})
