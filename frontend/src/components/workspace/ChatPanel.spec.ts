import { flushPromises, mount } from '@vue/test-utils'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { Message } from '@/lib/messagesApi'

/*
 * `reactive`, not a plain object — unlike `ProjectsCard.spec.ts`, which only ever
 * sets its mocked store before mounting. AC-35 is about what happens when a message
 * is appended to a *mounted* panel, so the panel's `watch` has to actually fire, and
 * a plain object cannot make it. The store this replaces is a Pinia store, whose
 * refs are reactive and auto-unwrapped on the store object; `reactive` is the
 * closest honest stand-in.
 */
const store = reactive({
  messages: [] as Message[],
  messagesLoading: false,
  messagesLoaded: false,
  messagesError: null as string | null,
  loadMessages: vi.fn(),
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

/*
 * Imported dynamically, after `store` exists. A static import is hoisted above the
 * `const` by ESM, and the mock factory runs during that import — so the panel would
 * close over an undefined store.
 */
const ChatPanel = (await import('./ChatPanel.vue')).default

/*
 * jsdom performs no layout, so every element's `scrollHeight` is 0 and
 * `scrollTop = scrollHeight` would assert `0 === 0` — true of a panel that never
 * scrolls at all. One settable stand-in for the whole suite gives the two scroll
 * cases something real to measure, and letting the tests vary it is what
 * distinguishes "wrote the height it read now" from "wrote a height once".
 */
let scrollHeight = 0

/**
 * The chat panel's four states, all of them shipped: loading, bubbles, empty, and
 * error-with-retry.
 *
 * The error one is not theoretical — the transcript's only source of truth is an
 * endpoint — and it comes **first**, as `ProjectsCard` orders its branches: a failed
 * first request leaves `messagesLoaded` false, so a loading branch ahead of it would
 * render a skeleton forever and never show the failure.
 */

const USER: Message = {
  id: 'msg-1',
  role: 'user',
  content: 'build a contact dashboard',
  createdAt: '2026-08-17T09:05:00.000Z',
}

const ASSISTANT: Message = {
  id: 'msg-2',
  role: 'assistant',
  content: 'You said: build a contact dashboard',
  createdAt: '2026-08-17T09:05:00.000Z',
}

/* The composer owns the store and has a suite of its own. */
const MOUNT = { global: { stubs: { MessageComposer: true } } }

const BUBBLE = '[data-testid="message-bubble"]'
const VIEWPORT = '[data-reka-scroll-area-viewport]'

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
})

afterAll(() => {
  // Restore jsdom's own definition rather than leaving a fake on the prototype for
  // whatever runs next in this environment.
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
})

beforeEach(() => {
  scrollHeight = 0
  store.messages = []
  store.messagesLoading = false
  store.messagesLoaded = false
  store.messagesError = null
  vi.clearAllMocks()
})

describe('ChatPanel', () => {
  /** AC-27. */
  it('shows a loading state and no bubbles while the transcript is in flight', () => {
    store.messagesLoading = true

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="chat-loading"]').exists()).toBe(true)
    expect(wrapper.findAll(BUBBLE)).toHaveLength(0)
    expect(wrapper.find('[data-testid="chat-empty"]').exists()).toBe(false)
  })

  /* `messagesLoading` alone cannot say "no answer yet": it is still false in the
   * tick between mounting and the request starting. */
  it('shows the loading state before the request has started', () => {
    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="chat-loading"]').exists()).toBe(true)
  })

  /** AC-28. Asked, and there is nothing — with the composer still available. */
  it('shows the empty state, no error, and the composer when the transcript is empty', () => {
    store.messagesLoaded = true

    const wrapper = mount(ChatPanel, MOUNT)

    const empty = wrapper.find('[data-testid="chat-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('No messages yet')
    expect(wrapper.find('[data-testid="chat-error"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'MessageComposer' }).exists()).toBe(true)
  })

  /** AC-29. One bubble per message, and the two roles are distinguishable. */
  it('renders one bubble per message, distinguishing user from assistant', () => {
    store.messagesLoaded = true
    store.messages = [USER, ASSISTANT]

    const wrapper = mount(ChatPanel, MOUNT)
    const bubbles = wrapper.findAll(BUBBLE)

    expect(bubbles).toHaveLength(2)
    expect(bubbles.map((bubble) => bubble.attributes('data-role'))).toEqual(['user', 'assistant'])
    expect(bubbles[0]?.text()).toContain('build a contact dashboard')
    expect(bubbles[1]?.text()).toContain('You said: build a contact dashboard')
  })

  /** AC-29's time half — pinned by `formatTime`, so this is a fixed string. */
  it('renders each message’s time, derived from createdAt', () => {
    store.messagesLoaded = true
    store.messages = [USER]

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="message-time"]').text()).toBe('09:05')
  })

  /*
   * AC-29's last clause, D29. A stored timestamp that will not parse renders the
   * message *without* a time rather than with "Invalid Date" — the content is what
   * matters, and a broken bubble would be worse than a missing line.
   */
  it('renders content with no time when createdAt will not parse', () => {
    store.messagesLoaded = true
    store.messages = [{ ...USER, createdAt: 'not a date' }]

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find(BUBBLE).text()).toContain('build a contact dashboard')
    expect(wrapper.find('[data-testid="message-time"]').exists()).toBe(false)
  })

  /** AC-30. The server's message, and a retry that re-issues the request. */
  it("shows the server's message with a retry that reloads the transcript", async () => {
    store.messagesError = 'Something went wrong. Check your connection and try again.'

    const wrapper = mount(ChatPanel, MOUNT)

    const error = wrapper.find('[data-testid="chat-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('Something went wrong. Check your connection and try again.')

    await wrapper.find('[data-testid="chat-retry"]').trigger('click')
    expect(store.loadMessages).toHaveBeenCalledTimes(1)
  })

  /* Error first: a failed first request leaves `messagesLoaded` false, so a
   * loading branch ahead of it would hide the failure behind a skeleton forever. */
  it('shows the error rather than the loading state when the first request failed', () => {
    store.messagesError = 'Something went wrong.'
    store.messagesLoaded = false

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="chat-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-loading"]').exists()).toBe(false)
  })

  /* D7, D19. The badge says out loud that the reply is not intelligence. Both it
   * and the echo disappear together in Slice 5. */
  it('says it is in echo mode', () => {
    store.messagesLoaded = true

    expect(mount(ChatPanel, MOUNT).text()).toContain('Echo mode')
  })

  /* The composer renders in every branch except loading: there is nothing to say
   * yet while the transcript is still arriving. */
  it.each([
    ['with messages', { messagesLoaded: true, messages: [USER] }],
    ['when empty', { messagesLoaded: true }],
    ['when the request failed', { messagesError: 'Nope.' }],
  ])('renders the composer %s', (_label, state) => {
    Object.assign(store, state)

    expect(mount(ChatPanel, MOUNT).findComponent({ name: 'MessageComposer' }).exists()).toBe(true)
  })

  it('does not render the composer while the transcript is loading', () => {
    store.messagesLoading = true

    expect(mount(ChatPanel, MOUNT).findComponent({ name: 'MessageComposer' }).exists()).toBe(false)
  })

  /*
   * AC-35. The two heights are the point: the panel is mounted while the content is
   * 120 tall and grows to 480 when the message is appended, so asserting 480 proves
   * it re-measured on the append rather than reusing what it read on mount.
   */
  it('scrolls the viewport to the bottom when a message is appended', async () => {
    store.messagesLoaded = true
    store.messages = [USER]
    scrollHeight = 120

    const wrapper = mount(ChatPanel, { ...MOUNT, attachTo: document.body })
    await flushPromises()
    const viewport = wrapper.find<HTMLElement>(VIEWPORT).element
    expect(viewport.scrollTop).toBe(120)

    scrollHeight = 480
    store.messages = [USER, ASSISTANT]
    await flushPromises()

    expect(viewport.scrollTop).toBe(480)
  })

  /* On mount too, so a reload opens on the newest message rather than the oldest. */
  it('scrolls to the bottom on mount', async () => {
    store.messagesLoaded = true
    store.messages = [USER, ASSISTANT]
    scrollHeight = 640

    const wrapper = mount(ChatPanel, { ...MOUNT, attachTo: document.body })
    await flushPromises()

    expect(wrapper.find<HTMLElement>(VIEWPORT).element.scrollTop).toBe(640)
  })
})
