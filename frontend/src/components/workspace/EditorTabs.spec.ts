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

  /* No tab open is not an empty strip with a border — it is no strip at all,
   * since `FileEditor` already renders the panel's own empty state. */
  it('renders nothing with no tab open', () => {
    const wrapper = mount(EditorTabs)

    expect(wrapper.find('[data-testid="editor-tabs"]').exists()).toBe(false)
    expect(tabs(wrapper)).toHaveLength(0)
  })
})
