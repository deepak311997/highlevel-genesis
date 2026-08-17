import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  projects: [] as unknown[],
  loading: false,
  loaded: true,
  busy: false,
  error: null as string | null,
  load: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@/stores/projects', () => ({ useProjectsStore: () => store }))

import ProjectDeleteDialog from './ProjectDeleteDialog.vue'
import type { Project } from '@/lib/projectsApi'

/**
 * The delete confirmation.
 *
 * It **names the project**, which is the whole reason it exists: a generic "are
 * you sure?" beside a list of rows is a dialog the user has to trust they
 * clicked the right thing to reach.
 *
 * Content is teleported to `document.body` by Reka UI's portal, so this queries
 * the document rather than the wrapper — same as `ProjectFormDialog.spec.ts`.
 */

const PROJECT = {
  id: 'proj-1',
  name: 'Contact dashboard',
  description: null,
  locationId: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

function el(testid: string): DOMWrapper<Element> | null {
  const found = document.body.querySelector(`[data-testid="${testid}"]`)
  return found === null ? null : new DOMWrapper(found)
}

function must(testid: string): DOMWrapper<Element> {
  const found = el(testid)
  if (found === null) throw new Error(`no element with data-testid="${testid}"`)
  return found
}

async function open(project: Project | null = PROJECT) {
  const wrapper = mount(ProjectDeleteDialog, {
    props: { open: true, project },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  store.busy = false
  vi.clearAllMocks()
  store.remove.mockResolvedValue(undefined)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ProjectDeleteDialog', () => {
  /** AC-32. */
  it('names the project it is about to delete', async () => {
    await open()

    expect(must('project-delete-dialog').exists()).toBe(true)
    expect(must('project-delete-name').text()).toBe('Contact dashboard')
  })

  it('removes the project and closes on confirm', async () => {
    const wrapper = await open()

    await must('project-delete-confirm').trigger('click')
    await flushPromises()

    expect(store.remove).toHaveBeenCalledWith('proj-1')
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('issues no request when cancelled', async () => {
    const wrapper = await open()

    await must('project-delete-cancel').trigger('click')

    expect(store.remove).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  /*
   * The failure belongs here rather than in the card: the user asked for this
   * from inside the dialog, so the answer goes back where the question was.
   */
  it('stays open with the message when the delete fails', async () => {
    store.remove.mockRejectedValue(new Error('Sign in and try again.'))
    const wrapper = await open()

    await must('project-delete-confirm').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('update:open')).toBeUndefined()
    expect(must('project-delete-error').text()).toContain('Sign in and try again.')
  })

  /* A second click would issue a second DELETE — harmless, since the route is
   * idempotent, but the button should still say the work is in progress. */
  it('disables confirm while a mutation is in flight', async () => {
    store.busy = true
    await open()

    expect(must('project-delete-confirm').attributes('disabled')).toBeDefined()
  })

  /*
   * The parent nulls its selection as the dialog closes, so this component sees
   * `project: null` for at least one render. It must not throw, and it must not
   * offer to delete nothing.
   */
  it('renders nothing to confirm when there is no project', async () => {
    await open(null)

    expect(el('project-delete-dialog')).toBeNull()
  })
})
