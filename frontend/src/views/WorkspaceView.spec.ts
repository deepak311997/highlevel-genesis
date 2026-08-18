import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RouterLinkStub, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { Project } from '@/lib/projectsApi'

const store = reactive({
  projectId: 'proj-1',
  project: null as Project | null,
  projectLoading: false,
  projectMissing: false,
  projectError: null as string | null,
  messages: [] as unknown[],
  messagesLoading: false,
  messagesLoaded: true,
  messagesError: null as string | null,
  draft: '',
  sending: false,
  sendError: null as string | null,
  generating: false,
  streamingText: '',
  generateError: null as string | null,
  files: [] as unknown[],
  filesLoading: false,
  filesLoaded: true,
  filesError: null as string | null,
  selectedPath: null as string | null,
  openTabs: [] as string[],
  dirtyPaths: [] as string[],
  fileDirty: false,
  fileLoading: false,
  fileError: null as string | null,
  saving: false,
  saveError: null as string | null,
  fileTree: [] as { path: string; writing: boolean }[],
  editorContent: '',
  fileReplaced: false,
  atLimit: false,
  canSend: false,
  open: vi.fn(),
  loadMessages: vi.fn(),
  loadFiles: vi.fn(),
  selectFile: vi.fn(),
  closeTab: vi.fn(),
  editContent: vi.fn(),
  reloadFile: vi.fn(),
  saveFile: vi.fn(),
  send: vi.fn(),
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

/*
 * The HighLevel connection, which the header badge now reads instead of the
 * project's stored `locationId` (see the badge's own tests below). Plain values
 * rather than refs, for the reason `ConnectionPanel.spec.ts` sets out: a Pinia
 * store auto-unwraps its refs, so the component sees booleans.
 */
const hl = reactive({
  loading: false,
  error: null as string | null,
  isConnected: false,
  needsReconnect: false,
  label: null as string | null,
  refresh: vi.fn(),
})

vi.mock('@/stores/hl', () => ({ useHlStore: () => hl }))

const route = reactive({ params: { projectId: 'proj-1' } })

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRoute: () => route }
})

const WorkspaceView = (await import('./WorkspaceView.vue')).default
// The real component, so findAllComponents cannot silently match nothing.
const { ResizablePanel } = await import('@/components/ui/resizable')

/**
 * The workspace route — its three states, and the layout switch.
 *
 * `window.matchMedia` is stubbed for every test, because **jsdom does not implement it at all**:
 * left alone, `useMediaQuery` reports the query unsupported and the tabbed tree renders in every
 * case, so AC-23 and AC-24 would both be asserting the same thing.
 */

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Contact dashboard',
  description: 'Lists and filters contacts',
  locationId: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

/**
 * `CodeEditor: true` is not a convenience.
 *
 * Unstubbed, this suite mounts the real `VueMonacoEditor`, whose `onMounted` calls
 * `loader.init()` — and with nothing having called `loader.config({ monaco })` first, that
 * appends a **CDN `<script>` tag** into jsdom. The editor's own behaviour is
 * `CodeEditor.spec.ts`'s subject; what belongs here is the layout switch.
 */
/**
 * **A real Pinia, because `PreviewPanel` has a real store since Slice 10.**
 *
 * The panel is deliberately *not* stubbed: two of the cases below are about the layout switch
 * putting three panels on screen at once and one behind a tab, so the third panel has to be the
 * third panel. Its store settles to the empty state with no request — this suite's workspace
 * fake reports a loaded, empty file list — so mounting it costs nothing but the plugin.
 */
const MOUNT = {
  global: {
    plugins: [createPinia()],
    stubs: { RouterLink: RouterLinkStub, MessageComposer: true, CodeEditor: true },
  },
}

const SRC = join(import.meta.dirname, '..')

/**
 * Every `.vue` under `src`, so the scan below can look at what is **rendered**.
 *
 * Templates only, not whole files: `sse.ts` and `generateApi.spec.ts` name Slice 6 in doc
 * comments, correctly and permanently, and a scan that could not tell those from a placeholder
 * would either fail forever or have to be weakened until it proved nothing.
 */
function componentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return componentFiles(path)
    return entry.name.endsWith('.vue') ? [path] : []
  })
}

function templateOf(source: string): string {
  return /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? ''
}

const CHAT = '[data-testid="chat-panel"]'
const EDITOR = '[data-testid="editor-panel"]'
const PREVIEW = '[data-testid="preview-panel"]'

/**
 * A controllable `matchMedia`.
 *
 * Every member `useMediaQuery` touches is present, including the deprecated
 * `addListener`/`removeListener` pair it falls back to — a partial stub makes
 * `@vueuse/core` throw rather than report `false`, which reads as a component bug.
 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches,
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

/** Wide: the resizable tree. */
function wide(): void {
  stubMatchMedia(true)
}

/** Narrow: the tabbed tree. */
function narrow(): void {
  stubMatchMedia(false)
}

beforeEach(() => {
  store.projectId = 'proj-1'
  store.project = null
  store.projectLoading = false
  store.projectMissing = false
  store.projectError = null
  store.messages = []
  store.messagesLoading = false
  store.messagesLoaded = true
  store.messagesError = null
  route.params = { projectId: 'proj-1' }
  hl.loading = false
  hl.error = null
  hl.isConnected = false
  hl.needsReconnect = false
  hl.label = null
  vi.clearAllMocks()
  wide()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/*
 * Every mounted view is unmounted after its test. Without this each one stays alive
 * watching the *shared* `route` object, so changing a param in one test re-triggers
 * every view a previous test left mounted — which shows up as `open` having been
 * called one time too many, in a test that looks unrelated.
 */
enableAutoUnmount(afterEach)

describe('WorkspaceView', () => {
  /* One mechanism covers both the first mount and a later param change. */
  it('opens the project from the route as soon as it mounts', async () => {
    mount(WorkspaceView, MOUNT)
    await flushPromises()

    expect(store.open).toHaveBeenCalledWith('proj-1')
    expect(store.open).toHaveBeenCalledTimes(1)
  })

  it('re-opens when the route parameter changes', async () => {
    mount(WorkspaceView, MOUNT)
    await flushPromises()

    route.params = { projectId: 'proj-2' }
    await flushPromises()

    expect(store.open).toHaveBeenCalledTimes(2)
    expect(store.open).toHaveBeenLastCalledWith('proj-2')
  })

  /*
   * AC-20. **No panels**, which is stricter than the PRD's user-flow prose ("a header
   * skeleton and three empty panels") — the AC is the contract, and three empty panels
   * during a load are three things that look broken.
   */
  it('shows the loading state and no panels while the project is in flight', () => {
    store.projectLoading = true

    const wrapper = mount(WorkspaceView, MOUNT)

    expect(wrapper.find('[data-testid="workspace-loading"]').exists()).toBe(true)
    expect(wrapper.find(CHAT).exists()).toBe(false)
    expect(wrapper.find(EDITOR).exists()).toBe(false)
    expect(wrapper.find(PREVIEW).exists()).toBe(false)
  })

  /*
   * The placeholders are the shared `Skeleton`, not hand-rolled pulsing divs — the testid still
   * resolves to the same element, and what it holds carries the primitive's slot attribute.
   */
  it('renders Skeleton placeholders while loading', () => {
    store.projectLoading = true

    const wrapper = mount(WorkspaceView, MOUNT)

    const loading = wrapper.find('[data-testid="workspace-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.findAll('[data-slot="skeleton"]').length).toBeGreaterThan(1)
  })

  /* **The skeleton stands in for the layout it is replacing.** */
  it('lays the loading state out like the three-panel workspace', () => {
    store.projectLoading = true

    const wrapper = mount(WorkspaceView, MOUNT)

    const loading = wrapper.find('[data-testid="workspace-loading"]')
    expect(loading.find('[data-testid="workspace-loading-header"]').exists()).toBe(true)
    expect(loading.find('[data-testid="workspace-loading-chat"]').exists()).toBe(true)
    expect(loading.find('[data-testid="workspace-loading-code"]').exists()).toBe(true)
    expect(loading.find('[data-testid="workspace-loading-preview"]').exists()).toBe(true)

    // The real panels are still not mounted — AC-20.
    expect(wrapper.find(CHAT).exists()).toBe(false)
    expect(wrapper.find(EDITOR).exists()).toBe(false)
    expect(wrapper.find(PREVIEW).exists()).toBe(false)
  })

  /*
   * Narrow shows one panel at a time, so its skeleton draws one panel and the tab strip above
   * it.
   */
  it('draws one panel and a tab strip while loading on a narrow viewport', () => {
    narrow()
    store.projectLoading = true

    const loading = mount(WorkspaceView, MOUNT).find('[data-testid="workspace-loading"]')

    expect(loading.find('[data-testid="workspace-loading-tabs"]').exists()).toBe(true)
    expect(loading.find('[data-testid="workspace-loading-code"]').exists()).toBe(false)
    expect(loading.find('[data-testid="workspace-loading-preview"]').exists()).toBe(false)
  })

  /* A load is a state a screen reader should be told about, not a silent gap. */
  it('announces the load', () => {
    store.projectLoading = true

    const loading = mount(WorkspaceView, MOUNT).find('[data-testid="workspace-loading"]')

    expect(loading.attributes('role')).toBe('status')
    expect(loading.attributes('aria-busy')).toBe('true')
    expect(loading.text()).toContain('Loading')
  })

  /** AC-21. And the transcript is never asked for, which is D25's whole point. */
  it('says the project is gone, links back to the dashboard, and loads no transcript', async () => {
    store.projectMissing = true

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()

    const missing = wrapper.find('[data-testid="workspace-missing"]')
    expect(missing.exists()).toBe(true)
    expect(missing.text()).toContain('That project no longer exists.')
    expect(
      wrapper.findAllComponents(RouterLinkStub).some((link) => link.props('to') === '/dashboard'),
    ).toBe(true)
    expect(store.loadMessages).not.toHaveBeenCalled()
    expect(wrapper.find(CHAT).exists()).toBe(false)
  })

  /** AC-22. The server's message, and a retry that re-issues the project request. */
  it("shows the server's message with a retry that re-opens the project", async () => {
    store.projectError = 'Something went wrong. Check your connection and try again.'

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()
    vi.clearAllMocks()

    const error = wrapper.find('[data-testid="workspace-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('Something went wrong. Check your connection and try again.')

    await wrapper.find('[data-testid="workspace-retry"]').trigger('click')
    expect(store.open).toHaveBeenCalledWith('proj-1')
  })

  /* A 404 is not a failure to retry: it renders the Back link and no retry. */
  it('offers no retry for a project that no longer exists', () => {
    store.projectMissing = true

    const wrapper = mount(WorkspaceView, MOUNT)

    expect(wrapper.find('[data-testid="workspace-retry"]').exists()).toBe(false)
  })

  /** AC-23, and AC-47: the code panel is a screen now, not a label. */
  it('renders all three panels side by side at 1024px and wider', async () => {
    store.project = PROJECT
    wide()

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()

    expect(wrapper.find(CHAT).exists()).toBe(true)
    expect(wrapper.find(EDITOR).exists()).toBe(true)
    expect(wrapper.find(PREVIEW).exists()).toBe(true)
    expect(wrapper.find(`${EDITOR} [data-testid="file-tree"]`).exists()).toBe(true)
    expect(wrapper.find(`${EDITOR} [data-testid="file-editor"]`).exists()).toBe(true)
    /*
     * The preview is a screen rather than a placeholder since Slice 10, so what is asserted here
     * is one of its own states — this suite's workspace fake reports a loaded, empty file list,
     * which is the empty one.
     */
    expect(wrapper.find(`${PREVIEW} [data-testid="preview-empty"]`).exists()).toBe(true)
    // The tabbed tree is not merely hidden — it is not mounted (see the header).
    expect(wrapper.find('[data-testid="workspace-tabs"]').exists()).toBe(false)
  })

  /** AC-24. One panel at a time, Chat first, and Preview selectable. */
  it('renders tabs below 1024px, with Chat selected and Preview reachable', async () => {
    store.project = PROJECT
    narrow()

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()

    expect(wrapper.find('[data-testid="workspace-tabs"]').exists()).toBe(true)
    const labels = wrapper.findAll('[role="tab"]').map((tab) => tab.text())
    expect(labels).toEqual(['Chat', 'Code', 'Preview'])

    expect(wrapper.find(CHAT).exists()).toBe(true)
    expect(wrapper.find(PREVIEW).exists()).toBe(false)

    const preview = wrapper.findAll('[role="tab"]')[2]
    await preview?.trigger('mousedown', { button: 0, ctrlKey: false })
    await flushPromises()

    expect(wrapper.find(PREVIEW).exists()).toBe(true)
    expect(wrapper.find(CHAT).exists()).toBe(false)
  })

  /**
   * AC-47's other half. The two layouts are two component trees, not one tree with CSS on it, so
   * "the code panel is a screen" has to be asserted on both — a placeholder left behind in the
   * tabbed tree is invisible to a test that only ever looks at the wide one.
   */
  it('renders the tree and the editor in the Code tab below 1024px', async () => {
    store.project = PROJECT
    narrow()

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()
    const code = wrapper.findAll('[role="tab"]')[1]
    await code?.trigger('mousedown', { button: 0, ctrlKey: false })
    await flushPromises()

    expect(wrapper.find(`${EDITOR} [data-testid="file-tree"]`).exists()).toBe(true)
    expect(wrapper.find(`${EDITOR} [data-testid="file-editor"]`).exists()).toBe(true)
  })

  /**
   * AC-47's negative half: the placeholder is gone from **the app**, not just from the two trees
   * above.
   */
  it('renders no “arrives in Slice 6” text anywhere in the app', () => {
    const needle = 'Slice ' + '6'
    const offenders = componentFiles(SRC).filter((file) =>
      templateOf(readFileSync(file, 'utf8')).includes(needle),
    )

    expect(offenders).toEqual([])
  })

  /*
   * **Reversed from Slice 4's AC-26**, which read this badge off the project's stored
   * `locationId`.
   */
  it.each([
    ['HighLevel connected', true],
    ['Not connected', false],
  ])('reads %s from the account’s HighLevel connection', async (label, connected) => {
    store.project = { ...PROJECT, locationId: null }
    hl.isConnected = connected

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()

    expect(wrapper.find('[data-testid="workspace-connection"]').text()).toBe(label)
  })

  /* The project that has never seen a connection and the one created after it
   * are the same account, so they read the same. This is the bug the switch
   * above fixes, stated as a test. */
  it('says the same thing for a project with no stored location', async () => {
    hl.isConnected = true
    store.project = { ...PROJECT, locationId: null }

    const withoutLocation = mount(WorkspaceView, MOUNT)
    await flushPromises()

    store.project = { ...PROJECT, locationId: 'loc_123' }
    const withLocation = mount(WorkspaceView, MOUNT)
    await flushPromises()

    expect(withoutLocation.find('[data-testid="workspace-connection"]').text()).toBe(
      withLocation.find('[data-testid="workspace-connection"]').text(),
    )
  })

  /* An expired connection is not a working one — same words, and the same red,
   * as the dashboard's panel. */
  it('reads an expired connection as one to reconnect', async () => {
    hl.isConnected = true
    hl.needsReconnect = true
    store.project = PROJECT

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()

    const badge = wrapper.find('[data-testid="workspace-connection"]')
    expect(badge.text()).toBe('Reconnect needed')
    expect(badge.classes().join(' ')).toContain('text-destructive')
  })

  /* Asked once when the workspace opens: the panel that normally fetches this
   * lives on the dashboard, and a deep link never passes it. */
  it('asks for the connection status when it opens', async () => {
    store.project = PROJECT

    mount(WorkspaceView, MOUNT)
    await flushPromises()

    expect(hl.refresh).toHaveBeenCalled()
  })

  /* The wide layout's split, which is a product decision rather than a cosmetic one. */
  it('opens wide at 25 / 40 / 35, chat to preview', async () => {
    // The three-panel layout is behind a media query, and jsdom reports no
    // matchMedia at all — so without this the wide branch never renders and the
    // assertion below passes vacuously against an empty list.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
    store.project = PROJECT

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()

    const panels = wrapper.findAllComponents(ResizablePanel)
    expect(panels).toHaveLength(3)
    expect(panels.map((panel) => panel.props('defaultSize'))).toEqual([25, 40, 35])
    for (const panel of panels) {
      expect(Number(panel.props('minSize'))).toBeLessThanOrEqual(Number(panel.props('defaultSize')))
    }
  })

  it('shows the project name and a link back to the dashboard in the header', async () => {
    store.project = PROJECT

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()

    expect(wrapper.find('[data-testid="workspace-name"]').text()).toBe('Contact dashboard')
    expect(
      wrapper.findAllComponents(RouterLinkStub).some((link) => link.props('to') === '/dashboard'),
    ).toBe(true)
  })

  /*
   * AC-30's view half. A failed transcript belongs to the chat panel: the header, the
   * badge and the other two panels are unaffected, because the project request
   * succeeded and nothing about it is in doubt.
   */
  it('keeps the header, the badge and the other panels when the transcript fails', async () => {
    store.project = PROJECT
    store.messagesError = 'Could not load the conversation.'

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()

    expect(wrapper.find('[data-testid="workspace-name"]').text()).toBe('Contact dashboard')
    expect(wrapper.find('[data-testid="workspace-connection"]').exists()).toBe(true)
  })

  /* Instrument keeps one blue, and it means link, focus, or the primary action. */
  it('marks a connected location with the semantic colour, not the action colour', async () => {
    hl.isConnected = true
    store.project = { ...PROJECT, locationId: 'loc_123' }

    const wrapper = mount(WorkspaceView, MOUNT)
    await flushPromises()

    const classes = wrapper.find('[data-testid="workspace-connection"]').classes().join(' ')
    expect(classes).toContain('text-good')
    expect(classes).not.toContain('text-destructive')
    expect(classes).not.toContain('bg-primary')
    expect(wrapper.find(EDITOR).exists()).toBe(true)
    expect(wrapper.find(PREVIEW).exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-error"]').exists()).toBe(false)
  })
})
