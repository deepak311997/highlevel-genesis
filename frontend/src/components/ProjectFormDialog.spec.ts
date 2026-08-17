import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Plain values, not refs. A Pinia store auto-unwraps its refs on the store
 * object, so a component reads `projects.busy` as a boolean — mocking it as
 * `{ value: false }` makes every check truthy. Same shape `ConnectionPanel.spec`
 * uses.
 */
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

import ProjectFormDialog from './ProjectFormDialog.vue'

/**
 * One dialog for create and for rename (D25).
 *
 * The two differ only in their title, their submit label and whether the fields
 * start populated. Two components would be one component and a copy of it, and
 * the copy is where the changed-fields-only rule stops holding on one of the two
 * paths.
 *
 * The dialog's content is teleported to `document.body` by Reka UI's portal, so
 * everything below queries the document rather than the wrapper.
 */

const PROJECT = {
  id: 'proj-1',
  name: 'Contact dashboard',
  description: 'Lists and filters contacts',
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

async function open(
  props: Record<string, unknown> = {},
): Promise<VueWrapper<InstanceType<typeof ProjectFormDialog>>> {
  const wrapper = mount(ProjectFormDialog, {
    props: { open: true, ...props },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  store.busy = false
  vi.clearAllMocks()
  store.create.mockResolvedValue(undefined)
  store.rename.mockResolvedValue(undefined)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('creating', () => {
  /** AC-29. */
  it('starts empty, with submit disabled', async () => {
    await open()

    expect(must('project-form-dialog').exists()).toBe(true)
    expect((must('project-form-name').element as HTMLInputElement).value).toBe('')
    expect((must('project-form-description').element as HTMLTextAreaElement).value).toBe('')
    expect(must('project-form-submit').attributes('disabled')).toBeDefined()
  })

  /* Whitespace is not a name; the server trims and then refuses a blank one. */
  it('keeps submit disabled for a whitespace-only name', async () => {
    await open()

    await must('project-form-name').setValue('   ')

    expect(must('project-form-submit').attributes('disabled')).toBeDefined()
  })

  it('enables submit once a name is entered, and creates on submit', async () => {
    const wrapper = await open()

    await must('project-form-name').setValue('Contact dashboard')
    await must('project-form-description').setValue('Lists and filters contacts')
    expect(must('project-form-submit').attributes('disabled')).toBeUndefined()

    await must('project-form-submit').trigger('click')
    await flushPromises()

    expect(store.create).toHaveBeenCalledWith({
      name: 'Contact dashboard',
      description: 'Lists and filters contacts',
    })
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  /* An empty description is `null`, not `''` — the stored field is nullable and
   * an empty string would render as a blank line under the name. */
  it('sends a null description when the field is left empty', async () => {
    await open()

    await must('project-form-name').setValue('Contact dashboard')
    await must('project-form-submit').trigger('click')
    await flushPromises()

    expect(store.create).toHaveBeenCalledWith({
      name: 'Contact dashboard',
      description: null,
    })
  })

  /*
   * AC-30. The dialog stays open, shows the server's message, and keeps what was
   * typed — a create refused for a name that is one character too long must not
   * also cost the user their description.
   */
  it('stays open with the server’s message and the entered values when create fails', async () => {
    store.create.mockRejectedValue(new Error('You have reached the limit of 100 projects.'))
    const wrapper = await open()

    await must('project-form-name').setValue('Contact dashboard')
    await must('project-form-description').setValue('Lists contacts')
    await must('project-form-submit').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('update:open')).toBeUndefined()
    expect(must('project-form-error').text()).toContain('limit of 100 projects')
    expect((must('project-form-name').element as HTMLInputElement).value).toBe('Contact dashboard')
    expect((must('project-form-description').element as HTMLTextAreaElement).value).toBe(
      'Lists contacts',
    )
  })

  it('closes without calling anything when cancelled', async () => {
    const wrapper = await open()

    await must('project-form-name').setValue('Contact dashboard')
    await must('project-form-cancel').trigger('click')

    expect(store.create).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('disables submit while a mutation is in flight', async () => {
    store.busy = true
    await open()

    await must('project-form-name').setValue('Contact dashboard')

    expect(must('project-form-submit').attributes('disabled')).toBeDefined()
  })
})

describe('renaming', () => {
  /** AC-31. */
  it('pre-fills from the project and says Rename', async () => {
    await open({ project: PROJECT })

    expect((must('project-form-name').element as HTMLInputElement).value).toBe('Contact dashboard')
    expect((must('project-form-description').element as HTMLTextAreaElement).value).toBe(
      'Lists and filters contacts',
    )
    expect(must('project-form-dialog').text()).toContain('Rename')
    expect(must('project-form-submit').text()).toBe('Save')
  })

  /*
   * Only the changed fields. Resending the description on a rename would make
   * every rename a full overwrite of a field the user never touched.
   */
  it('sends only the name when only the name changed', async () => {
    const wrapper = await open({ project: PROJECT })

    await must('project-form-name').setValue('Contacts')
    await must('project-form-submit').trigger('click')
    await flushPromises()

    expect(store.rename).toHaveBeenCalledWith('proj-1', { name: 'Contacts' })
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('sends only the description when only the description changed', async () => {
    await open({ project: PROJECT })

    await must('project-form-description').setValue('Just contacts')
    await must('project-form-submit').trigger('click')
    await flushPromises()

    expect(store.rename).toHaveBeenCalledWith('proj-1', { description: 'Just contacts' })
  })

  it('sends an explicit null when the description is cleared', async () => {
    await open({ project: PROJECT })

    await must('project-form-description').setValue('')
    await must('project-form-submit').trigger('click')
    await flushPromises()

    expect(store.rename).toHaveBeenCalledWith('proj-1', { description: null })
  })

  /*
   * With nothing changed the payload would be `{}`, which the server refuses
   * with 400 `invalid_body`. Disabling submit means the UI never issues that
   * request — the refusal is the boundary's job, not the user's problem.
   */
  it('disables submit when nothing has changed', async () => {
    await open({ project: PROJECT })

    expect(must('project-form-submit').attributes('disabled')).toBeDefined()
  })

  it('keeps the dialog open and shows the message when rename fails', async () => {
    store.rename.mockRejectedValue(new Error('That project no longer exists.'))
    const wrapper = await open({ project: PROJECT })

    await must('project-form-name').setValue('Contacts')
    await must('project-form-submit').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('update:open')).toBeUndefined()
    expect(must('project-form-error').text()).toContain('no longer exists')
  })
})

/*
 * Re-seeded on open, so reopening the dialog does not show the last edit. The
 * component is kept alive by its parent between openings — it is the parent's
 * `formOpen` ref that changes, not the component's existence.
 */
describe('reopening', () => {
  it('re-seeds the fields from the project each time it opens', async () => {
    const wrapper = mount(ProjectFormDialog, {
      props: { open: true, project: PROJECT },
      attachTo: document.body,
    })
    await flushPromises()

    await must('project-form-name').setValue('Half-typed edit')
    await wrapper.setProps({ open: false })
    await flushPromises()
    await wrapper.setProps({ open: true })
    await flushPromises()

    expect((must('project-form-name').element as HTMLInputElement).value).toBe('Contact dashboard')
  })

  it('clears a previous error when it reopens', async () => {
    store.create.mockRejectedValue(new Error('Check the details and try again.'))
    const wrapper = mount(ProjectFormDialog, { props: { open: true }, attachTo: document.body })
    await flushPromises()

    await must('project-form-name').setValue('A')
    await must('project-form-submit').trigger('click')
    await flushPromises()
    expect(el('project-form-error')).not.toBeNull()

    await wrapper.setProps({ open: false })
    await flushPromises()
    await wrapper.setProps({ open: true })
    await flushPromises()

    expect(el('project-form-error')).toBeNull()
  })
})
