import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@/stores/projects', () => ({ useProjectsStore: () => store }))

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
const MOUNT = { global: { stubs: { ProjectFormDialog: true, ProjectDeleteDialog: true } } }

beforeEach(() => {
  store.projects = []
  store.loading = false
  store.loaded = false
  store.busy = false
  store.error = null
  vi.clearAllMocks()
})

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

  /* D12: rows are not navigable in this slice, because the workspace screen they
   * would point at does not exist yet. */
  it('does not make a row a link', () => {
    store.projects = [PROJECT]
    store.loaded = true

    const wrapper = mount(ProjectsCard, MOUNT)

    expect(wrapper.find('[data-testid="project-row"] a').exists()).toBe(false)
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
})
