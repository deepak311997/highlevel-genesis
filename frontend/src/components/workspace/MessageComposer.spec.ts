import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Plain values, not refs — a Pinia store auto-unwraps its refs on the store
 * object, so the component reads `workspace.sending` as a boolean.
 *
 * `draft` is a plain property here for the same reason, which makes the
 * two-way binding assertable: writing into the textarea has to land on the
 * *store*, because that is the whole of D17.
 */
const store = vi.hoisted(() => ({
  draft: '',
  sending: false,
  sendError: null as string | null,
  atLimit: false,
  canSend: false,
  send: vi.fn(),
}))

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

import MessageComposer from './MessageComposer.vue'

/**
 * The composer — a textarea, Enter-to-send, and the three states that stop it.
 *
 * Every case here is about *not* sending, which is where the bugs are. A blank
 * draft, a whitespace-only draft, a send already in flight and a project at its
 * message cap all have to disable submit; Shift+Enter has to insert a newline
 * rather than send, because a multi-line prompt is the normal case for this
 * product; and a failed send has to leave the text exactly where the user left it.
 *
 * The draft is read from and written to the **store**, not local state (D17, R8):
 * the `lg` breakpoint swaps one component tree for another, so a draft held here
 * would be eaten by a window resize.
 */

const INPUT = '[data-testid="composer-input"]'
const SUBMIT = '[data-testid="composer-submit"]'

beforeEach(() => {
  store.draft = ''
  store.sending = false
  store.sendError = null
  store.atLimit = false
  store.canSend = false
  vi.clearAllMocks()
})

describe('MessageComposer', () => {
  it('renders the draft from the store', () => {
    store.draft = 'build a contact dashboard'

    const wrapper = mount(MessageComposer)

    expect(wrapper.find<HTMLTextAreaElement>(INPUT).element.value).toBe('build a contact dashboard')
  })

  /* D17's other direction: typing lands on the store, not on component state. */
  it('writes what is typed back to the store', async () => {
    const wrapper = mount(MessageComposer)

    await wrapper.find(INPUT).setValue('half a sentence')

    expect(store.draft).toBe('half a sentence')
  })

  /** AC-31's first half. */
  it.each([
    ['an empty draft', ''],
    ['a whitespace-only draft', '   '],
  ])('disables submit and sends nothing on Enter for %s', async (_label, draft) => {
    store.draft = draft
    store.canSend = false

    const wrapper = mount(MessageComposer)
    await wrapper.find(INPUT).trigger('keydown', { key: 'Enter' })

    expect(wrapper.find(SUBMIT).attributes('disabled')).toBeDefined()
    expect(store.send).not.toHaveBeenCalled()
  })

  /** AC-31's second half. */
  it('sends exactly once when Enter is pressed on a non-empty draft', async () => {
    store.draft = 'build a contact dashboard'
    store.canSend = true

    const wrapper = mount(MessageComposer)
    await wrapper.find(INPUT).trigger('keydown', { key: 'Enter' })

    expect(store.send).toHaveBeenCalledTimes(1)
  })

  it('sends when the button is clicked', async () => {
    store.draft = 'build a contact dashboard'
    store.canSend = true

    const wrapper = mount(MessageComposer)
    await wrapper.find(SUBMIT).trigger('click')

    expect(store.send).toHaveBeenCalledTimes(1)
  })

  /*
   * AC-33. Shift+Enter is a newline, and the draft is untouched — "build a contact
   * dashboard with search and a list of upcoming appointments" is not a
   * single-line prompt, and losing a paragraph to a stray Enter is the failure this
   * prevents.
   */
  it('does not send on Shift+Enter, and does not clear the draft', async () => {
    store.draft = 'first line'
    store.canSend = true

    const wrapper = mount(MessageComposer)
    await wrapper.find(INPUT).trigger('keydown', { key: 'Enter', shiftKey: true })

    expect(store.send).not.toHaveBeenCalled()
    expect(store.draft).toBe('first line')
  })

  /* The modifier keys are not send either: each one is a different intent. */
  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Alt', { altKey: true }],
  ])('does not send on %s+Enter', async (_label, modifier) => {
    store.draft = 'first line'
    store.canSend = true

    const wrapper = mount(MessageComposer)
    await wrapper.find(INPUT).trigger('keydown', { key: 'Enter', ...modifier })

    expect(store.send).not.toHaveBeenCalled()
  })

  it('disables submit while a send is in flight', () => {
    store.draft = 'build a contact dashboard'
    store.sending = true
    store.canSend = false

    const wrapper = mount(MessageComposer)

    expect(wrapper.find(SUBMIT).attributes('disabled')).toBeDefined()
  })

  /*
   * AC-32, D10. At the cap the composer disables itself **and says why**: the
   * limit is a product decision the UI states out loud, not a hidden truncation, so
   * a disabled button with no explanation would be the one thing D10 rules out.
   */
  it('disables the textarea and the button at the limit, and states it', () => {
    store.atLimit = true
    store.canSend = false

    const wrapper = mount(MessageComposer)

    expect(wrapper.find(INPUT).attributes('disabled')).toBeDefined()
    expect(wrapper.find(SUBMIT).attributes('disabled')).toBeDefined()
    const limit = wrapper.find('[data-testid="composer-limit"]')
    expect(limit.exists()).toBe(true)
    expect(limit.text()).toContain('200')
  })

  it('does not state a limit that has not been reached', () => {
    const wrapper = mount(MessageComposer)

    expect(wrapper.find('[data-testid="composer-limit"]').exists()).toBe(false)
  })

  /*
   * AC-34. The message is the server's, and the draft survives — a user who wrote
   * a page of prose must not lose it to a 500, and re-submitting has to be able to
   * send the same text again.
   */
  it("shows the server's message on a failed send and keeps the draft", () => {
    store.draft = 'build a contact dashboard'
    store.canSend = true
    store.sendError = 'This project has reached its limit of 200 messages.'

    const wrapper = mount(MessageComposer)

    const error = wrapper.find('[data-testid="composer-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('This project has reached its limit of 200 messages.')
    expect(wrapper.find<HTMLTextAreaElement>(INPUT).element.value).toBe('build a contact dashboard')
  })

  it('shows no error when there is none', () => {
    const wrapper = mount(MessageComposer)

    expect(wrapper.find('[data-testid="composer-error"]').exists()).toBe(false)
  })

  /* A failure is not a dead end: the same draft can be submitted again. */
  it('still sends after a failure', async () => {
    store.draft = 'build a contact dashboard'
    store.canSend = true
    store.sendError = 'Something went wrong.'

    const wrapper = mount(MessageComposer)
    await wrapper.find(SUBMIT).trigger('click')

    expect(store.send).toHaveBeenCalledTimes(1)
  })
})
