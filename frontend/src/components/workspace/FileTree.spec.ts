import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { FileRow } from '@/lib/files'
import type { FileMeta } from '@/lib/filesApi'

/*
 * `reactive`, `ChatPanel.spec.ts`'s pattern: the store this replaces is a Pinia
 * store whose refs are reactive and auto-unwrapped on the store object, and one
 * case here changes the tree after mounting.
 */
const store = reactive({
  files: [] as FileMeta[],
  filesLoading: false,
  filesLoaded: false,
  filesError: null as string | null,
  selectedPath: null as string | null,
  fileTree: [] as FileRow[],
  loadFiles: vi.fn(),
  selectFile: vi.fn(),
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

const FileTree = (await import('./FileTree.vue')).default

/**
 * AC-44 — the file tree's four states, all shipped on a new screen.
 *
 * The component **reflects** decisions rather than making them: the order and the
 * union are `lib/files.ts`'s, tested there, and what is asserted here is that the
 * rendering follows `fileTree` rather than re-deriving it. Error first, for
 * `ProjectsCard`'s reason: a failed first request leaves `filesLoaded` false, so a
 * loading branch ahead of the error would render a skeleton forever.
 */

const meta = (path: string): FileMeta => ({
  path,
  size: 10,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
})

beforeEach(() => {
  vi.clearAllMocks()
  store.files = []
  store.filesLoading = false
  store.filesLoaded = false
  store.filesError = null
  store.selectedPath = null
  store.fileTree = []
})

describe('FileTree', () => {
  /*
   * AC-2 rides along here: the placeholders are the shared `Skeleton`, not
   * hand-rolled pulsing divs — the testid still resolves to the same
   * element, and what it holds carries the primitive's slot attribute.
   */
  it('renders Skeleton placeholders while loading', () => {
    store.filesLoading = true
    const wrapper = mount(FileTree)

    const loading = wrapper.find('[data-testid="file-tree-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.findAll('[data-slot="skeleton"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="file-row"]').exists()).toBe(false)
  })

  /*
   * `filesLoading` alone cannot say "not started": it is still false in the tick
   * between mounting and the request going out, and an empty state shown then
   * reads as a project with no code.
   */
  it('renders the skeleton before the request has even started', () => {
    const wrapper = mount(FileTree)

    expect(wrapper.find('[data-testid="file-tree-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-tree-empty"]').exists()).toBe(false)
  })

  it('renders the empty state once the list has loaded with nothing in it', () => {
    store.filesLoaded = true
    const wrapper = mount(FileTree)

    expect(wrapper.find('[data-testid="file-tree-empty"]').text()).toContain('No files yet')
  })

  /** Error before loading, and before content — a failure must be reachable. */
  it('renders the failure and a Try again that reloads the list', async () => {
    store.filesError = 'Could not load these files.'
    const wrapper = mount(FileTree)

    expect(wrapper.find('[data-testid="file-tree-error"]').text()).toContain(
      'Could not load these files.',
    )
    expect(wrapper.find('[data-testid="file-tree-loading"]').exists()).toBe(false)

    await wrapper.find('[data-testid="file-tree-retry"]').trigger('click')

    expect(store.loadFiles).toHaveBeenCalledTimes(1)
  })

  /*
   * The rows come from `fileTree` in the order it gives them. Asserting the order
   * here as well as in `files.spec.ts` is what stops the template from sorting a
   * second time, slightly differently.
   */
  it('renders one row per file, in the tree’s order', () => {
    store.filesLoaded = true
    store.files = [meta('styles.css'), meta('index.html')]
    store.fileTree = [
      { path: 'index.html', state: 'idle' as const },
      { path: 'styles.css', state: 'idle' as const },
    ]
    const wrapper = mount(FileTree)

    const rows = wrapper.findAll('[data-testid="file-row"]')
    expect(rows.map((row) => row.attributes('data-path'))).toEqual(['index.html', 'styles.css'])
    expect(rows.map((row) => row.text())).toEqual(['index.html', 'styles.css'])
  })

  it('marks the selected row and no other', () => {
    store.filesLoaded = true
    store.selectedPath = 'styles.css'
    store.fileTree = [
      { path: 'index.html', state: 'idle' as const },
      { path: 'styles.css', state: 'idle' as const },
    ]
    const wrapper = mount(FileTree)

    const rows = wrapper.findAll('[data-testid="file-row"]')
    expect(rows.map((row) => row.attributes('data-selected'))).toEqual(['false', 'true'])
  })

  it('selects a file when its row is clicked', async () => {
    store.filesLoaded = true
    store.fileTree = [{ path: 'app.js', state: 'idle' as const }]
    const wrapper = mount(FileTree)

    await wrapper.find('[data-testid="file-row"]').trigger('click')

    expect(store.selectFile).toHaveBeenCalledWith('app.js')
  })

  /** The marker is the whole of "the tree fills in as the reply streams". */
  it.each([
    ['creating', 'Creating'],
    ['rewriting', 'Rewriting'],
    ['editing', 'Editing'],
  ] as const)('marks a %s row with its own word', (state, label) => {
    store.filesLoaded = true
    store.fileTree = [
      { path: 'index.html', state: 'idle' as const },
      { path: 'app.js', state },
    ]
    const wrapper = mount(FileTree)

    const rows = wrapper.findAll('[data-testid="file-row"]')
    expect(rows.map((row) => row.attributes('data-state'))).toEqual(['idle', state])
    expect(rows[1]?.text()).toContain(label)
    expect(rows[0]?.text()).not.toContain('…')
  })

  /** The sections, which are the only hierarchy a flat namespace has. */
  it('renders a heading per kind, with the rows beneath it', () => {
    store.filesLoaded = true
    store.fileTree = [
      { path: 'index.html', state: 'idle' as const },
      { path: 'styles.css', state: 'idle' as const },
      { path: 'app.js', state: 'idle' as const },
    ]
    const wrapper = mount(FileTree)

    const groups = wrapper.findAll('[data-testid="file-group"]')
    expect(groups.map((group) => group.attributes('data-kind'))).toEqual([
      'markup',
      'style',
      'script',
    ])
    expect(groups[0]?.text()).toContain('Markup')
    expect(wrapper.findAll('[data-testid="file-row"]')).toHaveLength(3)
  })

  /** A section folds, and `aria-expanded` says so. */
  it('folds a section from its heading', async () => {
    store.filesLoaded = true
    store.fileTree = [
      { path: 'index.html', state: 'idle' as const },
      { path: 'app.js', state: 'idle' as const },
    ]
    const wrapper = mount(FileTree)

    const markup = wrapper.find('[data-testid="file-group"][data-kind="markup"]')
    expect(markup.attributes('aria-expanded')).toBe('true')

    await markup.trigger('click')

    expect(markup.attributes('aria-expanded')).toBe('false')
    const rows = wrapper.findAll('[data-testid="file-row"]')
    expect(rows.map((row) => row.attributes('data-path'))).toEqual(['app.js'])

    await markup.trigger('click')
    expect(wrapper.findAll('[data-testid="file-row"]')).toHaveLength(2)
  })

  /** Every row carries its kind's glyph, from the one component that decides it. */
  it('gives each row its file icon', () => {
    store.filesLoaded = true
    store.fileTree = [
      { path: 'index.html', state: 'idle' as const },
      { path: 'styles.css', state: 'idle' as const },
    ]
    const wrapper = mount(FileTree)

    const rows = wrapper.findAll('[data-testid="file-row"]')
    expect(rows[0]?.find('svg').classes()).toContain('lucide-code-xml')
    expect(rows[1]?.find('svg').classes()).toContain('lucide-palette')
  })

  /*
   * A generation that streams into an empty project must replace the empty state rather than
   * render beside it — so the branch keys off the tree, not the stored list.
   */
  it('shows streaming rows in a project that has no stored files yet', async () => {
    store.filesLoaded = true
    const wrapper = mount(FileTree)
    expect(wrapper.find('[data-testid="file-tree-empty"]').exists()).toBe(true)

    store.fileTree = [{ path: 'index.html', state: 'editing' as const }]
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="file-tree-empty"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="file-row"]')).toHaveLength(1)
  })
})
