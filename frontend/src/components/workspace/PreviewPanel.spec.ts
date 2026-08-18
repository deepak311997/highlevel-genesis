import { RouterLinkStub, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { FileContent, FileMeta } from '@/lib/filesApi'
import { usePreviewStore } from '@/stores/preview'

/**
 * The preview panel — its four states, its one iframe, and the banners that make
 * a HighLevel failure visible (F8.3).
 *
 * The **real** preview store is used, with a `createPinia()` per test: every
 * criterion here is a claim about what a person sees, and the panel and its store
 * are one surface as far as those claims go. Mocking the store would leave the
 * two rebuild rules — the only interesting behaviour on this screen — asserted
 * nowhere that renders anything.
 *
 * The **workspace** store is a `reactive` fake, `EditorPanel.spec.ts`'s pattern:
 * the preview reads four fields from a thousand-line store, and standing the real
 * one up would mean standing up a stream and a transcript to move a counter.
 *
 * `fetch` is stubbed rather than `hlProxy`, for the reason `stores/preview.spec.ts`
 * gives: the brokered call has to be the one that would really have gone out.
 */

const getIdToken = vi.hoisted(() => vi.fn())
const currentUser = vi.hoisted(() => ({
  value: null as { getIdToken: () => Promise<string> } | null,
}))

vi.mock('@/lib/firebase', () => ({
  auth: {
    get currentUser() {
      return currentUser.value
    },
  },
}))

vi.mock('@/lib/appCheck', () => ({
  appCheckHeader: () => Promise.resolve({ 'X-Firebase-AppCheck': 'app-check-token' }),
}))

const getFile = vi.hoisted(() => vi.fn())
vi.mock('@/lib/filesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/filesApi')>()),
  getFile,
}))

const workspace = reactive({
  projectId: 'proj-1',
  files: [] as FileMeta[],
  filesLoaded: false,
  generating: false,
  generationsApplied: 0,
  filesRevision: 0,
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => workspace }))

const PreviewPanel = (await import('./PreviewPanel.vue')).default

const INDEX = '<!doctype html><html><head></head><body><h1>Contacts</h1></body></html>'

/** A document referring to a file the project does not hold (AC-6, AC-36). */
const MISSING_REFERENCE =
  '<!doctype html><html><head></head><body><script src="missing.js"></script></body></html>'

function meta(path: string): FileMeta {
  return {
    path,
    size: 12,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  }
}

function storeFiles(files: Record<string, string>): void {
  workspace.files = Object.keys(files).map(meta)
  workspace.filesLoaded = true
  getFile.mockImplementation((_id: string, path: string) => {
    const text = files[path]
    if (text === undefined) return Promise.reject(new Error(`no fixture for ${path}`))
    return Promise.resolve({ ...meta(path), content: text } satisfies FileContent)
  })
}

/**
 * **`attachTo` is load-bearing, not tidiness.**
 *
 * Measured in this repo's own jsdom: a detached `<iframe>` has
 * `contentWindow === null`, and only gains a browsing context once it is in the
 * document. The panel hands that window to the bridge as the frame's identity,
 * so without this every brokered message would be dropped — and the banner cases
 * would fail for a reason that has nothing to do with the panel.
 */
const MOUNT = {
  attachTo: document.body,
  global: { stubs: { RouterLink: RouterLinkStub } },
}

/** Mount, and let the store's `filesLoaded` watcher finish its first build. */
async function panel(): Promise<VueWrapper> {
  const wrapper = mount(PreviewPanel, MOUNT)
  await flushPromises()
  return wrapper
}

let fetchMock: ReturnType<typeof vi.fn>

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/**
 * A message from the rendered document, delivered the way the browser delivers
 * one — on `window`, carrying the frame's own `contentWindow` as its source.
 *
 * Dispatched rather than passed to the store directly, because half of what these
 * cases assert is the panel's wiring: that it listens, that it hands the bridge
 * *this* frame's window, and that it ignores anything else (AC-38).
 */
function postFromFrame(wrapper: VueWrapper, data: unknown): void {
  const frame = wrapper.find('iframe').element as HTMLIFrameElement
  window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }))
}

/**
 * The build's nonce, read from the store rather than scraped out of the
 * document.
 *
 * Pinia hands back the same instance the component resolved, so this is the
 * panel's own store — and the nonce is what identifies a build, so "did it
 * rebuild?" is exactly "did this change?".
 */
function nonceOf(): string {
  return usePreviewStore().nonce ?? ''
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getIdToken.mockResolvedValue('id-token-1')
  currentUser.value = { getIdToken }
  fetchMock = vi.fn().mockResolvedValue(response({ contacts: [] }))
  vi.stubGlobal('fetch', fetchMock)

  workspace.projectId = 'proj-1'
  workspace.files = []
  workspace.filesLoaded = false
  workspace.generating = false
  workspace.generationsApplied = 0
  workspace.filesRevision = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Mounted into the document, so it has to come back out — a leaked iframe from
  // one case is a second frame the next case's `window` listener can hear from.
  document.body.innerHTML = ''
})

describe('PreviewPanel — the four states', () => {
  /** AC-25 — a loading state, and **no** iframe: an empty `srcdoc` would run nothing. */
  it('shows a loading state while the files are being read, and no iframe', async () => {
    workspace.files = [meta('index.html')]
    workspace.filesLoaded = true
    getFile.mockImplementation(() => new Promise<FileContent>(() => {}))

    const wrapper = await panel()

    expect(wrapper.find('[data-testid="preview-loading"]').exists()).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(false)
  })

  it('shows a loading state before the file list has arrived', async () => {
    const wrapper = await panel()

    expect(wrapper.find('[data-testid="preview-loading"]').exists()).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(false)
  })

  /** AC-26 — both causes, each saying something different, neither rendering a frame. */
  it('names the chat box when the project has no files', async () => {
    workspace.filesLoaded = true
    const wrapper = await panel()

    const empty = wrapper.find('[data-testid="preview-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toMatch(/describe|chat|ask/i)
    expect(wrapper.find('iframe').exists()).toBe(false)
  })

  it('says there is no entry point when the project has files but no index.html', async () => {
    storeFiles({ 'app.js': 'console.log(1)' })
    const wrapper = await panel()

    const empty = wrapper.find('[data-testid="preview-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('index.html')
    expect(wrapper.find('iframe').exists()).toBe(false)
  })

  /** AC-27 — the server's own message, and a control that goes back for the file. */
  it('shows the read failure and retries it', async () => {
    storeFiles({ 'index.html': INDEX })
    getFile.mockRejectedValue(new Error('Could not reach the server.'))

    const wrapper = await panel()

    const error = wrapper.find('[data-testid="preview-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('Could not reach the server.')
    expect(wrapper.find('iframe').exists()).toBe(false)

    storeFiles({ 'index.html': INDEX })
    getFile.mockClear()
    await wrapper.find('[data-testid="preview-retry"]').trigger('click')
    await flushPromises()

    expect(getFile).toHaveBeenCalledWith('proj-1', 'index.html')
    expect(wrapper.find('iframe').exists()).toBe(true)
  })

  /**
   * AC-28 — the boundary, asserted as a literal.
   *
   * `allow-same-origin` is the one attribute that would undo the whole design
   * (D9): with it the frame shares our origin, can read the Firebase session out
   * of IndexedDB and call the API as the user. It is asserted absent as well as
   * asserted by equality, because a future edit is far more likely to *add* a
   * token than to rewrite the string.
   */
  it('renders exactly one sandboxed iframe carrying the assembled document', async () => {
    storeFiles({ 'index.html': INDEX })
    const wrapper = await panel()

    const frames = wrapper.findAll('iframe')
    expect(frames).toHaveLength(1)

    const sandbox = frames[0]?.attributes('sandbox')
    expect(sandbox).toBe('allow-scripts allow-forms')
    expect(sandbox).not.toContain('allow-same-origin')

    const srcdoc = frames[0]?.attributes('srcdoc')
    expect(srcdoc).toContain('<!doctype html>')
    expect(srcdoc).toContain('Contacts')
  })
})

describe('PreviewPanel — the controls and the rebuild triggers', () => {
  /** AC-29 — Refresh is a real rebuild: every file re-read, a new nonce. */
  it('re-reads every file and rebuilds under a new nonce when Refresh is pressed', async () => {
    storeFiles({ 'index.html': INDEX, 'app.js': 'hl("GET", "/contacts")' })
    const wrapper = await panel()
    const before = nonceOf()
    getFile.mockClear()

    await wrapper.find('[data-testid="preview-refresh"]').trigger('click')
    await flushPromises()

    expect(getFile).toHaveBeenCalledTimes(2)
    expect(nonceOf()).not.toBe(before)
  })

  /**
   * AC-30 — a generation is already rewriting these files, so rebuilding from
   * them mid-stream would preview a half-written app.
   */
  it('disables Refresh while a generation is in progress', async () => {
    storeFiles({ 'index.html': INDEX })
    const wrapper = await panel()

    expect(wrapper.find('[data-testid="preview-refresh"]').attributes('disabled')).toBeUndefined()

    workspace.generating = true
    await flushPromises()

    expect(wrapper.find('[data-testid="preview-refresh"]').attributes('disabled')).toBeDefined()
  })

  /** AC-31 — **the demo**: nobody presses anything. */
  it('rebuilds by itself when a generation is applied', async () => {
    storeFiles({ 'index.html': INDEX })
    const wrapper = await panel()
    const before = nonceOf()
    getFile.mockClear()

    workspace.generationsApplied += 1
    await flushPromises()

    expect(getFile).toHaveBeenCalled()
    expect(nonceOf()).not.toBe(before)
    expect(wrapper.find('[data-testid="preview-stale"]').exists()).toBe(false)
  })

  /**
   * AC-32 — a save is not a generation (D12).
   *
   * Every rebuild re-runs the app's `hl()` calls against a 100-request/10-second
   * account budget, so a preview that rebuilt on each save would spend the user's
   * CRM allowance on their typing. The hint is the honest middle: never silently
   * stale, and the user decides when to spend.
   */
  it('offers a refresh rather than taking one when the files change under it', async () => {
    storeFiles({ 'index.html': INDEX })
    const wrapper = await panel()
    const before = nonceOf()
    getFile.mockClear()

    workspace.filesRevision += 1
    await flushPromises()

    const hint = wrapper.find('[data-testid="preview-stale"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('Files changed')
    expect(getFile).not.toHaveBeenCalled()
    expect(nonceOf()).toBe(before)

    await wrapper.find('[data-testid="preview-stale-refresh"]').trigger('click')
    await flushPromises()

    expect(getFile).toHaveBeenCalled()
    expect(nonceOf()).not.toBe(before)
    expect(wrapper.find('[data-testid="preview-stale"]').exists()).toBe(false)
  })
})

describe('PreviewPanel — the banners', () => {
  /** One built panel, and the request shape the shim would have posted. */
  async function ready(): Promise<VueWrapper> {
    storeFiles({ 'index.html': INDEX })
    return panel()
  }

  function hlRequest(overrides: Record<string, unknown> = {}): unknown {
    return {
      genesis: 'preview',
      v: 1,
      nonce: nonceOf(),
      id: 'c1',
      kind: 'hl',
      method: 'POST',
      path: '/contacts/search',
      payload: { pageLimit: 20 },
      ...overrides,
    }
  }

  /** AC-33 — HighLevel's own words, on the panel, whether or not the app caught it. */
  it('shows a brokered HighLevel failure', async () => {
    const wrapper = await ready()
    fetchMock.mockResolvedValue(response({ error: 'That search is not allowed.' }, 400))

    postFromFrame(wrapper, hlRequest())
    await flushPromises()

    const banner = wrapper.find('[data-testid="preview-failure"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('That search is not allowed.')
    expect(wrapper.findComponent(RouterLinkStub).exists()).toBe(false)
  })

  /** AC-34 — the two codes a reconnect actually fixes, and only those. */
  it.each(['hl_reconnect_required', 'hl_not_connected'])(
    'offers Reconnect HighLevel for %s',
    async (code) => {
      const wrapper = await ready()
      fetchMock.mockResolvedValue(response({ error: 'Reconnect to continue.', code }, 409))

      postFromFrame(wrapper, hlRequest())
      await flushPromises()

      const link = wrapper.findComponent(RouterLinkStub)
      expect(link.exists()).toBe(true)
      expect(link.props('to')).toBe('/dashboard')
      expect(link.text()).toContain('Reconnect HighLevel')
    },
  )

  it('offers no reconnect for a failure a reconnect would not fix', async () => {
    const wrapper = await ready()
    fetchMock.mockResolvedValue(response({ error: 'No such contact.', code: 'hl_upstream' }, 404))

    postFromFrame(wrapper, hlRequest())
    await flushPromises()

    expect(wrapper.find('[data-testid="preview-failure"]').exists()).toBe(true)
    expect(wrapper.findComponent(RouterLinkStub).exists()).toBe(false)
  })

  /** AC-35 — an uncaught error inside the frame reaches a person. */
  it('shows a runtime error reported by the document', async () => {
    const wrapper = await ready()

    postFromFrame(wrapper, hlRequest({ kind: 'error', message: 'q is not defined' }))
    await flushPromises()

    const banner = wrapper.find('[data-testid="preview-runtime-error"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('q is not defined')
  })

  /** AC-36 — a referenced file the project does not hold, named rather than guessed at. */
  it('names a missing referenced file', async () => {
    storeFiles({
      'index.html': MISSING_REFERENCE,
    })
    const wrapper = await panel()

    const warning = wrapper.find('[data-testid="preview-warning"]')
    expect(warning.exists()).toBe(true)
    expect(warning.text()).toContain('missing.js')
  })

  /** AC-37 — the new document starts from a clean panel. */
  it('clears every banner and the hint when it rebuilds', async () => {
    storeFiles({
      'index.html': MISSING_REFERENCE,
    })
    const wrapper = await panel()
    fetchMock.mockResolvedValue(response({ error: 'Reconnect.', code: 'hl_not_connected' }, 409))

    postFromFrame(wrapper, hlRequest())
    postFromFrame(wrapper, hlRequest({ kind: 'error', message: 'boom' }))
    await flushPromises()

    expect(wrapper.find('[data-testid="preview-warning"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="preview-failure"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="preview-runtime-error"]').exists()).toBe(true)

    storeFiles({ 'index.html': INDEX })
    workspace.filesRevision += 1
    await flushPromises()
    expect(wrapper.find('[data-testid="preview-stale"]').exists()).toBe(true)

    await wrapper.find('[data-testid="preview-refresh"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="preview-warning"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preview-failure"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preview-runtime-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preview-stale"]').exists()).toBe(false)
  })

  /**
   * AC-38 — the first half of the acceptance gate.
   *
   * An opaque origin arrives as the string `"null"`, which every other sandboxed
   * frame on the page also has, so origin identifies nothing and `event.source`
   * has to. A message from anywhere else is dropped in silence: no banner, no
   * HighLevel call, no reply.
   */
  it('ignores a message that did not come from its own frame', async () => {
    const wrapper = await ready()
    const request = hlRequest()

    window.dispatchEvent(new MessageEvent('message', { data: request, source: window }))
    await flushPromises()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="preview-failure"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preview-runtime-error"]').exists()).toBe(false)
  })

  /**
   * The listener is the **window's**, so it has to come off when the panel goes.
   *
   * Asserted against `removeEventListener` rather than by dispatching after the
   * unmount, and the difference is the whole point: once the panel is gone its
   * frame is gone too, so a late message is dropped by the bridge's null-frame
   * guard whether or not the listener is still installed. A dispatch-based test
   * therefore passes over a real leak — measured, by deleting the
   * `onBeforeUnmount` body and watching it stay green.
   *
   * The `lg` breakpoint swaps one component tree for another, so this unmounts
   * on every window resize across it; a listener left behind each time is a
   * leak with a counter on it.
   */
  it('takes its message listener off the window when it is unmounted', async () => {
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const wrapper = await ready()

    const installed = added.mock.calls.find(([type]) => type === 'message')?.[1]
    expect(installed).toBeInstanceOf(Function)

    wrapper.unmount()

    expect(removed).toHaveBeenCalledWith('message', installed)
    added.mockRestore()
    removed.mockRestore()
  })

  /**
   * D3's stale-document race, closed a second time.
   *
   * Setting `srcdoc` again *is* a navigation, and a `WindowProxy` survives one —
   * so the previous document's window would still be `===` the frame's
   * `contentWindow`, and only the nonce would be telling the two apart. A
   * replaced element discards the old browsing context outright instead.
   *
   * **The outcome is asserted, not either mechanism that produces it**, and both
   * are real: `build()` passes through `'loading'`, which unmounts the frame, and
   * the `:key` on the nonce would replace it even if it did not. Measured —
   * removing the `:key` leaves this green, because the loading transition alone
   * is enough today. That is exactly why the assertion is on the element's
   * identity: it keeps holding whichever of the two a later refactor removes.
   */
  it('replaces the frame element on a rebuild rather than renavigating it', async () => {
    const wrapper = await ready()
    const first = wrapper.find('iframe').element

    await wrapper.find('[data-testid="preview-refresh"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('iframe').element).not.toBe(first)
  })
})
