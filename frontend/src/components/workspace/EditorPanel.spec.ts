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
  selectedPath: null as string | null,
  fileTree: [] as FileRow[],
  fileContent: '',
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
  saveFile: vi.fn(),
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

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
describe('EditorPanel', () => {
  it('renders the tree and the editor', () => {
    const wrapper = mount(EditorPanel)

    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-editor"]').exists()).toBe(true)
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
})
