import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

import type { FileContent, FileMeta } from '@/lib/filesApi'

/**
 * The preview's lifecycle, and the half of the broker that holds a credential.
 *
 * Two things are deliberately **not** mocked, because two of the criteria here
 * are claims about what does and does not go on the wire. `fetch` is what is
 * stubbed rather than `hlProxy`, so AC-20 — "a path outside the grammar makes no
 * network request" — is asserted against the request that would actually have
 * been issued; and `handlePreviewMessage` is the real bridge, so the acceptance
 * gate the store depends on is the one that runs.
 *
 * The workspace store *is* mocked, as a `reactive` fake. It is a thousand lines
 * with a stream, a transcript and twenty files behind it, and everything this
 * store reads from it is four fields — the project id, the file list, and the two
 * counters Slice 10 added to it (D12).
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

const workspace = reactive({
  projectId: 'proj-1',
  files: [] as FileMeta[],
  filesLoaded: false,
  generationsApplied: 0,
  filesRevision: 0,
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
 * Typed to its real signature rather than left as the default `vi.fn()`, whose
 * procedure type returns `void` — a `mockImplementation` that hands back a
 * pending promise (the in-flight case below) is then an error rather than the
 * point.
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
 * `event.source` identity is the first half of the acceptance gate, so the same
 * object has to be both the `source` of the event and the `frame` handed to
 * `handleMessage`. A `postMessage` spy is the whole of what the store needs from
 * a `Window`.
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
   * Files with no entry point is a *different* empty state from no files at all,
   * and the panel says something different for each. Answered before any read,
   * because the paths alone settle it.
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

  /** AC-37, at the store: a rebuild starts from a clean slate. */
  it('clears the warnings, the failure and the runtime error before it starts', async () => {
    storeFiles({ 'index.html': INDEX })
    const preview = usePreviewStore()
    await preview.build()

    const frame = fakeFrame()
    preview.failure = { message: 'Nope.', status: 500, code: null }
    preview.runtimeError = 'boom'
    preview.warnings = ['missing.js']

    await preview.build()

    expect(preview.failure).toBeNull()
    expect(preview.runtimeError).toBeNull()
    expect(preview.warnings).toEqual([])
    expect(frame.postMessage).not.toHaveBeenCalled()
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

  it('is not stale before anything has been built', () => {
    const preview = usePreviewStore()
    workspace.filesRevision += 1

    expect(preview.stale).toBe(false)
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
