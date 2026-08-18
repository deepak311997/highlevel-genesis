import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { FILE_BYTES_MAX } from '@/lib/filesApi'

const store = reactive({
  selectedPath: null as string | null,
  openTabs: [] as string[],
  dirtyPaths: [] as string[],
  editorContent: '',
  fileDirty: false,
  fileLoading: false,
  fileError: null as string | null,
  saving: false,
  saveError: null as string | null,
  fileReplaced: false,
  generating: false,
  saveFile: vi.fn(),
  reloadFile: vi.fn(),
  closeTab: vi.fn(),
  editContent: vi.fn(),
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

/**
 * D23 — Monaco never runs below L5, so the editor is a stub here. `CodeEditor`
 * has its own spec against a fake monaco; what this file is about is everything
 * *around* the widget.
 */
vi.mock('./CodeEditor.vue', () => ({
  default: { name: 'CodeEditor', template: '<div data-testid="code-editor" />' },
}))

const FileEditor = (await import('./FileEditor.vue')).default

/**
 * AC-19, AC-21, AC-22 — the panel around the editor.
 *
 * **This file is D26's test.** Slice 6 deliberately put every rule in the store —
 * the byte count, the cap, the disabled states, the read-only guard — so that
 * swapping the widget for Monaco would touch the widget and nothing else. Every
 * case below except two is byte-for-byte the Slice 6 case, and they still pass
 * over a completely different editor. The two that changed are the two that
 * named the textarea.
 *
 * Two cases are the visible half of R4. The panel is **read-only while a stream
 * is open** (D9) — the one window in which a generation's batch and this editor
 * are two writers for one document — and a buffer replaced by a generation says
 * so rather than vanishing (D15, D16). Slice 11's D22 leaves that notice in
 * place and makes its copy origin-neutral (P8), because a restore is a second
 * thing that can replace a buffer and it raises the same flag.
 */

beforeEach(() => {
  vi.clearAllMocks()
  store.selectedPath = null
  store.openTabs = []
  store.dirtyPaths = []
  store.editorContent = ''
  store.fileDirty = false
  store.fileLoading = false
  store.fileError = null
  store.saving = false
  store.saveError = null
  store.fileReplaced = false
  store.generating = false
})

/** Open `index.html` with content, clean. */
function openFile(content = '<h1>Contacts</h1>\n'): void {
  store.selectedPath = 'index.html'
  store.openTabs = ['index.html']
  store.editorContent = content
}

describe('FileEditor', () => {
  it('renders the empty state with nothing selected', () => {
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-empty"]').text()).toContain('Select a file')
    expect(wrapper.find('[data-testid="code-editor"]').exists()).toBe(false)
  })

  /*
   * The widget is `CodeEditor` now, and it reads the store itself rather than
   * taking the text as a prop — which is why this asserts that the editor is
   * rendered rather than what is inside it. That the bytes reach the document is
   * `CodeEditor.spec.ts`'s claim, against a fake monaco, and AC-31's in a browser.
   */
  it('renders the editor for an open file', () => {
    openFile()
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="code-editor"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-editor-empty"]').exists()).toBe(false)
  })

  /*
   * The cap is bytes, so the count is bytes — a character count would tell a user
   * with a multi-byte file that they were well inside a limit they had passed.
   */
  it('shows the byte count, counting bytes and not characters', () => {
    openFile('日本語')
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-bytes"]').text()).toContain('9')
  })

  it('disables Save for a clean buffer', () => {
    openFile()
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-save"]').attributes('disabled')).toBeDefined()
  })

  it('enables Save once the buffer is dirty', () => {
    openFile()
    store.fileDirty = true
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-save"]').attributes('disabled')).toBeUndefined()
  })

  it('saves when Save is pressed', async () => {
    openFile()
    store.fileDirty = true
    const wrapper = mount(FileEditor)

    await wrapper.find('[data-testid="file-editor-save"]').trigger('click')

    expect(store.saveFile).toHaveBeenCalledTimes(1)
  })

  /*
   * Over the cap, Save is withheld **and the reason is on screen**. A dead button
   * with no explanation is what the composer's at-limit state already rules out
   * for this project.
   */
  it('withholds Save over the byte cap and says why', () => {
    openFile('a'.repeat(FILE_BYTES_MAX + 1))
    store.fileDirty = true
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="file-editor-bytes"]').text()).toContain('too large')
  })

  /**
   * D21, R4. The window in which a generation's batch and this editor are two
   * writers for one document is exactly the length of a stream, and this closes
   * it at the source rather than detecting the collision afterwards.
   */
  it('is read-only while a stream is open, with a reason on screen', () => {
    openFile()
    store.fileDirty = true
    store.generating = true
    const wrapper = mount(FileEditor)

    // The lock itself is Monaco's `readOnly` option now, asserted in
    // `CodeEditor.spec.ts`; what belongs here is that Save is withheld and that
    // the reason is on screen rather than left to a dead button.
    expect(wrapper.find('[data-testid="file-editor-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="file-editor-readonly"]').text()).toContain('generating')
  })

  it('renders a save failure beside Save', () => {
    openFile()
    store.fileDirty = true
    store.saveError = 'Could not save that file.'
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-error"]').text()).toContain(
      'Could not save that file.',
    )
  })

  /** D22: the discard is announced, because silence is the unacceptable outcome. */
  it('renders the replaced notice', () => {
    openFile()
    store.fileReplaced = true
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-replaced"]').text()).toContain(
      'Replaced by a newer version of this file. Your unsaved changes were discarded.',
    )
  })

  /**
   * AC-31, D22 (Slice 11). A restore replaces buffers too, so the notice may no
   * longer name a generation — nor may it swing the other way and name a
   * restore, since the same notice still covers the generation case. The
   * assertion is case-insensitive because "Generation" reads as fine prose and
   * would otherwise slip past a substring check unnoticed.
   */
  it('names neither a generation nor a restore in the replaced notice', () => {
    openFile()
    store.fileReplaced = true
    const wrapper = mount(FileEditor)

    const notice = wrapper.find('[data-testid="file-editor-replaced"]').text()
    expect(notice).not.toMatch(/generation/i)
    expect(notice).not.toMatch(/restore/i)
  })

  it('renders no replaced notice otherwise', () => {
    openFile()
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-replaced"]').exists()).toBe(false)
  })

  /* A file that would not load is its own state: there is nothing to edit. */
  it('renders a failed read instead of the editor', () => {
    store.selectedPath = 'index.html'
    store.openTabs = ['index.html']
    store.fileError = 'That file no longer exists.'
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-read-error"]').text()).toContain(
      'That file no longer exists.',
    )
    expect(wrapper.find('[data-testid="code-editor"]').exists()).toBe(false)
  })

  /**
   * AC-13's failure half. The tab is kept, so the retry has somewhere to live —
   * and it is `reloadFile()` rather than `selectFile()`, because the tab is
   * already open and `selectFile` on an already-buffered path issues nothing.
   */
  it('offers a Try again on a failed read', async () => {
    store.selectedPath = 'index.html'
    store.openTabs = ['index.html']
    store.fileError = 'Could not load that file.'
    const wrapper = mount(FileEditor)

    await wrapper.find('[data-testid="file-editor-retry"]').trigger('click')

    expect(store.reloadFile).toHaveBeenCalledTimes(1)
  })

  /**
   * A read in flight is a **skeleton over the editor**, not instead of it.
   *
   * `v-else-if` on the loading flag would unmount `CodeEditor` on every open of a
   * file this session has not read — and on the re-read every generation ends
   * with — which tears down the Monaco instance and, with it, the model registry:
   * every open tab's undo history and scroll position, disposed for a fetch that
   * has nothing to do with them. The editor stays; the skeleton covers it.
   */
  it('keeps the editor mounted while a read is in flight', () => {
    store.selectedPath = 'styles.css'
    store.openTabs = ['index.html', 'styles.css']
    store.fileLoading = true
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="code-editor"]').exists()).toBe(true)
    // Nothing to count and nothing to save yet, so the footer stays off screen
    // rather than reporting 0 bytes for a file that is still arriving.
    expect(wrapper.find('[data-testid="file-editor-save"]').exists()).toBe(false)
  })

  /*
   * The byte count reads `editorContent`, which prefers the streaming buffer —
   * so it is the arriving bytes that are counted for a file the server has never
   * stored, not an empty buffer.
   */
  it('counts the streaming buffer rather than the stored one', () => {
    store.selectedPath = 'app.js'
    store.openTabs = ['app.js']
    store.editorContent = 'const a = 1'
    store.generating = true
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="code-editor"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-editor-bytes"]').text()).toContain('11')
  })
})
