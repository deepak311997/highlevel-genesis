import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  generating: false,
  streamingText: '',
  /*
   * Read by `StreamingStatus` and `MessageBody`, which the placeholder now
   * mounts. Present on the real store since Slice 6; absent here only because
   * this stand-in predates the components that use them.
   */
  streamingFiles: {},
  selectFile: vi.fn(),
  generateError: null as string | null,
  generateFileError: null as string | null,
  loadMessages: vi.fn(),
  retryGeneration: vi.fn(),
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
  truncated: false,
}

const ASSISTANT: Message = {
  id: 'msg-2',
  role: 'assistant',
  content: 'Here is a contact dashboard',
  createdAt: '2026-08-17T09:05:00.000Z',
  truncated: false,
}

/* The composer owns the store and has a suite of its own. */
const MOUNT = { global: { stubs: { MessageComposer: true } } }

/**
 * Built by concatenation and scanned for below, `no-firestore.spec.ts`'s trick:
 * the scanner must not find the string it is looking for in its own source.
 */
const NEEDLE = 'Echo' + ' mode'

/** Skipped for the same reason. */
const SELF = 'ChatPanel.spec.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (entry.name === SELF) return []
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

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
  store.generating = false
  store.streamingText = ''
  store.generateError = null
  store.generateFileError = null
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

  /*
   * AC-2. The two bubble placeholders are the shared `Skeleton`, not hand-rolled
   * pulsing divs — the testid still resolves to the same element, and what
   * it holds carries the primitive's slot attribute.
   */
  it('renders Skeleton placeholders while loading', () => {
    store.messagesLoading = true

    const wrapper = mount(ChatPanel, MOUNT)

    const loading = wrapper.find('[data-testid="chat-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.findAll('[data-slot="skeleton"]')).toHaveLength(2)
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
    expect(bubbles[1]?.text()).toContain('Here is a contact dashboard')
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

  /*
   * AC-38's second clause. Slice 4 said the badge and the echo would go together,
   * and they have. A source scan as well as a render check, because the string
   * living on in a component nobody mounted in this suite would be exactly the
   * kind of leftover a render assertion misses.
   */
  it('says nothing about echo mode', () => {
    store.messagesLoaded = true
    store.messages = [USER, ASSISTANT]

    expect(mount(ChatPanel, MOUNT).text()).not.toContain('Echo mode')
  })

  it('has no "Echo mode" anywhere under frontend/src', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src')).filter((path) =>
      readFileSync(path, 'utf8').includes(NEEDLE),
    )

    expect(offenders).toEqual([])
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

/**
 * The streaming states — the four Slice 4 shipped, plus the three this slice adds.
 *
 * The badge and the placeholder bubble are what discharge D14's cost: adaptive
 * thinking means the first token can be seconds away, and a labelled wait is a
 * different experience from a frozen screen.
 */
describe('bubble elevation', () => {
  /*
   * **No drop shadow on a bubble**, and this is a regression guard rather than a
   * preference.
   *
   * The dark palette puts `--card` at `hsl(240 5% 6%)` on a `4%` page and defines
   * `--sh-1` as a *black* shadow. A black shadow on a near-black ground cannot
   * darken anything — it only blurs the boundary, so an elevated bubble reads as
   * a smudge with a halo rather than as a raised surface. Elevation in this
   * palette comes from the surface and the border (`Card.vue` uses
   * `from-raised to-card`), which is what these bubbles do now.
   *
   * Asserted on the class list because that is where the mistake recurs: the
   * utility is one convenient copy-paste away and nothing else would fail.
   */
  it('gives the assistant bubble a defined edge instead of a shadow', () => {
    store.messages = [ASSISTANT]
    store.messagesLoaded = true

    const wrapper = mount(ChatPanel)
    const bubble = wrapper.get('[data-testid="message-bubble"]')

    expect(bubble.classes().some((name) => name.startsWith('shadow-'))).toBe(false)
    expect(bubble.classes()).toContain('border-border-strong')
  })

  it('gives the streaming placeholder the same treatment', () => {
    store.messages = []
    store.messagesLoaded = true
    store.generating = true

    const wrapper = mount(ChatPanel)
    const bubble = wrapper.get('[data-testid="streaming-bubble"]')

    expect(bubble.classes().some((name) => name.startsWith('shadow-'))).toBe(false)
    expect(bubble.classes()).toContain('border-border-strong')
  })
})

describe('ChatPanel while a stream is open', () => {
  /** AC-38. */
  it('shows a live status line and a bubble carrying the accumulated text', () => {
    store.messagesLoaded = true
    store.messages = [USER]
    store.generating = true
    store.streamingText = 'Here is a cont'

    const wrapper = mount(ChatPanel, MOUNT)

    /*
     * `Generating…` was one fixed string for the whole turn. It is now three
     * states — thinking, writing prose, writing a named file — so the assertion
     * is that the status line is present and says which; `StreamingStatus.spec.ts`
     * owns the choice between them.
     */
    expect(wrapper.find('[data-testid="streaming-status"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="streaming-status"]').text()).toContain('Writing')
    const bubble = wrapper.find('[data-testid="streaming-bubble"]')
    expect(bubble.exists()).toBe(true)
    expect(bubble.text()).toContain('Here is a cont')
  })

  /* The placeholder sits inside the transcript list, so one scroll mechanism
   * covers both it and the finished bubbles. */
  it('renders the placeholder inside the transcript, after the last bubble', () => {
    store.messagesLoaded = true
    store.messages = [USER]
    store.generating = true
    store.streamingText = 'Here is'

    const wrapper = mount(ChatPanel, MOUNT)
    const items = wrapper.findAll('[data-testid="chat-transcript"] > li')

    expect(items).toHaveLength(2)
    expect(items.at(-1)?.attributes('data-testid')).toBe('streaming-bubble')
  })

  /*
   * The empty state cannot collide with a stream: the user's message is appended
   * before the stream opens, so `bubbles.length` is never 0 while generating.
   * Asserted rather than argued, because the two branches are mutually exclusive
   * in the template and a future edit could make them overlap.
   */
  it('shows the placeholder rather than the empty state', () => {
    store.messagesLoaded = true
    store.messages = [USER]
    store.generating = true

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="chat-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="streaming-bubble"]').exists()).toBe(true)
  })

  /** AC-39. */
  it('renders no badge and no placeholder when no stream is open', () => {
    store.messagesLoaded = true
    store.messages = [USER, ASSISTANT]

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="streaming-status"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="streaming-bubble"]').exists()).toBe(false)
  })
})

describe('ChatPanel — the interrupted marker', () => {
  /*
   * AC-40. One flag for four causes — a client disconnect, a mid-stream failure,
   * `stop_reason: 'max_tokens'` and the byte cap (D23) — so the panel has one
   * thing to render and the user has one thing to understand.
   */
  it('marks a truncated message and leaves a complete one unmarked', () => {
    store.messagesLoaded = true
    store.messages = [{ ...ASSISTANT, truncated: true }, ASSISTANT]

    const wrapper = mount(ChatPanel, MOUNT)
    const bubbles = wrapper.findAll(BUBBLE)

    expect(bubbles[0]?.find('[data-testid="message-interrupted"]').exists()).toBe(true)
    expect(bubbles[1]?.find('[data-testid="message-interrupted"]').exists()).toBe(false)
  })

  it('says what the marker means rather than only showing an icon', () => {
    store.messagesLoaded = true
    store.messages = [{ ...ASSISTANT, truncated: true }]

    expect(mount(ChatPanel, MOUNT).find('[data-testid="message-interrupted"]').text()).toMatch(
      /interrupted/i,
    )
  })
})

describe('ChatPanel — the generation error', () => {
  /** AC-41. */
  it("shows the server's message and a Retry that calls retryGeneration once", async () => {
    store.messagesLoaded = true
    store.messages = [USER]
    store.generateError = 'The reply was interrupted. Try again.'

    const wrapper = mount(ChatPanel, MOUNT)

    const error = wrapper.find('[data-testid="generate-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('The reply was interrupted. Try again.')

    await wrapper.find('[data-testid="generate-retry"]').trigger('click')
    expect(store.retryGeneration).toHaveBeenCalledTimes(1)
  })

  it('shows no generation error when there is none', () => {
    store.messagesLoaded = true
    store.messages = [USER]

    expect(mount(ChatPanel, MOUNT).find('[data-testid="generate-error"]').exists()).toBe(false)
  })

  /*
   * AC-8, at the level the user actually meets it.
   *
   * `generateApi` maps a dropped read to this sentence and its L1 spec pins the
   * mapping; this is the other end of that claim — the panel renders the app's
   * own line, and the browser's word for it appears nowhere on screen. The
   * negative assertion is on the whole panel rather than on the alert, because
   * "the raw message is not visible" is the claim, not "it is not in that one
   * element".
   */
  it("renders the app's own line when the stream dies mid-reply", () => {
    store.messagesLoaded = true
    store.messages = [USER]
    store.generateError = 'Something went wrong. Check your connection and try again.'

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="generate-error"]').text()).toContain(
      'Something went wrong. Check your connection and try again.',
    )
    expect(wrapper.text()).not.toContain('Failed to fetch')
    expect(wrapper.find('[data-testid="generate-retry"]').exists()).toBe(true)
  })

  /*
   * The transcript stays on screen beside the error. A failed generation does not
   * invalidate the conversation, and hiding it would lose the partial the server
   * just persisted — which is the thing F8.2 exists to preserve.
   */
  it('keeps the transcript visible beside the error', () => {
    store.messagesLoaded = true
    store.messages = [USER, { ...ASSISTANT, truncated: true }]
    store.generateError = 'The reply was interrupted. Try again.'

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.findAll(BUBBLE)).toHaveLength(2)
    expect(wrapper.find('[data-testid="message-interrupted"]').exists()).toBe(true)
  })
})

describe('ChatPanel — scrolling while tokens arrive', () => {
  /*
   * AC-43. The growing reply has to stay in view, and the two heights are the
   * point: measuring once on mount would leave the viewport a screen behind by
   * the third token.
   */
  it('scrolls to the bottom as streamingText grows', async () => {
    store.messagesLoaded = true
    store.messages = [USER]
    store.generating = true
    store.streamingText = 'Here'
    scrollHeight = 200

    const wrapper = mount(ChatPanel, { ...MOUNT, attachTo: document.body })
    await flushPromises()
    const viewport = wrapper.find<HTMLElement>(VIEWPORT).element
    expect(viewport.scrollTop).toBe(200)

    scrollHeight = 640
    store.streamingText = 'Here is a contact dashboard'
    await flushPromises()

    expect(viewport.scrollTop).toBe(640)
  })
})

/**
 * AC-46, D29 — the transcript renders **chips, not code**.
 *
 * The stored message carries `[file: index.html]` marker lines where a file went
 * (D6), so a bubble that rendered its content raw would read like a build log with
 * what looks like a bug in it. `splitMessageContent` is the decision and has its
 * own L1 tests; what is asserted here is that both the persisted bubble and the
 * streaming placeholder use it — the live text and the stored text are the same
 * string (D7), so anything else is two renderings of one thing.
 */
describe('ChatPanel — file chips', () => {
  const WITH_FILES: Message = {
    ...ASSISTANT,
    content: 'Here is a contact dashboard.\n\n[file: index.html]\n[file: app.js]\n\nOpen it.',
  }

  it('renders the prose as text and each marker as a chip', () => {
    store.messagesLoaded = true
    store.messages = [WITH_FILES]

    const wrapper = mount(ChatPanel, MOUNT)
    const bubble = wrapper.find(BUBBLE)

    expect(bubble.findAll('[data-testid="file-chip"]').map((chip) => chip.text())).toEqual([
      'index.html',
      'app.js',
    ])
    expect(bubble.text()).toContain('Here is a contact dashboard.')
    expect(bubble.text()).toContain('Open it.')
  })

  /* The bubble must never carry the code itself — the whole point of D6. */
  it('renders no marker line as raw text', () => {
    store.messagesLoaded = true
    store.messages = [WITH_FILES]

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find(BUBBLE).text()).not.toContain('[file:')
  })

  it('renders no chip for a message without markers', () => {
    store.messagesLoaded = true
    store.messages = [ASSISTANT]

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="file-chip"]').exists()).toBe(false)
  })

  /** The placeholder is the same string, so it renders the same way (D7). */
  it('renders chips in the streaming placeholder too', () => {
    store.messagesLoaded = true
    store.messages = [USER]
    store.generating = true
    store.streamingText = 'Here it is.\n\n[file: index.html]\n'

    const wrapper = mount(ChatPanel, MOUNT)
    const bubble = wrapper.find('[data-testid="streaming-bubble"]')

    expect(bubble.findAll('[data-testid="file-chip"]').map((chip) => chip.text())).toEqual([
      'index.html',
    ])
    expect(bubble.text()).toContain('Here it is.')
  })

  /*
   * A half-arrived marker is still prose until it closes, so the bubble shows the
   * partial line rather than flickering a chip in and out on every token.
   */
  it('leaves a half-arrived marker as text', () => {
    store.messagesLoaded = true
    store.messages = [USER]
    store.generating = true
    store.streamingText = 'Here it is.\n\n[file: ind'

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="streaming-bubble"]').text()).toContain('[file: ind')
    expect(wrapper.find('[data-testid="file-chip"]').exists()).toBe(false)
  })
})

/**
 * A turn whose files were refused (D8, D17).
 *
 * Its own notice rather than `generateError`'s: the reply itself succeeded and is
 * in the transcript, so offering the Retry that belongs to a failed generation
 * would be the wrong action for the wrong problem.
 */
describe('ChatPanel — the generation’s file error', () => {
  it('renders the file error with no retry', () => {
    store.messagesLoaded = true
    store.messages = [ASSISTANT]
    store.generateFileError = 'That reply left “app.js” unfinished, so nothing was saved.'

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="generate-file-error"]').text()).toContain(
      'That reply left “app.js” unfinished, so nothing was saved.',
    )
    expect(wrapper.find('[data-testid="generate-retry"]').exists()).toBe(false)
  })

  it('renders nothing when the turn wrote its files cleanly', () => {
    store.messagesLoaded = true
    store.messages = [ASSISTANT]

    const wrapper = mount(ChatPanel, MOUNT)

    expect(wrapper.find('[data-testid="generate-file-error"]').exists()).toBe(false)
  })
})
