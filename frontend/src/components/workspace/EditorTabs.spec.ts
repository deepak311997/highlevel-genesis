import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

/*
 * `reactive`, `FileTree.spec.ts`'s pattern: the store this replaces is a Pinia
 * store whose refs are reactive and auto-unwrapped on the store object.
 */
const store = reactive({
  openTabs: [] as string[],
  selectedPath: null as string | null,
  dirtyPaths: [] as string[],
  selectFile: vi.fn(),
  closeTab: vi.fn(),
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

const EditorTabs = (await import('./EditorTabs.vue')).default

/**
 * AC-13 and AC-16 — the tab strip.
 *
 * **Hand-rolled rather than the vendored `Tabs`** (D13), for two structural
 * reasons. A closable tab cannot be a single `TabsTrigger` without nesting a
 * `<button>` inside a `<button>`, which is invalid HTML and unreachable by
 * keyboard; and all tabs share **one** Monaco instance, so there is no per-tab
 * `TabsContent` for reka-ui's `Tabs` to switch between — the root would be
 * managing panels that do not exist.
 *
 * So the close control is a **sibling** of the tab, not a child of it, and that
 * is what the last case here is really about.
 */

beforeEach(() => {
  vi.clearAllMocks()
  store.openTabs = []
  store.selectedPath = null
  store.dirtyPaths = []
})

function openThree(): void {
  store.openTabs = ['index.html', 'styles.css', 'app.js']
  store.selectedPath = 'styles.css'
}

const tabs = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-testid="editor-tab"]')

describe('EditorTabs', () => {
  it('renders one tab per open path, in order, marking the active one', () => {
    openThree()
    const wrapper = mount(EditorTabs)

    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
    expect(tabs(wrapper).map((tab) => tab.attributes('data-path'))).toEqual([
      'index.html',
      'styles.css',
      'app.js',
    ])
    // Exactly one, because two would make "the active tab" a question rather
    // than a fact.
    const selected = tabs(wrapper).filter((tab) => tab.attributes('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0]?.attributes('data-path')).toBe('styles.css')
  })

  it('marks the dirty tabs and no others', () => {
    openThree()
    store.dirtyPaths = ['app.js']
    const wrapper = mount(EditorTabs)

    expect(tabs(wrapper).map((tab) => tab.attributes('data-dirty'))).toEqual([
      'false',
      'false',
      'true',
    ])
  })

  /**
   * The dirty mark is **text**, and the dot sits in the close control.
   *
   * `aria-label` on a bare `<span>` names nothing: ARIA forbids an accessible
   * name on a generic element, so the attribute was dropped and the mark reached
   * a screen reader as the bullet character or as nothing at all — for the one
   * thing a tab you are *not* looking at has to be able to say. Real text, hidden
   * from sight rather than from the accessibility tree, with the dot decorative.
   *
   * The dot moved into the close control because the two share one slot (VS
   * Code's arrangement): the dot while the pointer is elsewhere, the ✕ on hover
   * or focus. Two permanent controls per tab is what made the strip unreadable
   * at four open files.
   */
  it('announces a dirty tab in text rather than by the dot alone', () => {
    openThree()
    store.dirtyPaths = ['app.js']
    const wrapper = mount(EditorTabs)

    const dirty = tabs(wrapper).find((tab) => tab.attributes('data-path') === 'app.js')
    expect(dirty?.text()).toContain('Unsaved changes')
    expect(dirty?.find('.sr-only').exists()).toBe(true)

    const mark = wrapper.find('[data-testid="editor-tab-close"][data-path="app.js"]')
    expect(mark.find('[data-testid="editor-tab-dirty"]').exists()).toBe(true)
    expect(mark.find('[data-testid="editor-tab-dirty"]').attributes('aria-hidden')).toBe('true')

    const clean = tabs(wrapper).find((tab) => tab.attributes('data-path') === 'index.html')
    expect(clean?.text()).not.toContain('Unsaved changes')
    expect(
      wrapper
        .find('[data-testid="editor-tab-close"][data-path="index.html"]')
        .find('[data-testid="editor-tab-dirty"]')
        .exists(),
    ).toBe(false)
  })

  /**
   * The swap is **CSS**, not a `v-if` on hover state.
   *
   * A keyboard user never hovers. Rendering the ✕ only while the pointer is over
   * the tab would take the close control out of the DOM — and out of the focus
   * order — for everyone who does not use a mouse, which is the population the
   * sibling-button decision (D13) was made for in the first place.
   */
  it('keeps the close control focusable while the dirty dot is showing', () => {
    openThree()
    store.dirtyPaths = ['app.js']
    const wrapper = mount(EditorTabs)

    const close = wrapper.find('[data-testid="editor-tab-close"][data-path="app.js"]')
    expect(close.exists()).toBe(true)
    expect(close.attributes('disabled')).toBeUndefined()
    expect(close.find('svg').classes().join(' ')).toMatch(/group-focus-within:block/)
  })

  it('activates a tab when it is clicked', async () => {
    openThree()
    const wrapper = mount(EditorTabs)

    await tabs(wrapper)[0]?.trigger('click')

    expect(store.selectFile).toHaveBeenCalledWith('index.html')
    expect(store.closeTab).not.toHaveBeenCalled()
  })

  /**
   * AC-16's strip half. The close control is its own button beside the tab, so
   * closing does **not** also activate — which is what a nested control would do
   * by bubbling, quietly opening the file you asked to be rid of.
   */
  it('closes a tab from its own control, without activating it', async () => {
    openThree()
    const wrapper = mount(EditorTabs)

    const close = wrapper.find('[data-testid="editor-tab-close"][data-path="index.html"]')
    expect(close.attributes('aria-label')).toBe('Close index.html')
    await close.trigger('click')

    expect(store.closeTab).toHaveBeenCalledWith('index.html')
    expect(store.selectFile).not.toHaveBeenCalled()
  })

  /* Invalid HTML and unreachable by keyboard, which is the whole of D13. */
  it('puts the close control beside the tab rather than inside it', () => {
    openThree()
    const wrapper = mount(EditorTabs)

    expect(tabs(wrapper)[0]?.find('button').exists()).toBe(false)
  })

  /**
   * Middle-click closes, because every editor this one resembles does.
   *
   * `.prevent`, since the browser's own middle-click default on a wide strip is
   * to start autoscroll — a scroll gesture the user did not ask for, on top of
   * the close they did.
   */
  it('closes a tab on middle click', async () => {
    openThree()
    const wrapper = mount(EditorTabs)

    await tabs(wrapper)[0]?.trigger('auxclick', { button: 1 })

    expect(store.closeTab).toHaveBeenCalledWith('index.html')
    expect(store.selectFile).not.toHaveBeenCalled()
  })

  /* The same glyph the tree gives the file, so a row and its tab match. */
  it('gives each tab its file icon', () => {
    openThree()
    const wrapper = mount(EditorTabs)

    expect(tabs(wrapper)[0]?.find('svg').classes()).toContain('lucide-code-xml')
    expect(tabs(wrapper)[1]?.find('svg').classes()).toContain('lucide-palette')
  })

  /**
   * The label truncates at `max-w-44`, so the full path has to be somewhere.
   *
   * A filename may run to 64 characters (`PATH_MAX`), and in a panel this narrow
   * the visible half of two long names can be identical.
   */
  it('carries the whole path as the tab’s title', () => {
    openThree()
    const wrapper = mount(EditorTabs)

    expect(tabs(wrapper)[0]?.attributes('title')).toBe('index.html')
  })

  /**
   * The tab that just became active is scrolled into view.
   *
   * `selectFile` is reachable from the tree as well as from the strip, so with
   * several files open the tab that becomes active is routinely off the right
   * edge — and the strip would then be marking a tab nobody can see. `block:
   * 'nearest'` so a tab already on screen does not drag the panel around it.
   */
  it('scrolls the newly active tab into view', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    openThree()
    const wrapper = mount(EditorTabs)

    store.selectedPath = 'app.js'
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  /* No tab open is not an empty strip with a border — it is no strip at all,
   * since `FileEditor` already renders the panel's own empty state. */
  it('renders nothing with no tab open', () => {
    const wrapper = mount(EditorTabs)

    expect(wrapper.find('[data-testid="editor-tabs"]').exists()).toBe(false)
    expect(tabs(wrapper)).toHaveLength(0)
  })
})
