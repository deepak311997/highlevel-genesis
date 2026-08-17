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
 * D23 — Monaco never runs below L5. Stubbed here as well as in
 * `FileEditor.spec.ts`, and not only for speed: unstubbed, this suite would pull
 * the real editor chunk into jsdom, and `VueMonacoEditor`'s own `onMounted`
 * calls `loader.init()`.
 */
vi.mock('./CodeEditor.vue', () => ({
  default: { name: 'CodeEditor', template: '<div data-testid="code-editor" />' },
}))

const EditorPanel = (await import('./EditorPanel.vue')).default

/**
 * The code panel's composition — the tree above the editor (AC-47).
 *
 * One rule is asserted here rather than left to the eye, because it is the one a
 * unit test can state and no test in this project can *observe*: **the element
 * that caps the tree's height is the element that scrolls it.**
 *
 * A project may hold twenty files and the panel caps the tree at 14rem so the
 * editor is not left a sliver. Capping with `overflow-hidden` clips the rows
 * past the cap and offers nothing to scroll — `FileTree`'s inner scroller cannot
 * take over, because it sits in a container whose height is its own content and
 * so never overflows. The rows below the fold are then simply unreachable, and
 * `index.html` is first in the order, so the files that disappear are the ones a
 * user would go looking for.
 *
 * jsdom computes no layout, so the failure itself is invisible at L2 and the
 * fixtures at L4 and L5 write three files. Pinning the two classes to one
 * element is what is left, and it fails if the capping is ever restored without
 * the scrolling.
 */
/** One mount, so the geometry cases below read the same tree the panel renders. */
const wide = () => mount(EditorPanel)

describe('EditorPanel', () => {
  it('renders the tree and the editor', () => {
    const wrapper = mount(EditorPanel)

    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-editor"]').exists()).toBe(true)
  })

  /**
   * AC-29 — history is reached from the code panel's header, in both layouts.
   *
   * The header is the only chrome the panel has, and the panel is the thing a
   * version *is* — a set of files. Anywhere else (a toolbar over the chat, a
   * menu on the project) and the trigger would be a step away from what it
   * shows. Only the trigger is asserted here; the sheet's own four states are
   * `SnapshotSheet.spec.ts`'s.
   */
  it('renders the History trigger in its header', () => {
    const wrapper = mount(EditorPanel)

    const header = wrapper.find('header')
    expect(header.find('[data-testid="snapshot-trigger"]').exists()).toBe(true)
  })

  it('scrolls the tree at the height it caps it to', () => {
    const wrapper = mount(EditorPanel)

    const capped = wrapper
      .findAll('div')
      .filter((element) => /(^|\s)max-h-/.test(element.attributes('class') ?? ''))

    expect(capped).toHaveLength(1)
    expect(capped[0]?.attributes('class')).toMatch(/overflow-y-auto/)
    // The clipping this replaced: a capped box that hides what it cannot show.
    expect(capped[0]?.attributes('class')).not.toMatch(/overflow-hidden/)
  })

  /** The strip goes between the tree and the editor, not inside either. */
  it('renders the tab strip between the tree and the editor', () => {
    const wrapper = wide()

    const order = wrapper
      .findAll('[data-testid="file-tree"], [data-testid="editor-tabs"], [data-testid="file-editor"]')
      .map((element) => element.attributes('data-testid'))

    expect(order).toEqual(['file-tree', 'editor-tabs', 'file-editor'])
  })

  /**
   * D19, R4 — the finding Slice 6 handed over, in the form Monaco makes fatal.
   *
   * Monaco **measures its container**. A container sized by its own content
   * collapses the editor to 0 px and renders nothing at all, with no error
   * attached — and jsdom computes no layout, so no test at any level below L5 can
   * see it. AC-30 measures the real box in a browser; this pins the chain of
   * classes that produces it, which is the part a refactor can break silently.
   *
   * The chain is: the panel is a `min-h-0` column, the editor's region is
   * `min-h-0 flex-1`, and `CodeEditor`'s root is `h-full`. Any link left out and
   * the box has no definite height.
   */
  it('gives the editor region a definite height', () => {
    const wrapper = wide()

    const editor = wrapper.find('[data-testid="file-editor"]')
    expect(editor.attributes('class')).toMatch(/min-h-0/)
    expect(editor.attributes('class')).toMatch(/flex-1/)

    /*
     * The panel carries **both** `h-full` and `flex-1`, because the two layouts
     * hand it its height differently — a stretch-sized `ResizablePanel` (where a
     * percentage resolves) and a `TabsContent` sized by `flex-grow` (where it
     * does not, and the editor collapsed to 5px). Each is inert in the other
     * layout; dropping either one breaks exactly one of them, silently.
     */
    const panel = wrapper.find('[data-testid="editor-panel"]')
    expect(panel.attributes('class')).toMatch(/min-h-0/)
    expect(panel.attributes('class')).toMatch(/h-full/)
    expect(panel.attributes('class')).toMatch(/flex-1/)

    // Nothing inside the panel opts back out of it.
    expect(wrapper.html()).not.toMatch(/\bh-auto\b/)
  })
})
