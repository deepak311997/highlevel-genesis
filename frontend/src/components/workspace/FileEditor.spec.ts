import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { FILE_BYTES_MAX } from '@/lib/filesApi'

const store = reactive({
  selectedPath: null as string | null,
  editorContent: '',
  fileContent: '',
  fileDirty: false,
  fileLoading: false,
  fileError: null as string | null,
  saving: false,
  saveError: null as string | null,
  fileReplaced: false,
  generating: false,
  saveFile: vi.fn(),
  editContent: vi.fn((text: string) => {
    store.editorContent = text
  }),
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

const FileEditor = (await import('./FileEditor.vue')).default

/**
 * AC-45 — the editor. A textarea in this slice; Monaco replaces it in Slice 7,
 * which is why every rule lives in the store and this component only reflects it.
 *
 * Two of these cases are the visible half of R4. The panel is **read-only while a
 * stream is open** (D21) — the one window in which a generation's batch and this
 * editor are two writers for one document — and a buffer replaced by a generation
 * says so rather than vanishing (D22).
 */

beforeEach(() => {
  vi.clearAllMocks()
  store.selectedPath = null
  store.editorContent = ''
  store.fileContent = ''
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
  store.fileContent = content
  store.editorContent = content
}

describe('FileEditor', () => {
  it('renders the empty state with nothing selected', () => {
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-empty"]').text()).toContain('Select a file')
    expect(wrapper.find('[data-testid="file-editor-input"]').exists()).toBe(false)
  })

  it('puts the file’s content in the textarea', () => {
    openFile()
    const wrapper = mount(FileEditor)

    expect(
      wrapper.find<HTMLTextAreaElement>('[data-testid="file-editor-input"]').element.value,
    ).toBe('<h1>Contacts</h1>\n')
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

    expect(wrapper.find('[data-testid="file-editor-input"]').attributes('disabled')).toBeDefined()
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
      'Replaced by the latest generation',
    )
  })

  it('renders no replaced notice otherwise', () => {
    openFile()
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-replaced"]').exists()).toBe(false)
  })

  /* A file that would not load is its own state: there is nothing to edit. */
  it('renders a failed read instead of the textarea', () => {
    store.selectedPath = 'index.html'
    store.fileError = 'That file no longer exists.'
    const wrapper = mount(FileEditor)

    expect(wrapper.find('[data-testid="file-editor-read-error"]').text()).toContain(
      'That file no longer exists.',
    )
    expect(wrapper.find('[data-testid="file-editor-input"]').exists()).toBe(false)
  })

  /**
   * Editing writes through to the store's **active buffer** — the panel holds no
   * draft, and since Slice 7 it does not reach into a ref either: `editContent`
   * is the action, because the buffer it writes depends on which tab is active.
   */
  it('writes edits back to the store', async () => {
    openFile()
    const wrapper = mount(FileEditor)

    await wrapper.find('[data-testid="file-editor-input"]').setValue('<h1>People</h1>\n')

    expect(store.editContent).toHaveBeenCalledWith('<h1>People</h1>\n')
  })

  /*
   * While a file is streaming, `editorContent` is the arriving bytes rather than
   * `fileContent` — which is empty for a file that has never been stored.
   */
  it('shows the streaming buffer rather than the stored one', () => {
    store.selectedPath = 'app.js'
    store.fileContent = ''
    store.editorContent = 'const a = 1'
    store.generating = true
    const wrapper = mount(FileEditor)

    expect(
      wrapper.find<HTMLTextAreaElement>('[data-testid="file-editor-input"]').element.value,
    ).toBe('const a = 1')
  })
})
