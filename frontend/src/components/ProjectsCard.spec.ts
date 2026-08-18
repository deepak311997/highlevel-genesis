import { RouterLinkStub, flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { Project } from '@/lib/projectsApi'

/*
 * Plain values, not refs — a Pinia store auto-unwraps its refs on the store
 * object, so the component reads `projects.loading` as a boolean.
 */
const store = vi.hoisted(() => ({
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

/*
 * Handed to the component through `reactive`, so a write *after* mount
 * re-renders. `reactive` caches by target, so every call returns the same
 * proxy and the component's store identity is stable.
 *
 * Writing to `store` directly still works for the setup-then-mount tests below
 * — a proxy reads through to its target — it simply does not trigger. Only a
 * test that changes something while mounted needs `live`.
 */
vi.mock('@/stores/projects', () => ({ useProjectsStore: () => reactive(store) }))

import ProjectsCard from './ProjectsCard.vue'

/**
 * The projects card's four states, all of them shipped: loading, rows, empty,
 * and error-with-retry.
 *
 * The error one is not theoretical — the card's only source of truth is an
 * endpoint, so "we could not ask" is a state it has to be able to say out loud —
 * and it comes **first**, as `AccountCard` orders its branches: a failed first
 * request leaves `loaded` false, so anything testing for "no answer yet" placed
 * ahead of it would swallow the error entirely.
 */

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Contact dashboard',
  description: 'Lists and filters contacts',
  locationId: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

const SECOND: Project = {
  ...PROJECT,
  id: 'proj-2',
  name: 'Calendar sync',
  description: null,
  updatedAt: '2026-08-16T09:00:00.000Z',
}

/* The dialogs are stubbed: each owns the store and has a suite of its own, and
 * both teleport their content out of this component's tree. */
/*
 * The dialogs are stubbed: each owns the store and has a suite of its own, and both
 * teleport their content out of this component's tree. `RouterLink` is stubbed
 * because the project name became one in Slice 4 and there is no router here.
 */
const MOUNT = {
  global: {
    stubs: {
      ProjectFormDialog: true,
      ProjectDeleteDialog: true,
      RouterLink: RouterLinkStub,
    },
  },
}

beforeEach(() => {
  store.projects = []
  store.loading = false
  store.loaded = false
  store.busy = false
  store.error = null
  vi.clearAllMocks()
})

/*
 * Pagination.
 *
 * The server already caps a list at LIST_LIMIT (100), so this is a reading
 * problem rather than a fetching one: a hundred rows in a card is a scroll, not
 * a list you can find anything in. The window is client-side over what is
 * already loaded, which also means paging costs no request and cannot fail.
 *
 * The case that matters is the last one: delete the only project on the last
 * page and the page you are standing on stops existing. Without a clamp the
 * card renders an empty list with rows behind it, which reads as "your projects
 * are gone".
 */
function projectsNamed(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `proj-${index + 1}`,
    name: `Project ${index + 1}`,
    description: null,
    locationId: null,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  }))
}

describe('ProjectsCard', () => {
  it('asks for the list as soon as it mounts', async () => {
    mount(ProjectsCard, MOUNT)
    await flushPromises()

    expect(store.load).toHaveBeenCalledTimes(1)
  })

  /** AC-24. */
  it('shows a loading state and no rows while the first request is in flight', () => {
    store.loading = true

    const wrapper = mount(ProjectsCard, MOUNT)

    expect(wrapper.find('[data-testid="projects-loading"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="project-row"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="projects-empty"]').exists()).toBe(false)
  })

  /*
   * AC-2. The loading state's placeholders are the shared `Skeleton`, not a
   * hand-rolled pulsing div — the testid still resolves to the same
   * element, and what it holds carries the primitive's slot attribute.
   */
  it('renders Skeleton placeholders while loading', () => {
    store.loading = true

    const wrapper = mount(ProjectsCard, MOUNT)

    const loading = wrapper.find('[data-testid="projects-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.findAll('[data-slot="skeleton"]')).toHaveLength(2)
  })

  /*
   * `loading` alone cannot say "no answer yet": it is first-load-only, and it is
   * still false in the tick between mounting and the request starting.
   */
  it('shows the loading state before the first request has started', () => {
    const wrapper = mount(ProjectsCard, MOUNT)

    expect(wrapper.find('[data-testid="projects-loading"]').exists()).toBe(true)
  })

  /** AC-25. */
  it('renders one row per project, with its name, description and updated date', () => {
    store.projects = [PROJECT, SECOND]
    store.loaded = true

    const wrapper = mount(ProjectsCard, MOUNT)
    const rows = wrapper.findAll('[data-testid="project-row"]')

    expect(rows).toHaveLength(2)
    expect(rows[0]?.find('[data-testid="project-name"]').text()).toBe('Contact dashboard')
    expect(rows[0]?.find('[data-testid="project-description"]').text()).toBe(
      'Lists and filters contacts',
    )
    expect(rows[0]?.find('[data-testid="project-updated"]').text()).toBe('Updated 17 Aug 2026')
    expect(rows[1]?.find('[data-testid="project-name"]').text()).toBe('Calendar sync')
  })

  /* A project with no description gets no empty line where one would be. */
  it('omits the description line when there is none', () => {
    store.projects = [SECOND]
    store.loaded = true

    const wrapper = mount(ProjectsCard, MOUNT)

    expect(wrapper.find('[data-testid="project-description"]').exists()).toBe(false)
  })

  /*
   * **Deliberately inverted in Slice 4** (D23). Slice 3's D12 asserted that a row was
   * not navigable at all, because the workspace it would point at did not exist —
   * and said "the moment one becomes a link, Slice 4 has started". It has, so the
   * claim narrows rather than disappears: the *row* is still not a link, and the name
   * inside it now is. Kept as an assertion because it is what stops a later change
   * wrapping the whole rectangle, with Delete inside it.
   */
  it('does not make the row itself a link', () => {
    store.projects = [PROJECT]
    store.loaded = true

    const wrapper = mount(ProjectsCard, MOUNT)

    const row = wrapper.find('[data-testid="project-row"]')
    expect(row.element.tagName).toBe('LI')
    expect(row.attributes('href')).toBeUndefined()
  })

  /** AC-26. */
  it('shows the empty state and a New project button, and no error', () => {
    store.loaded = true

    const wrapper = mount(ProjectsCard, MOUNT)

    expect(wrapper.find('[data-testid="projects-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="projects-new"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="projects-error"]').exists()).toBe(false)
  })

  /** AC-27. */
  it('shows the error with a Retry that re-issues the request', async () => {
    store.error = 'Sign in and try again.'

    const wrapper = mount(ProjectsCard, MOUNT)
    await flushPromises()
    store.load.mockClear()

    expect(wrapper.find('[data-testid="projects-error"]').text()).toContain(
      'Sign in and try again.',
    )
    await wrapper.find('[data-testid="projects-retry"]').trigger('click')

    expect(store.load).toHaveBeenCalledTimes(1)
  })

  /*
   * Error first. A failed first request leaves `loaded` false, so a loading
   * branch placed ahead of it would render a skeleton forever and never show the
   * failure. Same ordering `AccountCard` uses.
   */
  it('shows the error rather than the loading state when both could apply', () => {
    store.error = 'Sign in and try again.'
    store.loading = true

    const wrapper = mount(ProjectsCard, MOUNT)

    expect(wrapper.find('[data-testid="projects-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="projects-loading"]').exists()).toBe(false)
  })

  it('shows the error rather than stale rows', () => {
    store.projects = [PROJECT]
    store.loaded = true
    store.error = 'Sign in and try again.'

    const wrapper = mount(ProjectsCard, MOUNT)

    expect(wrapper.find('[data-testid="projects-error"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="project-row"]')).toHaveLength(0)
  })

  describe('the dialogs it drives', () => {
    it('opens the form with no project from New project', async () => {
      store.loaded = true
      const wrapper = mount(ProjectsCard, MOUNT)

      await wrapper.find('[data-testid="projects-new"]').trigger('click')

      const form = wrapper.findComponent({ name: 'ProjectFormDialog' })
      expect(form.props('open')).toBe(true)
      expect(form.props('project')).toBeNull()
    })

    it('opens the form with the row’s project from Rename', async () => {
      store.projects = [PROJECT, SECOND]
      store.loaded = true
      const wrapper = mount(ProjectsCard, MOUNT)

      await wrapper.findAll('[data-testid="project-rename"]')[1]?.trigger('click')

      const form = wrapper.findComponent({ name: 'ProjectFormDialog' })
      expect(form.props('open')).toBe(true)
      expect(form.props('project')).toEqual(SECOND)
    })

    it('opens the delete confirmation with the row’s project', async () => {
      store.projects = [PROJECT]
      store.loaded = true
      const wrapper = mount(ProjectsCard, MOUNT)

      await wrapper.find('[data-testid="project-delete"]').trigger('click')

      const confirmation = wrapper.findComponent({ name: 'ProjectDeleteDialog' })
      expect(confirmation.props('open')).toBe(true)
      expect(confirmation.props('project')).toEqual(PROJECT)
    })
  })

  /*
   * AC-19, D23. Slice 3's D12 said "the moment one becomes a link, Slice 4 has
   * started" — it has. **The name is the link and the row is not**, so a mis-aimed
   * tap on a row cannot reach Rename or Delete; those two stay buttons, which is the
   * second assertion here and the one that would catch a whole-row link added later.
   */
  it('makes the project name a link to its workspace, leaving the actions as buttons', () => {
    store.loaded = true
    store.projects = [PROJECT, SECOND]

    const wrapper = mount(ProjectsCard, MOUNT)
    const rows = wrapper.findAll('[data-testid="project-row"]')

    const first = rows[0]?.findComponent(RouterLinkStub)
    expect(first?.props('to')).toBe('/projects/proj-1')
    expect(first?.text()).toBe('Contact dashboard')
    expect(rows[1]?.findComponent(RouterLinkStub).props('to')).toBe('/projects/proj-2')

    expect(rows[0]?.find('[data-testid="project-rename"]').element.tagName).toBe('BUTTON')
    expect(rows[0]?.find('[data-testid="project-delete"]').element.tagName).toBe('BUTTON')
  })

  /* Exactly one link per row, and it is the name — nothing else in the row navigates. */
  it('puts no link in a row beyond the name', () => {
    store.loaded = true
    store.projects = [PROJECT]

    const wrapper = mount(ProjectsCard, MOUNT)

    expect(
      wrapper.find('[data-testid="project-row"]').findAllComponents(RouterLinkStub),
    ).toHaveLength(1)
  })

  describe('pagination', () => {
    beforeEach(() => {
      store.loaded = true
      store.error = null
    })

    it('shows one page of rows and says which slice you are on', async () => {
      store.projects = projectsNamed(23)

      const wrapper = mount(ProjectsCard, MOUNT)
      await flushPromises()

      expect(wrapper.findAll('[data-testid="project-row"]')).toHaveLength(8)
      expect(wrapper.find('[data-testid="projects-range"]').text()).toBe('1–8 of 23')
    })

    it('walks forward and back without refetching', async () => {
      store.projects = projectsNamed(23)

      const wrapper = mount(ProjectsCard, MOUNT)
      await flushPromises()
      store.load.mockClear()

      await wrapper.find('[data-testid="projects-next"]').trigger('click')
      expect(wrapper.find('[data-testid="projects-range"]').text()).toBe('9–16 of 23')
      expect(wrapper.findAll('[data-testid="project-name"]')[0]?.text()).toBe('Project 9')

      await wrapper.find('[data-testid="projects-prev"]').trigger('click')
      expect(wrapper.find('[data-testid="projects-range"]').text()).toBe('1–8 of 23')
      expect(store.load).not.toHaveBeenCalled()
    })

    it('stops at both ends', async () => {
      store.projects = projectsNamed(10)

      const wrapper = mount(ProjectsCard, MOUNT)
      await flushPromises()

      expect(wrapper.find('[data-testid="projects-prev"]').attributes('disabled')).toBeDefined()
      await wrapper.find('[data-testid="projects-next"]').trigger('click')
      expect(wrapper.find('[data-testid="projects-range"]').text()).toBe('9–10 of 10')
      expect(wrapper.find('[data-testid="projects-next"]').attributes('disabled')).toBeDefined()
    })

    it('hides the controls when everything fits on one page', async () => {
      store.projects = projectsNamed(5)

      const wrapper = mount(ProjectsCard, MOUNT)
      await flushPromises()

      expect(wrapper.find('[data-testid="projects-pager"]').exists()).toBe(false)
    })

    /* Delete the last project on the last page and that page stops existing. */
    it('falls back a page when the list shrinks under it', async () => {
      store.projects = projectsNamed(9)

      const wrapper = mount(ProjectsCard, MOUNT)
      await flushPromises()
      await wrapper.find('[data-testid="projects-next"]').trigger('click')
      expect(wrapper.find('[data-testid="projects-range"]').text()).toBe('9–9 of 9')

      reactive(store).projects = projectsNamed(8)
      await flushPromises()

      expect(wrapper.find('[data-testid="projects-range"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-testid="project-row"]')).toHaveLength(8)
    })
  })
})
