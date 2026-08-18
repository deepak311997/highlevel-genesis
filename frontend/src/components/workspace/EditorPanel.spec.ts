import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { FileRow } from '@/lib/files'
import type { FileMeta } from '@/lib/filesApi'

const store = reactive({
  files: [] as FileMeta[],
  filesLoading: false,
  filesLoaded: true,
  filesError: null as string | null,
  selectedPath: 'index.html',
  openTabs: ['index.html'],
  dirtyPaths: [] as string[],
  fileTree: [] as FileRow[],
  editorContent: '',
  fileDirty: false,
  fileLoading: false,
  fileError: null as string | null,
  saving: false,
  saveError: null as string | null,
  fileReplaced: false,
  generating: false,
  loadFiles: vi.fn(),
  selectFile: vi.fn(),
  closeTab: vi.fn(),
  editContent: vi.fn(),
  reloadFile: vi.fn(),
  saveFile: vi.fn(),
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

/**
 * D23 — Monaco never runs below L5. Stubbed here as well as in `FileEditor.spec.ts`, and not
 * only for speed: unstubbed, this suite would pull the real editor chunk into jsdom, and
 * `VueMonacoEditor`'s own `onMounted` calls `loader.init()`.
 */
vi.mock('./CodeEditor.vue', () => ({
  default: { name: 'CodeEditor', template: '<div data-testid="code-editor" />' },
}))

const EditorPanel = (await import('./EditorPanel.vue')).default

/**
 * The code panel's composition — the explorer beside the editor.
 *
 * The tree used to sit *above* the editor in a box capped at 14rem, and the two rules that
 * arrangement needed are both gone with it: the cap, and the scroller that had to live on the
 * same element as the cap. A rail is a flex item in a row whose height comes from the panel, so
 * its overflow is real without anyone declaring a height — which is why the assertion below is
 * about the rail scrolling and about no `max-h-` surviving anywhere.
 */
/** One mount, so the geometry cases below read the same tree the panel renders. */
const wide = () => mount(EditorPanel)

describe('EditorPanel', () => {
  it('renders the tree and the editor', () => {
    const wrapper = mount(EditorPanel)

    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-editor"]').exists()).toBe(true)
  })

  /** AC-29 — history is reached from the code panel's header, in both layouts. */
  it('renders the History trigger in its header', () => {
    const wrapper = mount(EditorPanel)

    const header = wrapper.find('header')
    expect(header.find('[data-testid="snapshot-trigger"]').exists()).toBe(true)
  })

  it('scrolls the explorer rail rather than capping it', () => {
    const wrapper = mount(EditorPanel)

    const rail = wrapper.find('[data-testid="file-explorer"]')
    expect(rail.attributes('class')).toMatch(/overflow-y-auto/)
    // The clipping this replaced: a capped box that hides what it cannot show.
    expect(rail.attributes('class')).not.toMatch(/overflow-hidden/)
    // And the cap itself is gone — a bounded flex item does not need one, and a
    // `max-h-` here would put back the box whose inner scroller never overflows.
    expect(wrapper.html()).not.toMatch(/\bmax-h-/)
  })

  /** The rail collapses, and collapsing takes it out of the DOM. */
  it('hides the explorer from its header control', async () => {
    const wrapper = mount(EditorPanel)

    const toggle = wrapper.find('[data-testid="explorer-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('true')

    await toggle.trigger('click')

    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-testid="file-explorer"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(false)
    // The editor is untouched by the fold — it is the thing being made room for.
    expect(wrapper.find('[data-testid="file-editor"]').exists()).toBe(true)

    await toggle.trigger('click')
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true)
  })

  /** The count is the tree's own rows, so a file still streaming is in it. */
  it('counts the files in its header, and says nothing at zero', async () => {
    const wrapper = mount(EditorPanel)
    expect(wrapper.find('[data-testid="editor-file-count"]').exists()).toBe(false)

    store.fileTree = [
      { path: 'index.html', writing: false },
      { path: 'app.js', writing: true },
    ]
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="editor-file-count"]').text()).toBe('2')

    // The store here is module-level and shared; the cases below assume the
    // panel they mount is the one this file described at the top.
    store.fileTree = []
  })

  /** The strip goes between the tree and the editor, not inside either. */
  it('renders the tab strip between the tree and the editor', () => {
    const wrapper = wide()

    const order = wrapper
      .findAll(
        '[data-testid="file-tree"], [data-testid="editor-tabs"], [data-testid="file-editor"]',
      )
      .map((element) => element.attributes('data-testid'))

    expect(order).toEqual(['file-tree', 'editor-tabs', 'file-editor'])
  })

  /** D19, R4 — the finding Slice 6 handed over, in the form Monaco makes fatal. */
  it('gives the editor region a definite height', () => {
    const wrapper = wide()

    const editor = wrapper.find('[data-testid="file-editor"]')
    expect(editor.attributes('class')).toMatch(/min-h-0/)
    expect(editor.attributes('class')).toMatch(/flex-1/)

    /*
     * The panel carries **both** `h-full` and `flex-1`, because the two layouts hand it its
     * height differently — a stretch-sized `ResizablePanel` (where a percentage resolves) and a
     * `TabsContent` sized by `flex-grow` (where it does not, and the editor collapsed to 5px).
     */
    const column = wrapper.find('[data-testid="file-editor"]').element.parentElement
    expect(column?.className).toMatch(/min-h-0/)
    expect(column?.className).toMatch(/flex-1/)

    const panel = wrapper.find('[data-testid="editor-panel"]')
    expect(panel.attributes('class')).toMatch(/min-h-0/)
    expect(panel.attributes('class')).toMatch(/h-full/)
    expect(panel.attributes('class')).toMatch(/flex-1/)

    // Nothing inside the panel opts back out of it.
    expect(wrapper.html()).not.toMatch(/\bh-auto\b/)
  })
})
