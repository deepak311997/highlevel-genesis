import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

import type { FileContent, FileMeta } from '@/lib/filesApi'
import { HL_CALL_LIMIT } from '@/lib/previewShim'

/**
 * The preview's lifecycle, and the half of the broker that holds a credential.
 *
 * Two things are deliberately **not** mocked, because two of the criteria here are claims about
 * what does and does not go on the wire. `fetch` is what is stubbed rather than `hlProxy`, so
 * AC-20 — "a path outside the grammar makes no network request" — is asserted against the
 * request that would actually have been issued; and `handlePreviewMessage` is the real bridge,
 * so the acceptance gate the store depends on is the one that runs.
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

function meta(path: string): FileMeta {
  return {
    path,
    size: 10,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  }
}

const loadFiles = vi.fn()

const workspace = reactive({
  projectId: 'proj-1',
  files: [] as FileMeta[],
  filesLoaded: false,
  filesError: null as string | null,
  generationsApplied: 0,
  filesRevision: 0,
  loadFiles,
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => workspace }))

const { usePreviewStore } = await import('./preview')

/** What `getFile` answers with, by path. */
function content(path: string, text: string): FileContent {
  return { ...meta(path), content: text }
}

const INDEX = '<!doctype html><html><head></head><body><h1>Hi</h1></body></html>'

function storeFiles(files: Record<string, string>): void {
  workspace.files = Object.keys(files).map(meta)
  getFile.mockImplementation((_projectId: string, path: string) => {
    const text = files[path]
    if (text === undefined) return Promise.reject(new Error(`no fixture for ${path}`))
    return Promise.resolve(content(path, text))
  })
}

/*
 * Typed to its real signature rather than left as the default `vi.fn()`, whose procedure type
 * returns `void` — a `mockImplementation` that hands back a pending promise (the in-flight case
 * below) is then an error rather than the point.
 */
let fetchMock: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Response>>>

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/**
 * A frame the host will accept messages from.
 *
 * `event.source` identity is the first half of the acceptance gate, so the same object has to be
 * both the `source` of the event and the `frame` handed to `handleMessage`. A `postMessage` spy
 * is the whole of what the store needs from a `Window`.
 */
function fakeFrame(): { postMessage: ReturnType<typeof vi.fn> } {
  return { postMessage: vi.fn() }
}

function messageFrom(frame: unknown, data: unknown): MessageEvent {
  return { data, source: frame } as unknown as MessageEvent
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
  workspace.filesError = null
  workspace.generationsApplied = 0
  workspace.filesRevision = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('preview store — the build lifecycle', () => {
  it('reports an empty project rather than building an empty document', async () => {
    const preview = usePreviewStore()
    await preview.build()

    expect(preview.state).toBe('empty')
    expect(preview.emptyReason).toBe('no_files')
    expect(preview.document).toBeNull()
    expect(getFile).not.toHaveBeenCalled()
  })

  /**
   * Files with no entry point is a *different* empty state from no files at all, and the panel
   * says something different for each.
   */
  it('reports files with no entry point without reading any of them', async () => {
    storeFiles({ 'app.js': 'console.log(1)' })
    const preview = usePreviewStore()
    await preview.build()

    expect(preview.state).toBe('empty')
    expect(preview.emptyReason).toBe('no_entry_point')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('reads every listed file in parallel and lands on a document', async () => {
    storeFiles({ 'index.html': INDEX, 'app.js': 'hl("GET", "/contacts")' })
    const preview = usePreviewStore()
    await preview.build()

    expect(getFile).toHaveBeenCalledTimes(2)
    expect(getFile).toHaveBeenCalledWith('proj-1', 'index.html')
    expect(getFile).toHaveBeenCalledWith('proj-1', 'app.js')
    expect(preview.state).toBe('ready')
    expect(preview.document).toContain('<!doctype html>')
    expect(preview.nonce).toEqual(expect.any(String))
  })

  it('shows a loading state while the reads are in flight', async () => {
    storeFiles({ 'index.html': INDEX })
    let release = (): void => {}
    getFile.mockImplementation(
      () =>
        new Promise<FileContent>((resolve) => {
          release = () => {
            resolve(content('index.html', INDEX))
          }
        }),
    )

    const preview = usePreviewStore()
    const building = preview.build()
    await nextTick()
    expect(preview.state).toBe('loading')
    expect(preview.document).toBeNull()

    release()
    await building
    expect(preview.state).toBe('ready')
  })

  it('carries the server message when a read fails, and recovers on a second build', async () => {
    storeFiles({ 'index.html': INDEX })
    getFile.mockRejectedValueOnce(new Error('That file no longer exists.'))

    const preview = usePreviewStore()
    await preview.build()

    expect(preview.state).toBe('error')
    expect(preview.error).toBe('That file no longer exists.')
    expect(preview.document).toBeNull()

    storeFiles({ 'index.html': INDEX })
    await preview.build()
    expect(preview.state).toBe('ready')
    expect(preview.error).toBeNull()
  })

  /**
   * A fresh nonce per build is what tells the previous document's late reply from
   * the current one's (D3). Two builds of the *same* files must therefore differ.
   */
  it('builds under a new nonce every time', async () => {
    storeFiles({ 'index.html': INDEX })
    const preview = usePreviewStore()
    await preview.build()
    const first = preview.nonce

    await preview.build()

    expect(preview.nonce).not.toBe(first)
    expect(preview.document).not.toBe(null)
    expect(preview.document).not.toContain(String(first))
  })

  /**
   * AC-37, at the store: a rebuild starts from a clean slate — and *starts* is the word under
   * test.
   */
  it('clears the warnings, the failure and the runtime error before it starts', async () => {
    storeFiles({ 'index.html': INDEX })
    const preview = usePreviewStore()
    await preview.build()

    preview.failure = { message: 'Nope.', status: 500, code: null }
    preview.runtimeError = 'boom'
    preview.warnings = ['missing.js']

    let release = (): void => {}
    getFile.mockImplementation(
      () =>
        new Promise<FileContent>((resolve) => {
          release = () => {
            resolve(content('index.html', INDEX))
          }
        }),
    )

    const building = preview.build()
    await nextTick()

    // Mid-build: the reads have not landed, so no new document exists yet — and
    // the last one's complaints are already gone.
    expect(preview.state).toBe('loading')
    expect(preview.failure).toBeNull()
    expect(preview.runtimeError).toBeNull()
    expect(preview.warnings).toEqual([])

    release()
    await building

    expect(preview.state).toBe('ready')
    expect(preview.failure).toBeNull()
  })

  it('does not write state for a build whose reads land after the project changed', async () => {
    storeFiles({ 'index.html': INDEX })
    let release = (): void => {}
    getFile.mockImplementation(
      () =>
        new Promise<FileContent>((resolve) => {
          release = () => {
            resolve(content('index.html', INDEX))
          }
        }),
    )

    const preview = usePreviewStore()
    const building = preview.build()
    await nextTick()

    preview.reset()
    release()
    await building

    expect(preview.state).toBe('idle')
    expect(preview.document).toBeNull()
  })

  it('rebuilds by itself when a generation is applied, and not when only a save moved', async () => {
    storeFiles({ 'index.html': INDEX })
    const preview = usePreviewStore()
    await preview.build()
    const built = preview.nonce
    getFile.mockClear()

    workspace.generationsApplied += 1
    await nextTick()
    await vi.waitFor(() => {
      expect(preview.nonce).not.toBe(built)
    })
    expect(getFile).toHaveBeenCalled()

    const afterGeneration = preview.nonce
    getFile.mockClear()
    workspace.filesRevision += 1
    await nextTick()

    expect(getFile).not.toHaveBeenCalled()
    expect(preview.nonce).toBe(afterGeneration)
    expect(preview.stale).toBe(true)
  })

  /** A file list that never arrived is an error, not an empty project. */
  it('reports a failed file list as an error rather than an empty project', async () => {
    const preview = usePreviewStore()
    workspace.filesError = 'Could not load these files.'
    await nextTick()

    expect(preview.state).toBe('error')
    expect(preview.error).toBe('Could not load these files.')

    // And a rebuild asked for while the list is still missing says the same
    // thing rather than falling through to the empty state.
    await preview.build()
    expect(preview.state).toBe('error')
    expect(preview.emptyReason).toBeNull()
  })

  it('builds once the file list arrives on a retry', async () => {
    const preview = usePreviewStore()
    workspace.filesError = 'Could not load these files.'
    await nextTick()
    expect(preview.state).toBe('error')

    // What `loadFiles` does on a retry: clear the failure, then settle the list.
    workspace.filesError = null
    await nextTick()
    storeFiles({ 'index.html': INDEX })
    workspace.filesLoaded = true

    await vi.waitFor(() => {
      expect(preview.state).toBe('ready')
    })
  })

  /**
   * The auto-rebuild is not stale the moment it lands — whichever order the workspace happens to
   * move its two counters in.
   */
  it.each([
    ['revision first', ['filesRevision', 'generationsApplied']],
    ['generation first', ['generationsApplied', 'filesRevision']],
  ] as const)('is not stale after an automatic rebuild — %s', async (_name, order) => {
    storeFiles({ 'index.html': INDEX })
    const preview = usePreviewStore()
    await preview.build()
    const before = preview.nonce

    for (const counter of order) workspace[counter] += 1

    await vi.waitFor(() => {
      expect(preview.nonce).not.toBe(before)
    })
    expect(preview.state).toBe('ready')
    expect(preview.stale).toBe(false)
  })

  it('is not stale before anything has been built', () => {
    const preview = usePreviewStore()
    workspace.filesRevision += 1

    expect(preview.stale).toBe(false)
  })

  /** Re-opening the *same* project must not strand the panel on its empty state. */
  it('rebuilds after the same project is re-opened and its file list is refetched', async () => {
    const preview = usePreviewStore()
    storeFiles({ 'index.html': INDEX })
    workspace.filesLoaded = true
    await vi.waitFor(() => {
      expect(preview.state).toBe('ready')
    })

    // A generation lands, so the counter this store watches is no longer zero.
    workspace.generationsApplied += 1
    workspace.filesRevision += 1
    await vi.waitFor(() => {
      expect(preview.state).toBe('ready')
    })

    // `open` on the same id: `clearFileState`, then the refetch.
    workspace.files = []
    workspace.filesLoaded = false
    workspace.generationsApplied = 0
    workspace.filesRevision = 0
    await nextTick()

    storeFiles({ 'index.html': INDEX })
    workspace.filesLoaded = true
    await vi.waitFor(() => {
      expect(preview.state).toBe('ready')
    })
    expect(preview.document).toContain('Hi')

    // And the revision this build was made at is the refetched one, so the very
    // next save still raises the hint rather than being swallowed by a
    // `builtRevision` left over from before the reset.
    workspace.filesRevision += 1
    expect(preview.stale).toBe(true)
  })

  /** The counter reset above, on its own: a drop is not a generation. */
  it('does not rebuild when the generation counter is reset rather than advanced', async () => {
    storeFiles({ 'index.html': INDEX })
    const preview = usePreviewStore()
    await preview.build()

    const before = preview.nonce
    workspace.generationsApplied = 3
    await vi.waitFor(() => {
      expect(preview.nonce).not.toBe(before)
    })
    const built = preview.nonce
    getFile.mockClear()

    workspace.generationsApplied = 0
    await nextTick()

    expect(getFile).not.toHaveBeenCalled()
    expect(preview.nonce).toBe(built)
  })
})

describe('preview store — the broker', () => {
  /** A built store, its nonce, and a frame the gate will accept. */
  async function built(): Promise<{
    preview: ReturnType<typeof usePreviewStore>
    frame: ReturnType<typeof fakeFrame>
    nonce: string
  }> {
    storeFiles({ 'index.html': INDEX })
    const preview = usePreviewStore()
    await preview.build()
    return { preview, frame: fakeFrame(), nonce: preview.nonce ?? '' }
  }

  function hlRequest(nonce: string, overrides: Record<string, unknown> = {}): unknown {
    return {
      genesis: 'preview',
      v: 1,
      nonce,
      id: 'c1',
      kind: 'hl',
      method: 'POST',
      path: '/contacts/search',
      payload: { pageLimit: 20 },
      ...overrides,
    }
  }

  /** AC-19 — the whole point: the parent makes the call the sandbox cannot. */
  it('forwards an accepted request through the proxy and posts the body back', async () => {
    const { preview, frame, nonce } = await built()
    fetchMock.mockResolvedValue(response({ contacts: [{ id: 'c-1' }] }))

    await preview.handleMessage(messageFrom(frame, hlRequest(nonce)), frame as unknown as Window)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/hl/proxy/contacts/search')
    expect(init.method).toBe('POST')
    expect(JSON.parse(typeof init.body === 'string' ? init.body : '')).toEqual({
      pageLimit: 20,
    })

    expect(frame.postMessage).toHaveBeenCalledTimes(1)
    const [reply, targetOrigin] = frame.postMessage.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ]
    expect(reply).toEqual({
      genesis: 'preview-host',
      v: 1,
      nonce,
      id: 'c1',
      ok: true,
      data: { contacts: [{ id: 'c-1' }] },
    })
    // D3/R6 — an opaque origin has no name, which is why a reply carries no
    // credential of any kind.
    expect(targetOrigin).toBe('*')
  })

  /**
   * AC-20 — the confused-deputy case, and the reason `fetch` rather than
   * `hlProxy` is what this suite stubs: `/api/hl/proxy` + `/../../projects`
   * resolves to `/api/projects`, carrying this user's ID token.
   */
  it('refuses a path outside the grammar without issuing a request', async () => {
    const { preview, frame, nonce } = await built()

    await preview.handleMessage(
      messageFrom(frame, hlRequest(nonce, { path: '/../../projects' })),
      frame as unknown as Window,
    )

    expect(fetchMock).not.toHaveBeenCalled()
    const [reply] = frame.postMessage.mock.calls[0] as [Record<string, unknown>]
    expect(reply).toMatchObject({ ok: false, id: 'c1' })
  })

  /** AC-21 — the envelope's own words reach both the frame and the panel. */
  it('carries the message, status and code of a failed proxy call', async () => {
    const { preview, frame, nonce } = await built()
    fetchMock.mockResolvedValue(
      response({ error: 'Your HighLevel connection expired.', code: 'hl_reconnect_required' }, 409),
    )

    await preview.handleMessage(messageFrom(frame, hlRequest(nonce)), frame as unknown as Window)

    const [reply] = frame.postMessage.mock.calls[0] as [{ error: Record<string, unknown> }]
    expect(reply.error).toEqual({
      message: 'Your HighLevel connection expired.',
      status: 409,
      code: 'hl_reconnect_required',
    })
    expect(preview.failure).toEqual({
      message: 'Your HighLevel connection expired.',
      status: 409,
      code: 'hl_reconnect_required',
    })
    expect(preview.reconnectable).toBe(true)
  })

  /** D15's ceiling, enforced where it cannot be walked around. */
  it('stops brokering past the call limit even when the shim is bypassed', async () => {
    const { preview, frame, nonce } = await built()

    for (let i = 0; i < HL_CALL_LIMIT; i += 1) {
      await preview.handleMessage(
        messageFrom(frame, hlRequest(nonce, { id: `c${String(i)}` })),
        frame as unknown as Window,
      )
    }
    expect(fetchMock).toHaveBeenCalledTimes(HL_CALL_LIMIT)

    await preview.handleMessage(
      messageFrom(frame, hlRequest(nonce, { id: 'over' })),
      frame as unknown as Window,
    )

    expect(fetchMock).toHaveBeenCalledTimes(HL_CALL_LIMIT)
    const calls = frame.postMessage.mock.calls as [
      { id: string; ok: boolean; error?: { message: string } },
    ][]
    const last = calls[calls.length - 1]?.[0]
    expect(last).toMatchObject({ id: 'over', ok: false })
    expect(last?.error?.message).toContain(String(HL_CALL_LIMIT))
    // The panel says so too, rather than the preview simply going quiet.
    expect(preview.failure?.message).toContain(String(HL_CALL_LIMIT))
  })

  /** A new document is a new budget — the limit is per build, as D15 says. */
  it('gives a rebuilt document a fresh call budget', async () => {
    const { preview, frame, nonce } = await built()
    for (let i = 0; i <= HL_CALL_LIMIT; i += 1) {
      await preview.handleMessage(
        messageFrom(frame, hlRequest(nonce, { id: `c${String(i)}` })),
        frame as unknown as Window,
      )
    }
    expect(fetchMock).toHaveBeenCalledTimes(HL_CALL_LIMIT)

    await preview.build()
    fetchMock.mockClear()

    await preview.handleMessage(
      messageFrom(frame, hlRequest(preview.nonce ?? '')),
      frame as unknown as Window,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('offers no reconnect for a failure that reconnecting would not fix', async () => {
    const { preview, frame, nonce } = await built()
    fetchMock.mockResolvedValue(
      response({ error: 'That contact is gone.', code: 'hl_upstream' }, 404),
    )

    await preview.handleMessage(messageFrom(frame, hlRequest(nonce)), frame as unknown as Window)

    expect(preview.failure?.code).toBe('hl_upstream')
    expect(preview.reconnectable).toBe(false)
  })

  it('offers reconnect when there is no connection at all', async () => {
    const { preview, frame, nonce } = await built()
    fetchMock.mockResolvedValue(
      response({ error: 'Connect HighLevel to use this app.', code: 'hl_not_connected' }, 409),
    )

    await preview.handleMessage(messageFrom(frame, hlRequest(nonce)), frame as unknown as Window)

    expect(preview.reconnectable).toBe(true)
  })

  /**
   * The post-await nonce check, on top of the pre-await one. A rebuild while a
   * call is in flight must not raise a banner over the *new* document, nor post a
   * reply into a document that has been replaced — AC-37 and D3's stale-document
   * race, closed on the way back as well as on the way out.
   */
  it('posts nothing when the build changed while the call was in flight', async () => {
    const { preview, frame, nonce } = await built()
    let release = (): void => {}
    fetchMock.mockImplementation(() => {
      return new Promise<Response>((resolve) => {
        release = () => {
          resolve(response({ contacts: [] }))
        }
      })
    })

    const handling = preview.handleMessage(
      messageFrom(frame, hlRequest(nonce)),
      frame as unknown as Window,
    )
    await nextTick()

    storeFiles({ 'index.html': INDEX })
    await preview.build()
    release()
    await handling

    expect(frame.postMessage).not.toHaveBeenCalled()
    expect(preview.failure).toBeNull()
  })

  it('routes an error report from the frame to the runtime banner', async () => {
    const { preview, frame, nonce } = await built()

    await preview.handleMessage(
      messageFrom(frame, { genesis: 'preview', v: 1, nonce, kind: 'error', message: 'boom' }),
      frame as unknown as Window,
    )

    expect(preview.runtimeError).toBe('boom')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(frame.postMessage).not.toHaveBeenCalled()
  })

  it('ignores a message that arrives before anything has been built', async () => {
    const preview = usePreviewStore()
    const frame = fakeFrame()

    await preview.handleMessage(
      messageFrom(frame, hlRequest('whatever')),
      frame as unknown as Window,
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(frame.postMessage).not.toHaveBeenCalled()
  })
})
