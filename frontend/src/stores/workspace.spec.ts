import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { useWorkspaceStore } = await import('./workspace')

/**
 * One project, its transcript, and the draft — one store, because they share one
 * lifecycle (D24). Same `projectId`, loaded together, reset together; two stores
 * that must be reset in lockstep is a bug with a countdown on it.
 *
 * Deliberately **not** mocked at the client boundary: `fetch` is what is stubbed,
 * so AC-36 — "every request carries an Authorization and an App Check header" —
 * is asserted against the request that would actually go on the wire.
 * `projects.spec.ts`'s pattern.
 *
 * Two properties here are decisions rather than mechanics, and each has its own
 * case. **The load is sequential** (D25): a 404 on the project issues no
 * transcript request at all, so the view has one answer to render rather than two
 * competing ones. **A send appends** (D12) and issues no `GET`: a transcript only
 * ever appends, so the pair the server returned is by construction its two newest
 * members — appending *is* the server's order, not an approximation of it, which
 * is what separates this from the splice D14 rejected for the projects list.
 */

const PROJECT = {
  id: 'proj-1',
  name: 'Contact dashboard',
  description: null,
  locationId: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

/** A second project, so a stale response has something newer to overwrite. */
const OTHER_PROJECT = { ...PROJECT, id: 'proj-2', name: 'Appointment board' }

const USER_MESSAGE = {
  id: 'msg-1',
  role: 'user' as const,
  content: 'build a contact dashboard',
  createdAt: '2026-08-17T09:00:00.000Z',
  truncated: false,
}

const ASSISTANT_MESSAGE = {
  id: 'msg-2',
  role: 'assistant' as const,
  content: 'Here is a contact dashboard',
  createdAt: '2026-08-17T09:00:00.000Z',
  truncated: false,
}

let fetchMock: ReturnType<typeof vi.fn>

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/** Every request the store made, as `METHOD path` — order included. */
function requests(): string[] {
  return fetchMock.mock.calls.map((call) => {
    const init = (call[1] ?? {}) as RequestInit
    return `${init.method ?? 'GET'} ${new URL(String(call[0]), 'http://test.local').pathname}`
  })
}

function headersOf(index = 0): Record<string, string> {
  const init = (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit
  return init.headers as Record<string, string>
}

/**
 * A promise this test resolves by hand, so a request can be left in flight.
 *
 * The staleness cases below all need two requests alive at once and resolved in
 * the wrong order, which `mockResolvedValueOnce` cannot express on its own.
 */
function deferred(): { promise: Promise<Response>; settle: (value: Response) => void } {
  let settle!: (value: Response) => void
  const promise = new Promise<Response>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

const INDEX_FILE = {
  path: 'index.html',
  size: 24,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

const APP_FILE = { ...INDEX_FILE, path: 'app.js', size: 11 }

/** The happy path: the project resolves, then an empty transcript, then no files. */
function respondOpenOk(): void {
  fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
  fetchMock.mockResolvedValueOnce(response({ messages: [] }))
  fetchMock.mockResolvedValueOnce(response({ files: [] }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getIdToken.mockResolvedValue('id-token-1')
  currentUser.value = { getIdToken }
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('open', () => {
  /** D25, and AC-36's header half on both requests. */
  it('fetches the project and then the transcript, in that order', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()

    await store.open('proj-1')

    expect(requests()).toEqual([
      'GET /api/projects/proj-1',
      'GET /api/projects/proj-1/messages',
      'GET /api/projects/proj-1/files',
    ])
    for (const index of [0, 1, 2]) {
      expect(headersOf(index)['Authorization']).toBe('Bearer id-token-1')
      expect(headersOf(index)['X-Firebase-AppCheck']).toBe('app-check-token')
    }
  })

  it('fills the project and clears its loading flag', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()

    await store.open('proj-1')

    expect(store.projectId).toBe('proj-1')
    expect(store.project).toEqual(PROJECT)
    expect(store.projectLoading).toBe(false)
    expect(store.projectMissing).toBe(false)
    expect(store.projectError).toBeNull()
    expect(store.messagesLoaded).toBe(true)
  })

  it('is loading while the project request is in flight', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()

    const pending = store.open('proj-1')
    expect(store.projectLoading).toBe(true)
    await pending
  })

  /*
   * AC-21's store half, and the reason D25 chose sequence over parallelism. The
   * second assertion is the one that matters: fetched in parallel a deleted
   * project produces two 404s and the view has to decide which one it is
   * rendering, and a transcript that cannot exist is requested anyway.
   */
  it('records a 404 as missing and issues no transcript request', async () => {
    fetchMock.mockResolvedValue(response({ error: 'That project no longer exists.' }, 404))
    const store = useWorkspaceStore()

    await store.open('proj-1')

    expect(store.projectMissing).toBe(true)
    expect(store.project).toBeNull()
    expect(requests()).toEqual(['GET /api/projects/proj-1'])
  })

  /*
   * `projectMissing` and `projectError` are kept apart because the two screens
   * differ: one offers a Back link, the other a Retry. A 500 is not a deleted
   * project and must not read as one.
   */
  it('records any other failure as an error, leaving missing false', async () => {
    fetchMock.mockResolvedValue(response({ error: 'Something went wrong.' }, 500))
    const store = useWorkspaceStore()

    await store.open('proj-1')

    expect(store.projectError).toBe('Something went wrong.')
    expect(store.projectMissing).toBe(false)
    expect(requests()).toEqual(['GET /api/projects/proj-1'])
  })

  /* A retry that succeeds clears the previous failure rather than layering on it. */
  it('clears a previous error when a later open succeeds', async () => {
    fetchMock.mockResolvedValue(response({}, 500))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    expect(store.projectError).not.toBeNull()

    fetchMock.mockReset()
    respondOpenOk()
    await store.open('proj-1')

    expect(store.projectError).toBeNull()
    expect(store.project).toEqual(PROJECT)
  })

  /* Opening a different project must not show the previous one's transcript. */
  it('drops the previous project’s messages when a different id is opened', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    expect(store.messages).toHaveLength(1)

    fetchMock.mockResolvedValueOnce(response({ project: { ...PROJECT, id: 'proj-2' } }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    expect(store.messages).toEqual([])
  })
})

/**
 * Every request here is issued for one project and lands after an `await`, by which
 * time the route may have moved on — the dashboard is two clicks away and the store
 * is a singleton, so "open A, go back, open B" leaves A's requests in flight against
 * B's screen. A response that arrives for a project that is no longer open is not
 * merely stale, it is *wrong*: it would put A's name over B's transcript, blank the
 * screen by clearing a loading flag that belongs to B, or append A's messages to B's
 * conversation.
 *
 * The rule is one line — a write only lands while `projectId` is still the id the
 * call was made for — and these are the four ways it is otherwise broken.
 */
describe('a response that arrives for a project that is no longer open', () => {
  it('does not overwrite the project that is on screen', async () => {
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const store = useWorkspaceStore()

    const stale = store.open('proj-1')
    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    slow.settle(response({ project: PROJECT }))
    await stale

    expect(store.project).toEqual(OTHER_PROJECT)
    // And it does not go back to loading, or fetch proj-1's transcript.
    expect(store.projectLoading).toBe(false)
    expect(requests()).toEqual([
      'GET /api/projects/proj-1',
      'GET /api/projects/proj-2',
      'GET /api/projects/proj-2/messages',
      'GET /api/projects/proj-2/files',
    ])
  })

  /* A 404 for the project you have left is not a 404 for the one you are looking at. */
  it('does not render the previous project’s 404 over the current one', async () => {
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const store = useWorkspaceStore()

    const stale = store.open('proj-1')
    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    slow.settle(response({ error: 'That project no longer exists.' }, 404))
    await stale

    expect(store.projectMissing).toBe(false)
    expect(store.projectError).toBeNull()
    expect(store.project).toEqual(OTHER_PROJECT)
  })

  /* The chat panel's Retry, left in flight — the transcript request on its own. */
  it('does not render the previous project’s transcript', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')

    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const stale = store.loadMessages()

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    slow.settle(response({ messages: [USER_MESSAGE, ASSISTANT_MESSAGE] }))
    await stale

    expect(store.messages).toEqual([])
    // Nor may it report a load, or a failure, on the project now on screen.
    expect(store.messagesLoading).toBe(false)
    expect(store.messagesError).toBeNull()
  })

  /* The worst of the four: the user's own words in somebody else's conversation. */
  it('does not append a send that resolves after another project was opened', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')
    store.draft = 'build a contact dashboard'

    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const sent = store.send()

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    slow.settle(response({ messages: [USER_MESSAGE] }, 201))
    await sent

    expect(store.messages).toEqual([])
    expect(store.sending).toBe(false)
  })
})

/**
 * A draft and a send error belong to the conversation they were written in.
 *
 * They are the two pieces of state `open` does *not* clear unconditionally, because
 * `open` is also what the workspace's Retry button calls (AC-22) — and throwing away
 * what the user has typed is not part of retrying a failed project fetch. Keyed on
 * the id, both survive a retry and neither crosses into a different project.
 */
describe('the draft and the send error across projects', () => {
  it('clears both when a different project is opened', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')
    store.draft = 'half a sentence'
    fetchMock.mockResolvedValueOnce(response({ error: 'Something went wrong.' }, 500))
    await store.send()
    expect(store.sendError).toBe('Something went wrong.')

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    expect(store.draft).toBe('')
    expect(store.sendError).toBeNull()
  })

  it('keeps the draft when the same project is re-opened by a retry', async () => {
    fetchMock.mockResolvedValue(response({ error: 'Something went wrong.' }, 500))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    store.draft = 'half a sentence'

    await store.open('proj-1')

    expect(store.draft).toBe('half a sentence')
  })
})

describe('loadMessages', () => {
  it('fills the transcript and marks it loaded', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')

    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE, ASSISTANT_MESSAGE] }))
    await store.loadMessages()

    expect(store.messages).toEqual([USER_MESSAGE, ASSISTANT_MESSAGE])
    expect(store.messagesLoaded).toBe(true)
    expect(store.messagesError).toBeNull()
  })

  /** AC-30's store half: the retry button re-issues the request. */
  it('re-issues the transcript request when called again', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ error: 'Something went wrong.' }, 500))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    expect(store.messagesError).toBe('Something went wrong.')

    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }))
    await store.loadMessages()

    expect(requests()).toEqual([
      'GET /api/projects/proj-1',
      'GET /api/projects/proj-1/messages',
      'GET /api/projects/proj-1/files',
      'GET /api/projects/proj-1/messages',
    ])
    expect(store.messagesError).toBeNull()
    expect(store.messages).toEqual([USER_MESSAGE])
  })

  /* A failed transcript is the chat panel's error state and nothing else's — the
   * project, the header and the other two panels are unaffected (AC-30). */
  it('records a failure without disturbing the project', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ error: 'Could not load the conversation.' }, 500))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    const store = useWorkspaceStore()

    await store.open('proj-1')

    expect(store.messagesError).toBe('Could not load the conversation.')
    expect(store.project).toEqual(PROJECT)
    expect(store.projectError).toBeNull()
  })

  it('does nothing without a project open', async () => {
    await useWorkspaceStore().loadMessages()

    expect(requests()).toEqual([])
  })
})

describe('send', () => {
  /**
   * One `POST`, the **one** returned message appended, the draft cleared — and
   * no `GET` (D3, D4).
   *
   * The reply is not part of this request any more: `POST /generate` writes it,
   * which is what makes a generation that dies before its first byte still leave
   * a transcript the user recognises and a Retry that works (F8.2).
   */
  it('posts the draft, appends the returned user message, and issues no GET', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    // The reply is a second request now (D3); this case is about the first.
    fetchMock.mockResolvedValueOnce(cannedStream(`event: done\ndata: {"message":null}\n\n`))
    store.draft = 'build a contact dashboard'

    await store.send()

    expect(requests()[0]).toBe('POST /api/projects/proj-1/messages')
    expect(requests()).not.toContain('GET /api/projects/proj-1/messages')
    expect(store.messages).toEqual([USER_MESSAGE])
    expect(store.draft).toBe('')
    expect(store.sendError).toBeNull()
    expect(store.sending).toBe(false)
  })

  it('appends to an existing transcript rather than replacing it', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }))
    const store = useWorkspaceStore()
    await store.open('proj-1')

    fetchMock.mockResolvedValueOnce(response({ messages: [ASSISTANT_MESSAGE] }, 201))
    store.draft = 'again'
    await store.send()

    expect(store.messages).toEqual([USER_MESSAGE, ASSISTANT_MESSAGE])
  })

  it('sends the trimmed draft', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    store.draft = '  build a contact dashboard  '

    await store.send()

    // The client always sends a JSON string; narrowed rather than coerced, since
    // `RequestInit['body']` also admits shapes with no useful stringification.
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit
    expect(JSON.parse(typeof init.body === 'string' ? init.body : '')).toEqual({
      content: 'build a contact dashboard',
    })
  })

  it('is sending while the request is in flight', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    store.draft = 'hi'

    const pending = store.send()
    expect(store.sending).toBe(true)
    await pending
  })

  /*
   * AC-34. Nothing appended, the draft kept, and the message on screen is the
   * server's — a user who wrote a page of prose must not lose it to a 500, and
   * re-submitting has to be able to send the same text again.
   */
  it('keeps the draft and appends nothing when the send fails, and retries', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(
      response({ error: 'This project has reached its limit of 200 messages.' }, 409),
    )
    store.draft = 'build a contact dashboard'

    await store.send()

    expect(store.sendError).toBe('This project has reached its limit of 200 messages.')
    expect(store.messages).toEqual([])
    expect(store.draft).toBe('build a contact dashboard')
    expect(store.sending).toBe(false)

    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    fetchMock.mockResolvedValueOnce(cannedStream(`event: done\ndata: {"message":null}\n\n`))
    await store.send()

    expect(requests()).toEqual([
      'POST /api/projects/proj-1/messages',
      'POST /api/projects/proj-1/messages',
      'POST /generate',
    ])
    expect(store.sendError).toBeNull()
    expect(store.draft).toBe('')
  })

  /* A blank or whitespace-only draft is not a request. The composer disables
   * submit too, but the store is the boundary the composer cannot bypass. */
  it.each([
    ['an empty draft', ''],
    ['a whitespace-only draft', '   '],
  ])('issues no request for %s', async (_label, draft) => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockClear()
    store.draft = draft

    await store.send()

    expect(requests()).toEqual([])
  })

  it('issues no request without a project open', async () => {
    const store = useWorkspaceStore()
    store.draft = 'hi'

    await store.send()

    expect(requests()).toEqual([])
  })
})

describe('the draft', () => {
  /*
   * AC-25, D17, R8. The draft is store state, not component state, because the
   * `lg` breakpoint swaps one component tree for another — a draft held in a
   * composer is eaten by a window resize, which is invisible in review and
   * infuriating in use. Store state survives any component lifecycle by
   * construction, which is what this asserts.
   */
  it('survives a component lifecycle, because it lives here', () => {
    useWorkspaceStore().draft = 'half a sentence'

    // A second `useWorkspaceStore()` is what a freshly mounted component gets.
    expect(useWorkspaceStore().draft).toBe('half a sentence')
  })
})

describe('canSend and atLimit', () => {
  function transcript(length: number) {
    return Array.from({ length }, (_unused, index) => ({
      ...USER_MESSAGE,
      id: `msg-${String(index)}`,
    }))
  }

  it('is not sendable while the draft trims to nothing', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')

    expect(store.canSend).toBe(false)
    store.draft = '   '
    expect(store.canSend).toBe(false)
    store.draft = 'hi'
    expect(store.canSend).toBe(true)
  })

  it('is not sendable while a send is in flight', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    store.draft = 'hi'

    const pending = store.send()
    expect(store.canSend).toBe(false)
    await pending
  })

  /** AC-32's source of truth: at the cap the composer disables itself. */
  it('is at the limit at 200 messages, and sendable at 199', () => {
    const store = useWorkspaceStore()
    store.draft = 'hi'

    store.messages = transcript(199)
    expect(store.atLimit).toBe(false)
    expect(store.canSend).toBe(true)

    store.messages = transcript(200)
    expect(store.atLimit).toBe(true)
    expect(store.canSend).toBe(false)
  })
})

describe('reset', () => {
  /*
   * A transcript belongs to one account, and signing out is a route change rather
   * than a page load — so without this the next person to sign in on the same
   * browser could see the last one's conversation. The draft goes too: it is the
   * previous user's words.
   */
  it('empties everything', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }))
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE] }))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    store.draft = 'half a sentence'

    store.reset()

    expect(store.projectId).toBeNull()
    expect(store.project).toBeNull()
    expect(store.projectLoading).toBe(false)
    expect(store.projectMissing).toBe(false)
    expect(store.projectError).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.messagesLoading).toBe(false)
    expect(store.messagesLoaded).toBe(false)
    expect(store.messagesError).toBeNull()
    expect(store.draft).toBe('')
    expect(store.sending).toBe(false)
    expect(store.sendError).toBeNull()
    /* The code panel goes with the rest of it: a file list belongs to one account
     * and one project, and signing out is a route change rather than a page load. */
    expect(store.files).toEqual([])
    expect(store.filesLoading).toBe(false)
    expect(store.filesLoaded).toBe(false)
    expect(store.filesError).toBeNull()
    expect(store.selectedPath).toBeNull()
    expect(store.openTabs).toEqual([])
    expect(store.buffers).toEqual({})
    expect(store.editorContent).toBe('')
    expect(store.fileDirty).toBe(false)
    expect(store.fileLoading).toBe(false)
    expect(store.fileError).toBeNull()
    expect(store.saving).toBe(false)
    expect(store.saveError).toBeNull()
  })
})

/**
 * A `Response` whose body is a stream this test pushes frames into by hand.
 *
 * That control is what makes "tokens accumulate" observable: with a canned body
 * the whole reply arrives in one tick and `streamingText` is only ever seen at
 * its final value, which is exactly the state a broken accumulator also reaches.
 */
function pushableStream(): {
  response: Response
  push: (chunk: string) => void
  close: () => void
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })

  return {
    response: { ok: true, status: 200, body } as unknown as Response,
    push: (chunk: string) => {
      controller.enqueue(encoder.encode(chunk))
    },
    close: () => {
      controller.close()
    },
  }
}

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** A whole stream, delivered as one canned body. */
function cannedStream(...frames: string[]): Response {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames.join('')))
        controller.close()
      },
    }),
  } as unknown as Response
}

const ASSISTANT_TRUNCATED = { ...ASSISTANT_MESSAGE, id: 'msg-3', truncated: true }

/** Open a project and clear the request log, so a case starts from zero. */
async function opened(): Promise<ReturnType<typeof useWorkspaceStore>> {
  respondOpenOk()
  const store = useWorkspaceStore()
  await store.open('proj-1')
  fetchMock.mockClear()
  return store
}

describe('send — the two requests of a turn', () => {
  /*
   * AC-32, D3. The message write first, then the stream, and **no `GET`**: the
   * prompt is durable before the expensive, failure-prone half begins, which is
   * the whole of F8.2. A refetch would re-read the entire history on every turn
   * to re-read something that cannot have changed.
   */
  it('posts the message, then opens the stream, and issues no GET', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    fetchMock.mockResolvedValueOnce(cannedStream(frame('done', { message: ASSISTANT_MESSAGE })))
    store.draft = 'build a contact dashboard'

    await store.send()

    expect(requests()).toEqual(['POST /api/projects/proj-1/messages', 'POST /generate'])
    expect(store.messages).toEqual([USER_MESSAGE, ASSISTANT_MESSAGE])
    expect(store.draft).toBe('')
  })

  /*
   * AC-33. A failed write opens **no stream at all**: there is nothing to
   * generate from, the user's words are still in the composer, and offering a
   * generation for a prompt that was never stored would produce a reply attached
   * to nothing.
   */
  it('opens no stream when the message write fails, and keeps the draft', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ error: 'That project no longer exists.' }, 404))
    store.draft = 'build a contact dashboard'

    await store.send()

    expect(requests()).toEqual(['POST /api/projects/proj-1/messages'])
    expect(store.messages).toEqual([])
    expect(store.draft).toBe('build a contact dashboard')
    expect(store.sendError).toBe('That project no longer exists.')
    expect(store.generating).toBe(false)
  })

  /*
   * D27, and the store keeping the promise its own comment makes.
   *
   * `canSend` names three reasons not to send — an empty draft, a send already
   * in flight, and a stream already open — and the composer disables itself on
   * all three. The store re-checks them because "a keyboard shortcut reaches
   * this function without going through the button", and the third one is the
   * expensive reason: a second `send()` during a stream posts a message and
   * opens a **second paid generation**, and the first stream's abort then lands
   * on the second one's state, clearing `generating` and raising an error for a
   * request that is still running.
   */
  it('sends nothing while a stream is already open', async () => {
    const store = await opened()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    // Waiting on the request rather than on `generating`: the flag is set a tick
    // before `fetch` is reached, so clearing the log on it races the very call
    // this case is about not seeing a second of.
    await vi.waitFor(() => {
      expect(requests()).toEqual(['POST /generate'])
    })
    fetchMock.mockClear()
    store.draft = 'and add a search box'

    await store.send()

    expect(requests()).toEqual([])
    // The draft survives, so the user's words are not the price of the guard.
    expect(store.draft).toBe('and add a search box')

    stream.push(frame('done', { message: ASSISTANT_MESSAGE }))
    stream.close()
    await running

    expect(store.generateError).toBeNull()
    expect(store.messages).toEqual([ASSISTANT_MESSAGE])
  })
})

describe('the stream', () => {
  /*
   * AC-34. The tokens accumulate into `streamingText` and **`messages` is
   * untouched** until the terminal event — D31's shape: the tokens become a
   * `Message` exactly once, at the end, rather than an array pushed to
   * thousands of times.
   */
  it('accumulates tokens without touching the transcript, then appends on done', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    store.draft = 'build a contact dashboard'

    const sending = store.send()
    await vi.waitFor(() => {
      expect(store.generating).toBe(true)
    })

    stream.push(frame('token', { text: 'Here is ' }))
    await vi.waitFor(() => {
      expect(store.streamingText).toBe('Here is ')
    })
    expect(store.messages).toEqual([USER_MESSAGE])

    stream.push(frame('token', { text: 'a contact dashboard' }))
    await vi.waitFor(() => {
      expect(store.streamingText).toBe('Here is a contact dashboard')
    })
    expect(store.messages).toEqual([USER_MESSAGE])

    stream.push(frame('done', { message: ASSISTANT_MESSAGE }))
    stream.close()
    await sending

    expect(store.messages).toEqual([USER_MESSAGE, ASSISTANT_MESSAGE])
    expect(store.streamingText).toBe('')
    expect(store.generating).toBe(false)
    expect(store.generateError).toBeNull()
  })

  /*
   * AC-35. An `error` carrying a message appends it — the partial the server
   * actually stored, not the client's own copy of it (D9). Whatever arrives, the
   * placeholder is replaced by the server's record.
   */
  it('appends the persisted partial and sets the error', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('token', { text: 'Here is ' }),
        frame('error', {
          error: 'The reply was interrupted. Try again.',
          code: 'upstream',
          message: ASSISTANT_TRUNCATED,
        }),
      ),
    )
    store.draft = 'build a contact dashboard'

    await store.send()

    expect(store.messages).toEqual([USER_MESSAGE, ASSISTANT_TRUNCATED])
    expect(store.generateError).toBe('The reply was interrupted. Try again.')
    expect(store.streamingText).toBe('')
    expect(store.generating).toBe(false)
  })

  /** AC-35's other half: nothing was produced, so nothing is appended. */
  it('appends nothing when the error carries a null message', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('error', {
          error: 'Claude declined to answer that. Try rephrasing.',
          code: 'refused',
          message: null,
        }),
      ),
    )
    store.draft = 'build a contact dashboard'

    await store.send()

    expect(store.messages).toEqual([USER_MESSAGE])
    expect(store.generateError).toBe('Claude declined to answer that. Try rephrasing.')
    expect(store.generating).toBe(false)
  })

  /*
   * The stream failing to *open* is the third case, and it is a rejection rather
   * than an event — so it has to reach the same error state, or a 404 on
   * `/generate` would leave the composer disabled with nothing on screen.
   */
  it('records a refusal to open the stream as a generation error', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }, 201))
    fetchMock.mockResolvedValueOnce(
      response({ error: 'There is nothing to generate from yet. Send a message first.' }, 400),
    )
    store.draft = 'build a contact dashboard'

    await store.send()

    expect(store.messages).toEqual([USER_MESSAGE])
    expect(store.generateError).toBe('There is nothing to generate from yet. Send a message first.')
    expect(store.generating).toBe(false)
    expect(store.streamingText).toBe('')
  })
})

describe('retryGeneration', () => {
  /*
   * AC-36, D26. **No message write.** The endpoint's whole input is the
   * transcript (D2), so a retry is the same request again — which is what makes
   * Retry free, and what D6's trailing-assistant drop exists to keep working.
   */
  it('re-opens the stream and writes no message', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(cannedStream(frame('done', { message: ASSISTANT_MESSAGE })))

    await store.retryGeneration()

    expect(requests()).toEqual(['POST /generate'])
    expect(store.messages).toEqual([ASSISTANT_MESSAGE])
  })

  it('clears a previous generation error when it succeeds', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ error: 'Something went wrong.' }, 500))
    await store.retryGeneration()
    expect(store.generateError).toBe('Something went wrong.')

    fetchMock.mockResolvedValueOnce(cannedStream(frame('done', { message: ASSISTANT_MESSAGE })))
    await store.retryGeneration()

    expect(store.generateError).toBeNull()
  })

  it('does nothing without a project open', async () => {
    const store = useWorkspaceStore()

    await store.retryGeneration()

    expect(requests()).toEqual([])
  })
})

describe('a stream that outlives the screen it was opened for', () => {
  /*
   * AC-37, and the reason the controller lives in the store rather than in a
   * component (D31, Slice 4's D17). The `lg` breakpoint swaps one component tree
   * for another, so a controller held in the chat panel is dropped by a window
   * resize — and the stream it was meant to cancel keeps writing.
   */
  it('aborts the request on reset, and a later frame mutates nothing', async () => {
    const store = await opened()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)

    const running = store.retryGeneration()
    await vi.waitFor(() => {
      expect(store.generating).toBe(true)
    })

    store.reset()
    stream.push(frame('done', { message: ASSISTANT_MESSAGE }))
    stream.close()
    await running

    expect(store.messages).toEqual([])
    expect(store.streamingText).toBe('')
    expect(store.generating).toBe(false)
    expect(store.projectId).toBeNull()
  })

  it('leaves the second project’s state alone when the first project’s stream ends', async () => {
    const store = await opened()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)

    const running = store.retryGeneration()
    await vi.waitFor(() => {
      expect(store.generating).toBe(true)
    })
    stream.push(frame('token', { text: 'belongs to proj-1' }))

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    stream.push(frame('done', { message: ASSISTANT_MESSAGE }))
    stream.close()
    await running

    expect(store.projectId).toBe('proj-2')
    expect(store.messages).toEqual([])
    expect(store.streamingText).toBe('')
    expect(store.generating).toBe(false)
  })
})

describe('canSend while generating', () => {
  /* AC-42's source of truth: the composer keys off this. */
  it('is false while a stream is open and true again after it ends', async () => {
    const store = await opened()
    store.draft = 'build a contact dashboard'
    expect(store.canSend).toBe(true)

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    await vi.waitFor(() => {
      expect(store.generating).toBe(true)
    })

    expect(store.canSend).toBe(false)

    stream.push(frame('done', { message: ASSISTANT_MESSAGE }))
    stream.close()
    await running

    expect(store.canSend).toBe(true)
  })
})

/**
 * The files half of the same store (D24).
 *
 * `fetch` is stubbed rather than `filesApi`, exactly as above, so what is asserted
 * is the request that would go on the wire — the path, the method and the body —
 * and not that one module called another.
 *
 * Two shapes of the list matter and both are tested: the list *response*, which is
 * metadata only and never carries content (D19), and the read of one file, which
 * is the only thing that does. Splitting them is what keeps opening a workspace
 * from shipping 20 × 100 KB of code nobody has clicked on.
 */
describe('the file list', () => {
  /** AC-37. The list is part of opening a project, not of clicking the panel. */
  it('fills the list and marks it loaded', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, APP_FILE] }))
    const store = useWorkspaceStore()

    await store.open('proj-1')

    expect(store.files).toEqual([INDEX_FILE, APP_FILE])
    expect(store.filesLoaded).toBe(true)
    expect(store.filesLoading).toBe(false)
    expect(store.filesError).toBeNull()
  })

  it('is loading while the list request is in flight', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const store = useWorkspaceStore()

    const opening = store.open('proj-1')
    await vi.waitFor(() => {
      expect(store.filesLoading).toBe(true)
    })
    slow.settle(response({ files: [] }))
    await opening

    expect(store.filesLoading).toBe(false)
  })

  /*
   * AC-37's second half. A failed refetch must not empty a tree that already has
   * files in it: the panel would then read as "this project has no code", which is
   * a different and much worse statement than "we could not reach the server".
   */
  it('records a failure and leaves any existing list in place', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE] }))
    const store = useWorkspaceStore()
    await store.open('proj-1')

    fetchMock.mockResolvedValueOnce(response({ error: 'Could not load these files.' }, 500))
    await store.loadFiles()

    expect(store.filesError).toBe('Could not load these files.')
    expect(store.files).toEqual([INDEX_FILE])
  })

  /** The panel's Try again, which is this action and nothing else. */
  it('re-issues the list request and clears a previous failure', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ error: 'Something went wrong.' }, 500))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    expect(store.filesError).toBe('Something went wrong.')

    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE] }))
    await store.loadFiles()

    expect(requests()).toEqual([
      'GET /api/projects/proj-1',
      'GET /api/projects/proj-1/messages',
      'GET /api/projects/proj-1/files',
      'GET /api/projects/proj-1/files',
    ])
    expect(store.filesError).toBeNull()
    expect(store.files).toEqual([INDEX_FILE])
  })

  /* A failed transcript is the chat panel's problem; the code panel loads anyway. */
  it('loads the files even when the transcript failed', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ error: 'Could not load the conversation.' }, 500))
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE] }))
    const store = useWorkspaceStore()

    await store.open('proj-1')

    expect(store.messagesError).toBe('Could not load the conversation.')
    expect(store.files).toEqual([INDEX_FILE])
  })

  it('does nothing without a project open', async () => {
    await useWorkspaceStore().loadFiles()

    expect(requests()).toEqual([])
  })

  /* The same staleness rule the transcript has: one project's list must not land
   * in another's panel. */
  it('does not render the previous project’s list', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')

    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const stale = store.loadFiles()

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    slow.settle(response({ files: [INDEX_FILE, APP_FILE] }))
    await stale

    expect(store.files).toEqual([])
    expect(store.filesLoading).toBe(false)
    expect(store.filesError).toBeNull()
  })
})

/**
 * Tabs, and the per-path buffers under them (AC-13 – AC-17, D10 – D14).
 *
 * Slice 6 had **one** buffer, so clicking a second file threw away unsaved edits
 * to the first with no warning. The map keyed by path is what fixes that, and
 * `openTabs` is what makes it visible; `selectedPath` keeps its name and now
 * means the active tab (D14), which is deliberate diff hygiene — `FileTree.vue`
 * does not change at all.
 *
 * Each buffer is `{ content, saved, loading, error, replaced }`. `content` is
 * what the user has and `saved` is what the server last said; dirty is the two
 * disagreeing, derived rather than maintained, because a boolean has to be set on
 * every edit path and cleared on every load path and the first one anybody
 * forgets either enables Save for an unchanged file or leaves it disabled over an
 * edit.
 *
 * **The buffer survives a tab close** (D12), which is what removes the confirm
 * dialog from this slice entirely: closing a tab cannot lose work, so there is
 * nothing to warn about.
 */
describe('tabs and their buffers', () => {
  const stored = { ...INDEX_FILE, content: '<h1>Contacts</h1>\n' }
  const storedApp = { ...APP_FILE, content: 'console.log(1)' }

  async function openedWithFiles(): Promise<ReturnType<typeof useWorkspaceStore>> {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, APP_FILE] }))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockClear()
    return store
  }

  /** Open two tabs on real content, `index.html` first and `app.js` active. */
  async function openedOnTwo(): Promise<ReturnType<typeof useWorkspaceStore>> {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: stored }))
    await store.selectFile('index.html')
    fetchMock.mockResolvedValueOnce(response({ file: storedApp }))
    await store.selectFile('app.js')
    fetchMock.mockClear()
    return store
  }

  /** AC-13. A tree click opens a tab, fetches it, and makes it active. */
  it('opens a tab, fetches it, and makes it active', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: stored }))

    await store.selectFile('index.html')

    expect(requests()).toEqual(['GET /api/projects/proj-1/files/index.html'])
    expect(store.openTabs).toEqual(['index.html'])
    expect(store.selectedPath).toBe('index.html')
    expect(store.editorContent).toBe('<h1>Contacts</h1>\n')
    expect(store.fileDirty).toBe(false)
    expect(store.fileLoading).toBe(false)
    expect(store.fileError).toBeNull()
  })

  it('is loading while the read is in flight, with the tab already open', async () => {
    const store = await openedWithFiles()
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)

    const selecting = store.selectFile('index.html')
    await vi.waitFor(() => {
      expect(store.fileLoading).toBe(true)
    })
    expect(store.openTabs).toEqual(['index.html'])
    expect(store.editorContent).toBe('')

    slow.settle(response({ file: stored }))
    await selecting

    expect(store.editorContent).toBe('<h1>Contacts</h1>\n')
  })

  it('is dirty once the buffer is edited', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: stored }))
    await store.selectFile('index.html')

    store.editContent('<h1>People</h1>\n')

    expect(store.editorContent).toBe('<h1>People</h1>\n')
    expect(store.fileDirty).toBe(true)
    expect(store.dirtyPaths).toEqual(['index.html'])
  })

  /**
   * AC-13's failure half. The tab is **kept** — a tab that vanishes when its read
   * fails leaves the user nothing to retry from — and `reloadFile()` is the Try
   * again. The second tab is untouched throughout, which is the whole point of
   * one buffer per path.
   */
  it('keeps a failed read’s tab and re-reads it on demand', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: storedApp }))
    await store.selectFile('app.js')
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce(response({ error: 'That file no longer exists.' }, 404))
    await store.selectFile('index.html')

    expect(store.openTabs).toEqual(['app.js', 'index.html'])
    expect(store.selectedPath).toBe('index.html')
    expect(store.fileError).toBe('That file no longer exists.')
    expect(store.editorContent).toBe('')
    expect(store.fileDirty).toBe(false)

    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(response({ file: stored }))
    await store.reloadFile()

    expect(requests()).toEqual(['GET /api/projects/proj-1/files/index.html'])
    expect(store.fileError).toBeNull()
    expect(store.editorContent).toBe('<h1>Contacts</h1>\n')

    // And the other tab never moved.
    await store.selectFile('app.js')
    expect(store.editorContent).toBe('console.log(1)')
  })

  /**
   * AC-14. Re-activating is not re-opening: no second tab, and **no request** —
   * refetching here would silently discard the buffer, which is the exact bug
   * tabs exist to fix.
   */
  it('activates an open tab without a second tab and without a request', async () => {
    const store = await openedOnTwo()

    await store.selectFile('index.html')

    expect(store.openTabs).toEqual(['index.html', 'app.js'])
    expect(store.selectedPath).toBe('index.html')
    expect(requests()).toEqual([])
  })

  /** AC-15 — the slice's reason for existing, in one case. */
  it('keeps an unsaved edit across a tab switch, with no request', async () => {
    const store = await openedOnTwo()
    await store.selectFile('index.html')
    store.editContent('<h1>People</h1>\n')

    await store.selectFile('app.js')
    expect(store.editorContent).toBe('console.log(1)')
    expect(store.fileDirty).toBe(false)

    await store.selectFile('index.html')

    expect(store.editorContent).toBe('<h1>People</h1>\n')
    expect(store.fileDirty).toBe(true)
    expect(requests()).toEqual([])
  })

  /** AC-16, all three neighbours. */
  describe('closing a tab', () => {
    async function openedOnThree(): Promise<ReturnType<typeof useWorkspaceStore>> {
      const store = await openedWithFiles()
      for (const path of ['index.html', 'app.js', 'styles.css']) {
        fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, path, content: path } }))
        await store.selectFile(path)
      }
      fetchMock.mockClear()
      return store
    }

    it('closes the middle tab onto its left neighbour', async () => {
      const store = await openedOnThree()
      await store.selectFile('app.js')

      store.closeTab('app.js')

      expect(store.openTabs).toEqual(['index.html', 'styles.css'])
      expect(store.selectedPath).toBe('index.html')
      expect(requests()).toEqual([])
    })

    it('closes the leftmost onto its right neighbour', async () => {
      const store = await openedOnThree()
      await store.selectFile('index.html')

      store.closeTab('index.html')

      expect(store.openTabs).toEqual(['app.js', 'styles.css'])
      expect(store.selectedPath).toBe('app.js')
    })

    it('leaves no active tab when the last one closes', async () => {
      const store = await openedOnThree()
      for (const path of ['index.html', 'app.js', 'styles.css']) store.closeTab(path)

      expect(store.openTabs).toEqual([])
      expect(store.selectedPath).toBeNull()
      expect(store.editorContent).toBe('')
    })

    /* Closing a tab that is not the active one moves the selection nowhere. */
    it('leaves the active tab alone when another is closed', async () => {
      const store = await openedOnThree()
      await store.selectFile('styles.css')

      store.closeTab('index.html')

      expect(store.openTabs).toEqual(['app.js', 'styles.css'])
      expect(store.selectedPath).toBe('styles.css')
    })
  })

  /**
   * AC-17, D12. The buffer outlives the tab, which is what makes closing safe
   * enough to need no confirm dialog — a component, a focus trap, an e2e case and
   * a decision about the default button, all bought by a rule that costs a line.
   */
  it('restores a dirty buffer when a closed tab is reopened, with no request', async () => {
    const store = await openedOnTwo()
    await store.selectFile('index.html')
    store.editContent('<h1>People</h1>\n')

    store.closeTab('index.html')
    expect(store.openTabs).toEqual(['app.js'])

    await store.selectFile('index.html')

    expect(store.openTabs).toEqual(['app.js', 'index.html'])
    expect(store.editorContent).toBe('<h1>People</h1>\n')
    expect(store.fileDirty).toBe(true)
    expect(requests()).toEqual([])
  })

  /* D16's other trigger: the notice belongs to the buffer, and closing the tab
   * is the user acting on it. */
  it('clears a replaced notice when the tab is closed', async () => {
    const store = await openedOnTwo()
    await store.selectFile('index.html')
    store.editContent('my unsaved edit')

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, APP_FILE] }))
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'regenerated' } }))
    stream.push(
      frame('done', { message: ASSISTANT_MESSAGE, files: ['index.html'], fileError: null }),
    )
    stream.close()
    await running
    expect(store.fileReplaced).toBe(true)

    store.closeTab('index.html')
    await store.selectFile('index.html')

    expect(store.fileReplaced).toBe(false)
  })

  it('does not render a read that lands after another project was opened', async () => {
    const store = await openedWithFiles()
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const stale = store.selectFile('index.html')

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    slow.settle(response({ file: stored }))
    await stale

    expect(store.openTabs).toEqual([])
    expect(store.buffers).toEqual({})
    expect(store.selectedPath).toBeNull()
    expect(store.editorContent).toBe('')
    expect(store.fileLoading).toBe(false)
  })

  /* Tabs and buffers belong to one project. Carrying them across would show one
   * project's code under another's tree. */
  it('drops every tab and buffer when another project is opened', async () => {
    const store = await openedOnTwo()

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    expect(store.openTabs).toEqual([])
    expect(store.buffers).toEqual({})
    expect(store.selectedPath).toBeNull()
  })

  it('drops every tab and buffer on reset', async () => {
    const store = await openedOnTwo()

    store.reset()

    expect(store.openTabs).toEqual([])
    expect(store.buffers).toEqual({})
    expect(store.selectedPath).toBeNull()
    expect(store.dirtyPaths).toEqual([])
  })

  /* Nothing selected, nothing to reload — and no request for a path that is
   * not there. */
  it('reloads nothing with no active tab', async () => {
    const store = await openedWithFiles()

    await store.reloadFile()

    expect(requests()).toEqual([])
  })
})

/**
 * Saving an edit, **scoped to the active tab** (AC-19 – AC-21, D26).
 *
 * The response replaces the buffer rather than the buffer being trusted. The
 * server owns `size` and both timestamps and is free to store something other
 * than exactly what was sent; taking its answer is the same liveness rule the
 * rest of the app follows, and it is what stops the editor from showing a
 * document that disagrees with the server until a reload.
 *
 * What Slice 7 adds is the scope. With one buffer, "the buffer" was unambiguous;
 * with a map, a save that reached past the active tab would store one file's
 * bytes under another's name, or clear a dirty mark on a tab nobody saved. So
 * every case here that could touch a second tab asserts that it did not.
 *
 * `saving` and `saveError` stay top-level rather than joining the buffer: the
 * save is single-flight across the whole panel, and the PRD's data-model table
 * leaves them out deliberately.
 */
describe('saveFile', () => {
  const stored = { ...INDEX_FILE, content: '<h1>Contacts</h1>\n' }
  const storedApp = { ...APP_FILE, content: 'console.log(1)' }

  async function openedOnIndex(): Promise<ReturnType<typeof useWorkspaceStore>> {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, APP_FILE] }))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockResolvedValueOnce(response({ file: stored }))
    await store.selectFile('index.html')
    fetchMock.mockClear()
    return store
  }

  /**
   * AC-19. Two tabs, the **inactive** one dirty: the save takes the server's
   * answer into the active buffer and leaves the other byte-identical.
   *
   * With one buffer this case could not be written at all, which is why it is the
   * first one here.
   */
  it('PUTs the active buffer and takes the server’s answer back into that tab only', async () => {
    const store = await openedOnIndex()
    fetchMock.mockResolvedValueOnce(response({ file: storedApp }))
    await store.selectFile('app.js')
    store.editContent('const untouched = true')
    await store.selectFile('index.html')
    store.editContent('<h1>People</h1>\n')
    fetchMock.mockClear()

    const saved = {
      ...stored,
      content: '<h1>People</h1>\n',
      size: 16,
      updatedAt: '2026-08-17T10:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(response({ file: saved }))

    await store.saveFile()

    expect(requests()).toEqual(['PUT /api/projects/proj-1/files/index.html'])
    expect(store.editorContent).toBe('<h1>People</h1>\n')
    expect(store.fileDirty).toBe(false)

    // The other tab is exactly as it was left — content and dirty mark both.
    expect(store.dirtyPaths).toEqual(['app.js'])
    expect(store.buffers['app.js']).toEqual({
      content: 'const untouched = true',
      saved: 'console.log(1)',
      loading: false,
      error: null,
      replaced: false,
    })

    // And the list entry carries the server's new size and timestamp.
    expect(store.files).toEqual([
      { path: 'index.html', size: 16, createdAt: INDEX_FILE.createdAt, updatedAt: saved.updatedAt },
      APP_FILE,
    ])
  })

  it('PUTs the buffer and takes the server’s answer back', async () => {
    const store = await openedOnIndex()
    store.editContent('<h1>People</h1>\n')
    const saved = {
      ...stored,
      content: '<h1>People</h1>\n',
      size: 16,
      updatedAt: '2026-08-17T10:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(response({ file: saved }))

    await store.saveFile()

    expect(requests()).toEqual(['PUT /api/projects/proj-1/files/index.html'])
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit
    expect(init.body).toBe(JSON.stringify({ content: '<h1>People</h1>\n' }))
    expect(store.editorContent).toBe('<h1>People</h1>\n')
    expect(store.fileDirty).toBe(false)
    expect(store.saving).toBe(false)
    expect(store.saveError).toBeNull()
  })

  /* The list carries the size the tree may show, so the saved document's new
   * metadata replaces the stale entry — the response, not a second GET. */
  it('refreshes the saved file’s entry in the list', async () => {
    const store = await openedOnIndex()
    store.editContent('<h1>People</h1>\n')
    const saved = {
      ...stored,
      content: '<h1>People</h1>\n',
      size: 16,
      updatedAt: '2026-08-17T10:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(response({ file: saved }))

    await store.saveFile()

    expect(store.files).toEqual([
      {
        path: 'index.html',
        size: 16,
        createdAt: INDEX_FILE.createdAt,
        updatedAt: '2026-08-17T10:00:00.000Z',
      },
      APP_FILE,
    ])
  })

  /*
   * A failed save keeps the user's work. Clearing the buffer, or marking it clean,
   * would throw away an edit *because* it could not be stored — the one outcome a
   * save must never have.
   */
  it('keeps the buffer dirty and records the error when the save fails', async () => {
    const store = await openedOnIndex()
    store.editContent('<h1>People</h1>\n')
    fetchMock.mockResolvedValueOnce(response({ error: 'Could not save that file.' }, 500))

    await store.saveFile()

    expect(store.saveError).toBe('Could not save that file.')
    expect(store.editorContent).toBe('<h1>People</h1>\n')
    expect(store.fileDirty).toBe(true)
    expect(store.saving).toBe(false)
  })

  it('clears a previous save error on the next successful save', async () => {
    const store = await openedOnIndex()
    store.editContent('<h1>People</h1>\n')
    fetchMock.mockResolvedValueOnce(response({ error: 'Could not save that file.' }, 500))
    await store.saveFile()
    expect(store.saveError).not.toBeNull()

    fetchMock.mockResolvedValueOnce(response({ file: { ...stored, content: '<h1>People</h1>\n' } }))
    await store.saveFile()

    expect(store.saveError).toBeNull()
  })

  it('issues no request with nothing selected', async () => {
    respondOpenOk()
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockClear()

    await store.saveFile()

    expect(requests()).toEqual([])
  })

  /**
   * A file the session has never read can never be saved over — end to end.
   *
   * `file_start` opens a tab and creates no buffer (P1), and a stream that ends
   * in an `error` rather than a `done` never reaches `applyGenerationFiles`. That
   * used to leave the tab open over a file whose bytes were never fetched, and a
   * save from it would have `PUT` an empty string over whatever the server holds.
   * The tab is now handed back when the stream ends whichever way it ended, so
   * this walks the whole route rather than the guard alone: the tab goes, and
   * there is nothing left to save from.
   *
   * `saveFile`'s own `buffer === undefined` guard stays as defence in depth —
   * the two claims are "no path reaches this state" and "the state would be
   * refused anyway", and only the first one can regress silently.
   */
  it('cannot save a file the session never read, after an interrupted stream', async () => {
    const store = await openedOnIndex()
    store.closeTab('index.html')
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('file_start', { path: 'app.js' }),
        frame('file_chunk', { path: 'app.js', text: 'const a = 1' }),
        frame('error', { error: 'The reply was interrupted.', code: 'upstream', message: null }),
      ),
    )
    await store.retryGeneration()
    expect(store.openTabs).toEqual([])
    expect(store.selectedPath).toBeNull()
    expect(store.buffers['app.js']).toBeUndefined()
    fetchMock.mockClear()

    await store.saveFile()

    expect(requests()).toEqual([])
    expect(store.saveError).toBeNull()
  })

  it('issues no second request while a save is already in flight', async () => {
    const store = await openedOnIndex()
    store.editContent('<h1>People</h1>\n')
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const first = store.saveFile()
    await vi.waitFor(() => {
      expect(store.saving).toBe(true)
    })

    await store.saveFile()

    expect(requests()).toEqual(['PUT /api/projects/proj-1/files/index.html'])
    slow.settle(response({ file: { ...stored, content: '<h1>People</h1>\n' } }))
    await first
  })

  it('does not apply a save that lands after another project was opened', async () => {
    const store = await openedOnIndex()
    store.editContent('<h1>People</h1>\n')
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const stale = store.saveFile()

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    slow.settle(response({ file: stored }))
    await stale

    expect(store.selectedPath).toBeNull()
    expect(store.editorContent).toBe('')
    expect(store.saving).toBe(false)
    expect(store.saveError).toBeNull()
  })

  /**
   * AC-24, D12. A save moves `filesRevision` and **only** `filesRevision`.
   *
   * The two counters answer two different questions, which is the whole reason
   * there are two of them. `generationsApplied` is what rebuilds the preview
   * unasked; a save deliberately leaves it alone, because saves are frequent and
   * every rebuild re-runs the generated app's HighLevel calls against a
   * 100-request/10-second account budget — rebuilding on each keystroke-batch a
   * developer commits would spend their CRM allowance on it. `filesRevision`
   * moving is what the panel renders as a **Files changed — Refresh** hint: never
   * silently stale, never spending the budget uninvited.
   */
  it('moves filesRevision and not generationsApplied on a successful save', async () => {
    const store = await openedOnIndex()
    store.editContent('<h1>People</h1>\n')
    fetchMock.mockResolvedValueOnce(response({ file: { ...stored, content: '<h1>People</h1>\n' } }))

    await store.saveFile()

    expect(store.filesRevision).toBe(1)
    expect(store.generationsApplied).toBe(0)
  })

  /* A save that failed stored nothing, so nothing the preview reads has changed.
   * Offering a Refresh for bytes the server rejected would spend a rebuild to
   * render exactly the document already on screen. */
  it('moves neither counter when the save fails', async () => {
    const store = await openedOnIndex()
    store.editContent('<h1>People</h1>\n')
    fetchMock.mockResolvedValueOnce(response({ error: 'Could not save that file.' }, 500))

    await store.saveFile()

    expect(store.filesRevision).toBe(0)
    expect(store.generationsApplied).toBe(0)
  })
})

/**
 * The generation fans out into the files as well as the transcript (D24).
 *
 * This is the reason the two live in one store. A `file_chunk` and a `token` come
 * from the same stream, are guarded by the same generation counter and are dropped
 * by the same `reset` — split across two stores they would need two of each, kept
 * in lockstep by hand.
 *
 * The streamed bytes are **watched, not stored** (D20). The server repairs content
 * and computes `size` and the timestamps, so what the browser saw arrive is not
 * necessarily what was written; `done` is what makes the client go and ask.
 */
describe('the stream — files', () => {
  const listed = { files: [INDEX_FILE, APP_FILE] }

  /** Open a project that already has two files, and clear the request log. */
  async function openedWithFiles(): Promise<ReturnType<typeof useWorkspaceStore>> {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response(listed))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockClear()
    return store
  }

  const fileFrames = (...paths: string[]): string[] =>
    paths.flatMap((path) => [
      frame('file_start', { path }),
      frame('file_chunk', { path, text: `// ${path}\n` }),
      frame('file_chunk', { path, text: 'done\n' }),
      frame('file_end', { path }),
    ])

  /**
   * AC-39. The tree is the union of stored and streaming, streaming marked, and
   * each buffer holds **its own** chunks — the frames repeat their path precisely
   * so that interleaved files cannot bleed into each other (D5).
   */
  it('shows streaming files in the tree and routes each chunk by its path', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    stream.push(frame('file_start', { path: 'styles.css' }))
    stream.push(frame('file_start', { path: 'app.js' }))
    stream.push(frame('file_chunk', { path: 'styles.css', text: 'body{}' }))
    stream.push(frame('file_chunk', { path: 'app.js', text: 'const a' }))
    stream.push(frame('file_chunk', { path: 'app.js', text: ' = 1' }))

    await vi.waitFor(() => {
      expect(store.streamingFiles['app.js']).toBe('const a = 1')
    })
    expect(store.streamingFiles['styles.css']).toBe('body{}')
    expect(store.fileTree).toEqual([
      { path: 'index.html', writing: false },
      { path: 'app.js', writing: true },
      { path: 'styles.css', writing: true },
    ])

    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running
  })

  /**
   * AC-18, P1. The first streamed file **opens a tab and creates no buffer**.
   *
   * That is what makes AC-24 literally true — an empty `files` touches `buffers`
   * not at all — while still discharging the hazard Slice 6's own tests name:
   * `file_start` does not fetch, so a buffer created here would have an empty
   * `saved` behind a real filename, and the first keystroke would make it dirty
   * enough for **Save** to offer to replace that file with what was typed.
   * `editorContent` already prefers `streamingFiles`, so the arriving bytes
   * render with no buffer entry to speak of.
   */
  it('opens a tab for the first streamed file without creating a buffer', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    stream.push(frame('file_start', { path: 'app.js' }))
    stream.push(frame('file_chunk', { path: 'app.js', text: 'const a = 1' }))
    await vi.waitFor(() => {
      expect(store.openTabs).toEqual(['app.js'])
    })

    expect(store.selectedPath).toBe('app.js')
    expect(store.buffers).toEqual({})
    // The bytes render anyway, because `editorContent` prefers the stream.
    expect(store.editorContent).toBe('const a = 1')
    expect(store.fileDirty).toBe(false)

    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running
  })

  /** AC-18's second half: a strip with a tab in it is never rearranged. */
  it('leaves the active tab alone for the whole generation', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'old' } }))
    await store.selectFile('index.html')

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    stream.push(frame('file_start', { path: 'app.js' }))
    stream.push(frame('file_start', { path: 'styles.css' }))
    await vi.waitFor(() => {
      expect(store.streamingFiles['styles.css']).toBe('')
    })

    expect(store.openTabs).toEqual(['index.html'])
    expect(store.selectedPath).toBe('index.html')

    fetchMock.mockResolvedValueOnce(response(listed))
    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: ['app.js'], fileError: null }))
    stream.close()
    await running

    expect(store.openTabs).toEqual(['index.html'])
    expect(store.selectedPath).toBe('index.html')
  })

  /** AC-39's last clause: the first streamed file opens itself, once. */
  it('selects the first streamed file when nothing was selected', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    stream.push(frame('file_start', { path: 'app.js' }))
    stream.push(frame('file_start', { path: 'styles.css' }))
    await vi.waitFor(() => {
      expect(store.selectedPath).toBe('app.js')
    })

    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running
  })

  /*
   * And **only** if nothing was selected. Moving a user off the file they were
   * reading, mid-reply, is the panel taking the screen away from them.
   */
  it('leaves an existing selection alone', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'old' } }))
    await store.selectFile('index.html')

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    stream.push(frame('file_start', { path: 'app.js' }))
    stream.push(frame('file_chunk', { path: 'app.js', text: 'x' }))
    await vi.waitFor(() => {
      expect(store.streamingFiles['app.js']).toBe('x')
    })

    expect(store.selectedPath).toBe('index.html')

    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running
  })

  /** The editor shows the bytes arriving for the file it has open. */
  it('renders the streaming buffer for the selected file', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    stream.push(frame('file_start', { path: 'app.js' }))
    stream.push(frame('file_chunk', { path: 'app.js', text: 'const a = 1' }))
    await vi.waitFor(() => {
      expect(store.editorContent).toBe('const a = 1')
    })

    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running
  })

  /**
   * AC-40. A non-empty `files` is the signal to go and ask (D20): the list comes
   * back with the server's `size` and timestamps, and the open file comes back
   * with the *repaired* content, which is not necessarily what streamed.
   */
  it('refetches the list and re-reads the open file on a done that wrote files', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    for (const raw of fileFrames('app.js')) stream.push(raw)
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, { ...APP_FILE, size: 20 }] }))
    fetchMock.mockResolvedValueOnce(response({ file: { ...APP_FILE, content: '// repaired\n' } }))
    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: ['app.js'], fileError: null }))
    stream.close()
    await running

    expect(requests()).toEqual([
      'POST /generate',
      'GET /api/projects/proj-1/files',
      'GET /api/projects/proj-1/files/app.js',
    ])
    expect(store.files).toEqual([INDEX_FILE, { ...APP_FILE, size: 20 }])
    expect(store.editorContent).toBe('// repaired\n')
    expect(store.fileDirty).toBe(false)
    expect(store.streamingFiles).toEqual({})
  })

  /*
   * AC-40's second half. An empty `files` means nothing was stored — a prose-only
   * reply, or a refused op set — and a refetch would be a request whose answer
   * cannot have changed.
   */
  it('issues no file request on a done that wrote nothing, and still clears the buffers', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'old' } }))
    await store.selectFile('index.html')
    fetchMock.mockClear()

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    stream.push(frame('file_start', { path: 'app.js' }))
    stream.push(frame('file_chunk', { path: 'app.js', text: 'x' }))
    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running

    expect(requests()).toEqual(['POST /generate'])
    expect(store.streamingFiles).toEqual({})
    expect(store.editorContent).toBe('old')
  })

  /*
   * A file the generation did not touch keeps its buffer, dirty or not. Re-reading
   * every open file on every generation would discard an edit for a reason the
   * user cannot see and the server never asked for.
   */
  it('leaves a file the generation did not write alone', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'old' } }))
    await store.selectFile('index.html')
    store.editContent('my edit')
    fetchMock.mockClear()

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    fetchMock.mockResolvedValueOnce(response(listed))
    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: ['app.js'], fileError: null }))
    stream.close()
    await running

    expect(requests()).toEqual(['POST /generate', 'GET /api/projects/proj-1/files'])
    expect(store.editorContent).toBe('my edit')
    expect(store.fileDirty).toBe(true)
    expect(store.fileReplaced).toBe(false)
  })

  /**
   * AC-41, D22. The window is narrow — the panel is read-only while a stream is
   * open (D21) — so this is an edit typed *before* the send. The server's content
   * wins, and the discard is **announced**: silence is the one thing that is not
   * acceptable, and a merge UI is a slice of its own.
   */
  it('replaces a dirty buffer the generation rewrote and says so', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'old' } }))
    await store.selectFile('index.html')
    store.editContent('my unsaved edit')
    fetchMock.mockClear()

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    fetchMock.mockResolvedValueOnce(response(listed))
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'regenerated' } }))
    stream.push(
      frame('done', { message: ASSISTANT_MESSAGE, files: ['index.html'], fileError: null }),
    )
    stream.close()
    await running

    expect(store.editorContent).toBe('regenerated')
    expect(store.fileDirty).toBe(false)
    expect(store.fileReplaced).toBe(true)
  })

  it('replaces a clean buffer without the notice', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'old' } }))
    await store.selectFile('index.html')
    fetchMock.mockClear()

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    fetchMock.mockResolvedValueOnce(response(listed))
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'regenerated' } }))
    stream.push(
      frame('done', { message: ASSISTANT_MESSAGE, files: ['index.html'], fileError: null }),
    )
    stream.close()
    await running

    expect(store.editorContent).toBe('regenerated')
    expect(store.fileReplaced).toBe(false)
  })

  /**
   * AC-22 — **every open tab** the generation rewrote is re-read, not just the
   * active one, and the notice is per tab.
   *
   * With one buffer this rule had nowhere to be wrong. With a map it does: a
   * generation that rewrites three files while two of them are open has to
   * refresh both, or the tab the user is not looking at holds bytes the server
   * has since replaced — and **Save** from it would put them back.
   *
   * D16's trigger also moves here. Slice 6 cleared the notice on selecting
   * another file; with tabs, "another file" no longer implies leaving this buffer
   * behind, so the trigger is the next edit *in that tab* (or closing it).
   */
  it('re-reads every open tab the generation rewrote, clean and dirty alike', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'old html' } }))
    await store.selectFile('index.html')
    fetchMock.mockResolvedValueOnce(response({ file: { ...APP_FILE, content: 'old js' } }))
    await store.selectFile('app.js')
    // The active tab is dirty; the other is clean.
    store.editContent('my unsaved edit')
    fetchMock.mockClear()

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    fetchMock.mockResolvedValueOnce(response(listed))
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'new html' } }))
    fetchMock.mockResolvedValueOnce(response({ file: { ...APP_FILE, content: 'new js' } }))
    stream.push(
      frame('done', {
        message: ASSISTANT_MESSAGE,
        files: ['index.html', 'app.js'],
        fileError: null,
      }),
    )
    stream.close()
    await running

    expect(requests()).toEqual([
      'POST /generate',
      'GET /api/projects/proj-1/files',
      'GET /api/projects/proj-1/files/index.html',
      'GET /api/projects/proj-1/files/app.js',
    ])

    // The clean one was replaced silently.
    expect(store.buffers['index.html']?.content).toBe('new html')
    expect(store.buffers['index.html']?.replaced).toBe(false)
    // The dirty one was replaced and says so.
    expect(store.buffers['app.js']?.content).toBe('new js')
    expect(store.buffers['app.js']?.replaced).toBe(true)
    expect(store.fileReplaced).toBe(true)
    expect(store.dirtyPaths).toEqual([])

    // D16: the next edit in *that* tab clears its notice, and no other's.
    store.editContent('typing again')
    expect(store.buffers['app.js']?.replaced).toBe(false)
    expect(store.buffers['index.html']?.replaced).toBe(false)
  })

  /* And the notice survives a switch away and back — it belongs to the buffer
   * now, not to the selection (D16). */
  it('keeps the replaced notice across a tab switch', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'old' } }))
    await store.selectFile('index.html')
    store.editContent('my unsaved edit')
    fetchMock.mockResolvedValueOnce(response({ file: { ...APP_FILE, content: 'js' } }))
    await store.selectFile('app.js')
    await store.selectFile('index.html')

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    fetchMock.mockResolvedValueOnce(response(listed))
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'regenerated' } }))
    stream.push(
      frame('done', { message: ASSISTANT_MESSAGE, files: ['index.html'], fileError: null }),
    )
    stream.close()
    await running
    expect(store.fileReplaced).toBe(true)

    await store.selectFile('app.js')
    expect(store.fileReplaced).toBe(false)
    await store.selectFile('index.html')

    expect(store.fileReplaced).toBe(true)
  })

  /**
   * AC-23. A file that is **buffered but closed** has its entry dropped rather
   * than re-read: re-reading every buffer ever opened would make the request
   * count grow with the session, and dropping it keeps the answer correct — the
   * next open fetches the server's copy.
   */
  it('drops a buffered but closed file the generation rewrote', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...APP_FILE, content: 'old js' } }))
    await store.selectFile('app.js')
    store.closeTab('app.js')
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'html' } }))
    await store.selectFile('index.html')
    fetchMock.mockClear()

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    fetchMock.mockResolvedValueOnce(response(listed))
    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: ['app.js'], fileError: null }))
    stream.close()
    await running

    // Its buffer is gone, and nothing was fetched for a tab that is not open.
    expect(store.buffers['app.js']).toBeUndefined()
    expect(requests()).toEqual(['POST /generate', 'GET /api/projects/proj-1/files'])

    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(response({ file: { ...APP_FILE, content: 'new js' } }))
    await store.selectFile('app.js')

    expect(requests()).toEqual(['GET /api/projects/proj-1/files/app.js'])
    expect(store.editorContent).toBe('new js')
  })

  /**
   * AC-24, literally. An empty `files` touches **`buffers` not at all** — not a
   * re-read, not a drop, not a cleared flag — because nothing was stored, so
   * there is no answer that could have changed.
   *
   * Asserted as a deep equality against a snapshot taken before the turn, rather
   * than field by field: the claim is about the whole map, and a per-field check
   * would pass over a buffer that was rebuilt with the same values but a lost
   * `replaced`.
   */
  it('issues no file request and changes no buffer on a done that wrote nothing', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'html' } }))
    await store.selectFile('index.html')
    fetchMock.mockResolvedValueOnce(response({ file: { ...APP_FILE, content: 'js' } }))
    await store.selectFile('app.js')
    store.editContent('my unsaved edit')
    // Through JSON rather than `structuredClone`: the buffers are a Vue reactive
    // proxy, which the structured-clone algorithm refuses, and every field here
    // is a string, a boolean or null.
    const before = JSON.parse(JSON.stringify(store.buffers)) as unknown
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce(
      cannedStream(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null })),
    )
    await store.retryGeneration()

    expect(requests()).toEqual(['POST /generate'])
    expect(store.buffers).toEqual(before)
    expect(store.openTabs).toEqual(['index.html', 'app.js'])
  })

  /*
   * A file that streamed and was then refused leaves a tab pointing at nothing.
   * Closed, so the editor shows its empty state rather than a filename with no
   * file behind it — and the tab list goes back to what it was before the
   * generation borrowed it.
   */
  it('closes a tab the generation opened for a file that was never stored', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    stream.push(frame('file_start', { path: 'secrets.js' }))
    stream.push(frame('file_chunk', { path: 'secrets.js', text: 'x' }))
    await vi.waitFor(() => {
      expect(store.selectedPath).toBe('secrets.js')
    })
    stream.push(
      frame('done', {
        message: ASSISTANT_MESSAGE,
        files: [],
        fileError: 'That reply tried to write to “../secrets.js”, which is not a filename.',
      }),
    )
    stream.close()
    await running

    expect(store.openTabs).toEqual([])
    expect(store.selectedPath).toBeNull()
    expect(store.buffers).toEqual({})
    expect(store.editorContent).toBe('')
  })

  /*
   * The same rule, for the case that bites harder: the stream opened a tab for a
   * file the project **already holds**, and then the set was refused. That tab
   * has no buffer — `file_start` opens, it does not fetch — so leaving it open
   * shows an empty editor for a file with content behind it, and the first
   * keystroke would make it dirty enough for **Save** to offer to replace the
   * real file with whatever was typed.
   *
   * The tab was the generation's, not the user's, and nothing was written, so it
   * goes back to where it was: no tab, and no request issued (AC-24).
   */
  it('closes a tab the generation opened for a stored file the turn did not write', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    stream.push(frame('file_start', { path: 'app.js' }))
    stream.push(frame('file_chunk', { path: 'app.js', text: 'const a = 1' }))
    await vi.waitFor(() => {
      expect(store.selectedPath).toBe('app.js')
    })
    fetchMock.mockClear()

    stream.push(
      frame('done', {
        message: ASSISTANT_MESSAGE,
        files: [],
        fileError: 'Genesis could not save the generated files: "../x.js" is not a file name.',
      }),
    )
    stream.close()
    await running

    expect(store.openTabs).toEqual([])
    expect(store.selectedPath).toBeNull()
    expect(store.editorContent).toBe('')
    expect(store.fileDirty).toBe(false)
    expect(requests()).toEqual([])
  })

  /*
   * And the tab the *user* opened survives a turn that did not write it —
   * closing that one would take away the file they were reading, and discard an
   * edit to it, for a generation that changed nothing about it.
   */
  it('keeps a selection the user made through a turn that wrote nothing', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...APP_FILE, content: 'const a = 1\n' } }))
    await store.selectFile('app.js')
    store.editContent('my unsaved edit')

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running

    expect(store.selectedPath).toBe('app.js')
    expect(store.editorContent).toBe('my unsaved edit')
    expect(store.fileDirty).toBe(true)
  })

  /** AC-42. */
  it('records a fileError and clears it on the next generation', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('done', {
          message: ASSISTANT_MESSAGE,
          files: [],
          fileError: 'That reply left “app.js” unfinished, so nothing was saved.',
        }),
      ),
    )
    await store.retryGeneration()
    expect(store.generateFileError).toBe(
      'That reply left “app.js” unfinished, so nothing was saved.',
    )

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    await vi.waitFor(() => {
      expect(store.generating).toBe(true)
    })

    expect(store.generateFileError).toBeNull()

    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running
  })

  /**
   * AC-43, D21, R4. The one collision that actually happens is a generation's
   * batch against the editor's PUT, and this closes the window at its source
   * rather than detecting it afterwards.
   */
  it('issues no save while a stream is open', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...INDEX_FILE, content: 'old' } }))
    await store.selectFile('index.html')
    store.editContent('my edit')
    fetchMock.mockClear()

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    // Waiting on the request rather than on `generating`: the flag is set a tick
    // before `fetch` is reached, so clearing the log on it races the very call
    // this case is about not seeing a second of.
    await vi.waitFor(() => {
      expect(requests()).toEqual(['POST /generate'])
    })
    fetchMock.mockClear()

    await store.saveFile()

    expect(requests()).toEqual([])
    expect(store.fileDirty).toBe(true)

    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running
  })

  /* A stream that failed wrote nothing (AC-21's store half), so the watched bytes
   * go and the stored list is left exactly as it was. */
  it('drops the streaming buffers when the stream ends in an error', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('file_start', { path: 'app.js' }),
        frame('file_chunk', { path: 'app.js', text: 'const a = 1' }),
        frame('error', {
          error: 'The reply was interrupted.',
          code: 'upstream_error',
          message: null,
        }),
      ),
    )

    await store.retryGeneration()

    expect(store.streamingFiles).toEqual({})
    expect(store.files).toEqual([INDEX_FILE, APP_FILE])
    expect(store.generateError).toBe('The reply was interrupted.')
  })

  /**
   * The same rule the `done` path already applies (P1), for the turn that never
   * reaches `done`.
   *
   * `file_start` opens a tab and creates **no buffer**, and only `done` runs
   * `applyGenerationFiles`. So a stream interrupted after its first file left a
   * tab over a file this session has never read: an empty editor above a file
   * with content, whose keystrokes go nowhere — `editContent` has no buffer to
   * write to — while the byte count reads 0 and **Save** stays dead. Closing it
   * puts the panel back where the generation borrowed it from.
   */
  it('closes a tab the generation opened when the stream ends in an error', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    stream.push(frame('file_start', { path: 'app.js' }))
    stream.push(frame('file_chunk', { path: 'app.js', text: 'const a = 1' }))
    await vi.waitFor(() => {
      expect(store.selectedPath).toBe('app.js')
    })
    fetchMock.mockClear()

    stream.push(
      frame('error', {
        error: 'The reply was interrupted.',
        code: 'upstream_error',
        message: null,
      }),
    )
    stream.close()
    await running

    expect(store.openTabs).toEqual([])
    expect(store.selectedPath).toBeNull()
    expect(store.buffers).toEqual({})
    expect(store.editorContent).toBe('')
    // Nothing was read on the way out: the tab goes, it is not repaired.
    expect(requests()).toEqual([])
  })

  /**
   * And the tab the **user** opened survives the same failure, dirty included.
   * Closing that one would discard an edit for a reason they cannot see, on a
   * turn that changed nothing about the file.
   */
  it('keeps the user’s own tab through a stream that ends in an error', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(response({ file: { ...APP_FILE, content: 'const a = 1\n' } }))
    await store.selectFile('app.js')
    store.editContent('my unsaved edit')

    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('error', {
          error: 'The reply was interrupted.',
          code: 'upstream_error',
          message: null,
        }),
      ),
    )
    await store.retryGeneration()

    expect(store.openTabs).toEqual(['app.js'])
    expect(store.selectedPath).toBe('app.js')
    expect(store.editorContent).toBe('my unsaved edit')
    expect(store.fileDirty).toBe(true)
  })

  /** AC-43's second half, over every field this task added. */
  it('returns every streaming field to its initial value on reset', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('file_start', { path: 'app.js' }),
        frame('file_chunk', { path: 'app.js', text: 'x' }),
        frame('done', {
          message: ASSISTANT_MESSAGE,
          files: [],
          fileError: 'Something was refused.',
        }),
      ),
    )
    await store.retryGeneration()
    expect(store.generateFileError).not.toBeNull()

    store.reset()

    expect(store.streamingFiles).toEqual({})
    expect(store.fileTree).toEqual([])
    expect(store.editorContent).toBe('')
    expect(store.fileReplaced).toBe(false)
    expect(store.generateFileError).toBeNull()
  })

  it('returns them to their initial value when another project is opened', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('done', {
          message: ASSISTANT_MESSAGE,
          files: [],
          fileError: 'Something was refused.',
        }),
      ),
    )
    await store.retryGeneration()

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    expect(store.generateFileError).toBeNull()
    expect(store.fileTree).toEqual([])
  })

  /*
   * The whole reason the counter exists, on the file half: a `done` for the
   * project you have left must not refetch into the one you are looking at.
   */
  it('does not refetch into a project that is no longer open', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    stream.push(frame('file_start', { path: 'app.js' }))
    await vi.waitFor(() => {
      expect(store.generating).toBe(true)
    })

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')
    fetchMock.mockClear()

    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: ['app.js'], fileError: null }))
    stream.close()
    await running

    expect(requests()).toEqual([])
    expect(store.files).toEqual([])
    expect(store.streamingFiles).toEqual({})
  })

  /**
   * AC-23, D12. The rebuild signal moves **after** the refetch, never before.
   *
   * The ordering is the assertion, and it is load-bearing rather than pedantic:
   * `generationsApplied` is what makes the preview rebuild unasked, and the
   * preview assembles its document out of `files`. Bumped before the list
   * settled, the one screen whose entire job is to show what the generation just
   * wrote would build the *previous* turn's file set.
   *
   * `filesRevision` moves on the same event, so the panel that has just rebuilt
   * by itself does not then also claim its files have changed.
   */
  it('increments both counters after the file list has settled, and not before', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    stream.push(
      frame('done', { message: ASSISTANT_MESSAGE, files: ['index.html'], fileError: null }),
    )
    stream.close()
    await vi.waitFor(() => {
      expect(store.filesLoading).toBe(true)
    })

    // The list request is open, so nothing downstream may act on it yet.
    expect(store.generationsApplied).toBe(0)
    expect(store.filesRevision).toBe(0)

    slow.settle(response({ files: [{ ...INDEX_FILE, size: 40 }] }))
    await running

    expect(store.generationsApplied).toBe(1)
    expect(store.filesRevision).toBe(1)
    expect(store.files).toEqual([{ ...INDEX_FILE, size: 40 }])
  })

  /* A turn that stored nothing — prose-only, or a refused op set — issued no
   * request and changed no file, so a rebuild would re-run the app's HighLevel
   * calls to produce the document already on screen. */
  it('leaves both counters at zero on a done that stored no file', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(
      cannedStream(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null })),
    )

    await store.retryGeneration()

    expect(store.generationsApplied).toBe(0)
    expect(store.filesRevision).toBe(0)
  })

  /* Same rule for the turn that never reached `done`: what streamed was watched,
   * not stored (D20), so the stored file set the preview reads is untouched. */
  it('leaves both counters at zero when the stream ends in an error', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('file_start', { path: 'app.js' }),
        frame('file_chunk', { path: 'app.js', text: 'const a = 1' }),
        frame('error', {
          error: 'The reply was interrupted.',
          code: 'upstream_error',
          message: null,
        }),
      ),
    )

    await store.retryGeneration()

    expect(store.generateError).toBe('The reply was interrupted.')
    expect(store.generationsApplied).toBe(0)
    expect(store.filesRevision).toBe(0)
  })

  it('leaves both counters at zero when the generation is aborted', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    stream.push(frame('file_start', { path: 'app.js' }))
    await vi.waitFor(() => {
      expect(store.generating).toBe(true)
    })

    store.reset()
    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: ['app.js'], fileError: null }))
    stream.close()
    await running

    expect(store.generationsApplied).toBe(0)
    expect(store.filesRevision).toBe(0)
  })

  /**
   * And the narrow window the guard exists for: the project is left **while the
   * refetch is in flight**, so the increment is the first thing to run after the
   * `await` returns. A counter bumped there would make the project now on screen
   * rebuild its preview for a generation that belonged to another one.
   */
  it('does not move the counters for a generation whose project was left mid-refetch', async () => {
    const store = await openedWithFiles()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()

    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    stream.push(
      frame('done', { message: ASSISTANT_MESSAGE, files: ['index.html'], fileError: null }),
    )
    stream.close()
    await vi.waitFor(() => {
      expect(store.filesLoading).toBe(true)
    })

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    slow.settle(response({ files: [INDEX_FILE] }))
    await running

    expect(store.generationsApplied).toBe(0)
    expect(store.filesRevision).toBe(0)
  })

  /* Both counters describe one project's file history, so they go back to zero
   * with the rest of it. A preview mounted against a project it has never built
   * for must not read a leftover count as "a generation just landed". */
  it('zeroes both counters on reset', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('done', { message: ASSISTANT_MESSAGE, files: ['index.html'], fileError: null }),
      ),
    )
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE] }))
    await store.retryGeneration()
    expect(store.generationsApplied).toBe(1)

    store.reset()

    expect(store.generationsApplied).toBe(0)
    expect(store.filesRevision).toBe(0)
  })

  it('zeroes both counters when another project is opened', async () => {
    const store = await openedWithFiles()
    fetchMock.mockResolvedValueOnce(
      cannedStream(
        frame('done', { message: ASSISTANT_MESSAGE, files: ['index.html'], fileError: null }),
      ),
    )
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE] }))
    await store.retryGeneration()
    expect(store.filesRevision).toBe(1)

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    expect(store.generationsApplied).toBe(0)
    expect(store.filesRevision).toBe(0)
  })
})

/**
 * Two versions, newest first — the order the list route answers in (D16), which
 * is also the order the sheet renders. `seq` is the human-facing version number
 * and `id` is the document; the two are deliberately different values here, so a
 * test that confuses them fails rather than passing by coincidence.
 */
const SNAPSHOT_OLD = {
  id: 'snap-1',
  seq: 1,
  createdAt: '2026-08-17T09:30:00.000Z',
  origin: 'generation' as const,
  fileCount: 1,
  totalBytes: 24,
}

const SNAPSHOT_NEW = {
  id: 'snap-2',
  seq: 2,
  createdAt: '2026-08-17T10:00:00.000Z',
  origin: 'generation' as const,
  fileCount: 2,
  totalBytes: 35,
}

/**
 * The version history (AC-23, AC-27, AC-28, D21).
 *
 * The list is **asked for**, never pushed: `done`'s SSE payload is unchanged, so
 * the only way the browser learns a version exists is a request. Which request,
 * and when, is the whole of this block — the sheet fetches on every open (P5),
 * and a finished generation refetches **only if** the sheet has been opened this
 * session, because a refetch for a list nobody has looked at is a request whose
 * answer is never rendered.
 */
describe('the snapshot list', () => {
  it('fills the list and marks it loaded', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))

    await store.loadSnapshots()

    expect(requests()).toEqual(['GET /api/projects/proj-1/snapshots'])
    expect(store.snapshots).toEqual([SNAPSHOT_NEW, SNAPSHOT_OLD])
    expect(store.snapshotsLoaded).toBe(true)
    expect(store.snapshotsLoading).toBe(false)
    expect(store.snapshotsError).toBeNull()
  })

  it('is loading while the list request is in flight', async () => {
    const store = await opened()
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)

    const loading = store.loadSnapshots()
    await vi.waitFor(() => {
      expect(store.snapshotsLoading).toBe(true)
    })
    slow.settle(response({ snapshots: [SNAPSHOT_NEW] }))
    await loading

    expect(store.snapshotsLoading).toBe(false)
    expect(store.snapshots).toEqual([SNAPSHOT_NEW])
  })

  /*
   * AC-23's second half, and `loadFiles`'s rule one collection over: a failed
   * refetch emptying the list would say "this project has no history", which is a
   * different claim from "we could not reach the server" and a much worse one to
   * make wrongly — this one under a **Restore** button.
   */
  it('records a failure and leaves any existing list in place', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))
    await store.loadSnapshots()

    fetchMock.mockResolvedValueOnce(response({ error: 'Could not load the history.' }, 500))
    await store.loadSnapshots()

    expect(store.snapshotsError).toBe('Could not load the history.')
    expect(store.snapshots).toEqual([SNAPSHOT_NEW, SNAPSHOT_OLD])
    expect(store.snapshotsLoading).toBe(false)
  })

  /** The sheet's **Try again** — this action and nothing else. */
  it('re-issues the request and clears a previous failure', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ error: 'Something went wrong.' }, 500))
    await store.loadSnapshots()
    expect(store.snapshotsError).toBe('Something went wrong.')

    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW] }))
    await store.loadSnapshots()

    expect(requests()).toEqual([
      'GET /api/projects/proj-1/snapshots',
      'GET /api/projects/proj-1/snapshots',
    ])
    expect(store.snapshotsError).toBeNull()
    expect(store.snapshots).toEqual([SNAPSHOT_NEW])
  })

  it('does nothing without a project open', async () => {
    await useWorkspaceStore().loadSnapshots()

    expect(requests()).toEqual([])
  })

  /**
   * AC-27, D21. A turn that stored files recorded a version, so an **open** sheet
   * would otherwise go stale while the user watches the generation finish behind
   * it. The refetch rides after the file list's, which is where the answer it
   * depends on has just landed.
   */
  it('refetches the list on a done that wrote files, once it has been loaded', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_OLD] }))
    await store.loadSnapshots()
    fetchMock.mockClear()

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, APP_FILE] }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))
    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: ['app.js'], fileError: null }))
    stream.close()
    await running

    expect(requests()).toEqual([
      'POST /generate',
      'GET /api/projects/proj-1/files',
      'GET /api/projects/proj-1/snapshots',
    ])
    expect(store.snapshots).toEqual([SNAPSHOT_NEW, SNAPSHOT_OLD])
  })

  /*
   * AC-27's condition, which is the whole point of `snapshotsLoaded`: a user who
   * never opens the sheet must not pay for a snapshot request on every turn.
   */
  it('issues no snapshot request on a done when the sheet was never opened', async () => {
    const store = await opened()

    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, APP_FILE] }))
    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: ['app.js'], fileError: null }))
    stream.close()
    await running

    expect(requests()).toEqual(['POST /generate', 'GET /api/projects/proj-1/files'])
    expect(store.snapshots).toEqual([])
    expect(store.snapshotsLoaded).toBe(false)
  })

  /*
   * AC-27's other half, and D2 seen from the client: a turn that stored no file
   * wrote no snapshot, so there is no answer that could have changed — even with
   * the sheet open and loaded.
   */
  it('issues no snapshot request on a done that wrote nothing', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_OLD] }))
    await store.loadSnapshots()
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce(
      cannedStream(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null })),
    )
    await store.retryGeneration()

    expect(requests()).toEqual(['POST /generate'])
    expect(store.snapshots).toEqual([SNAPSHOT_OLD])
  })

  /** AC-28. A history belongs to one project and one account. */
  it('returns every snapshot field to its initial value on reset', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))
    await store.loadSnapshots()
    fetchMock.mockResolvedValueOnce(response({ error: 'Could not load the history.' }, 500))
    await store.loadSnapshots()

    store.reset()

    expect(store.snapshots).toEqual([])
    expect(store.snapshotsLoading).toBe(false)
    expect(store.snapshotsLoaded).toBe(false)
    expect(store.snapshotsError).toBeNull()
    expect(store.restoringId).toBeNull()
    expect(store.restoreError).toBeNull()
  })

  it('returns them to their initial value when another project is opened', async () => {
    const store = await opened()
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))
    await store.loadSnapshots()

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    expect(store.snapshots).toEqual([])
    expect(store.snapshotsLoaded).toBe(false)
    expect(store.snapshotsError).toBeNull()
  })

  /*
   * AC-28's second half — the `current(gen)` guard, on the snapshot half. One
   * project's history landing in another's sheet is not merely stale: it offers a
   * **Restore** that would write one project's files over another's.
   */
  it('does not render the previous project’s history', async () => {
    const store = await opened()
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const stale = store.loadSnapshots()

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')

    slow.settle(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))
    await stale

    expect(store.snapshots).toEqual([])
    expect(store.snapshotsLoading).toBe(false)
    expect(store.snapshotsLoaded).toBe(false)
    expect(store.snapshotsError).toBeNull()
  })
})

const ABOUT_FILE = { ...INDEX_FILE, path: 'about.html', size: 12 }

/**
 * Restore, and what it does to the tabs (AC-24, AC-25, AC-26, D12, D22, P6).
 *
 * The response **is** the refetch (D12): the server has just written the
 * documents and answers from what it stored, so `files` is applied directly and
 * no follow-up `GET …/files` is issued. The snapshot *list* is refetched
 * separately, because the safety snapshot (D9) means it genuinely changed.
 *
 * The tab reconciliation is the part with teeth. A restore can rewrite every
 * open file and can **delete** files a generation never could, so a tab left
 * pointing at a path the project no longer holds shows bytes the server has
 * disowned — and **Save** from it would put a deleted file back. Every discarded
 * dirty buffer is announced (D22), origin-neutral: the notice does not care
 * whether it was a generation or a restore that replaced it.
 */
describe('restoreSnapshot', () => {
  const storedIndex = { ...INDEX_FILE, content: '<h1>Contacts</h1>\n' }
  const storedAbout = { ...ABOUT_FILE, content: '<p>About</p>\n' }

  /** A project with two files, its history loaded, and the request log cleared. */
  async function openedWithHistory(): Promise<ReturnType<typeof useWorkspaceStore>> {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, ABOUT_FILE] }))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))
    await store.loadSnapshots()
    fetchMock.mockClear()
    return store
  }

  /** AC-24. The response is the file list; the history is asked for again. */
  it('posts the restore, applies the returned list, and refetches the history', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE], changed: true }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))

    await store.restoreSnapshot('snap-1')

    expect(requests()).toEqual([
      'POST /api/projects/proj-1/snapshots/snap-1/restore',
      'GET /api/projects/proj-1/snapshots',
    ])
    expect(store.files).toEqual([INDEX_FILE])
    expect(store.restoringId).toBeNull()
    expect(store.restoreError).toBeNull()
  })

  /*
   * The tree's three flags move together, or the tree does not move.
   *
   * D12 makes the restore's response *be* the refetch, so it writes `files`
   * directly — but `loadFiles` is the only other writer and it sets `filesLoaded`
   * and clears `filesError` too, which is what `FileTree.vue` renders on. A
   * project whose first `GET /files` failed therefore keeps showing "Try again"
   * over a tree that has just been rewritten by a successful restore: the user
   * pressed Restore, every file changed on the server, and the panel says the
   * files could not be loaded.
   */
  it('clears the tree’s error state, because the response is the refetch', async () => {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ error: 'Nope' }, 500))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    expect(store.filesError).not.toBeNull()
    expect(store.filesLoaded).toBe(false)

    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW] }))
    await store.loadSnapshots()
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE], changed: true }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))
    await store.restoreSnapshot('snap-1')

    expect(store.files).toEqual([INDEX_FILE])
    expect(store.filesError).toBeNull()
    expect(store.filesLoaded).toBe(true)
  })

  /*
   * D18's interlock, in the direction it was not written for.
   *
   * `restoreSnapshot` refuses to start while a generation is open, because the
   * two are writers for one set of documents. Nothing stopped the reverse: with
   * a restore in flight the composer stays live, and a generation that commits
   * *after* the restore's read leaves the restore holding a file list that is
   * now a version behind. Applying it drops the file the generation just wrote
   * out of the tree and closes the tab opened for it, while the file sits on the
   * server — the workspace disagreeing with Firestore until something refetches.
   */
  it('refuses to send while a restore is in flight', async () => {
    const store = await openedWithHistory()
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)

    const restoring = store.restoreSnapshot('snap-1')
    // The POST, not just the flag: `request()` awaits an ID token first, so the
    // flag is set a tick before the call is recorded.
    await vi.waitFor(() => {
      expect(requests()).toEqual(['POST /api/projects/proj-1/snapshots/snap-1/restore'])
    })
    store.draft = 'and now generate something over it'
    expect(store.canSend).toBe(false)
    fetchMock.mockClear()
    await store.send()

    expect(requests()).toEqual([])
    // The draft is kept, exactly as the `generating` guard keeps it.
    expect(store.draft).toBe('and now generate something over it')

    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW] }))
    slow.settle(response({ files: [INDEX_FILE], changed: false }))
    await restoring
  })

  /** AC-24's flag: every row's Restore is disabled for the length of the request. */
  it('names the snapshot being restored for the length of the request', async () => {
    const store = await openedWithHistory()
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)

    const restoring = store.restoreSnapshot('snap-1')
    await vi.waitFor(() => {
      expect(store.restoringId).toBe('snap-1')
    })
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW] }))
    slow.settle(response({ files: [INDEX_FILE], changed: true }))
    await restoring

    expect(store.restoringId).toBeNull()
  })

  /*
   * AC-24's second half. A restore that failed wrote nothing — the server's
   * batch is all-or-nothing — so the workspace must look exactly as it did
   * before, unsaved edits included. Discarding a buffer *because* the restore
   * failed would lose work for a change that never happened.
   */
  it('records a failure and leaves the files, the tabs and every buffer alone', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ file: storedIndex }))
    await store.selectFile('index.html')
    store.editContent('my unsaved edit')
    const before = JSON.parse(JSON.stringify(store.buffers)) as unknown
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce(
      response({ error: 'That version could not be restored. Try again.' }, 500),
    )
    await store.restoreSnapshot('snap-1')

    expect(requests()).toEqual(['POST /api/projects/proj-1/snapshots/snap-1/restore'])
    expect(store.restoreError).toBe('That version could not be restored. Try again.')
    expect(store.restoringId).toBeNull()
    expect(store.files).toEqual([INDEX_FILE, ABOUT_FILE])
    expect(store.openTabs).toEqual(['index.html'])
    expect(store.buffers).toEqual(before)
  })

  it('clears a previous restore error on the next successful restore', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ error: 'Something went wrong.' }, 500))
    await store.restoreSnapshot('snap-1')
    expect(store.restoreError).toBe('Something went wrong.')

    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE], changed: true }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW] }))
    await store.restoreSnapshot('snap-1')

    expect(store.restoreError).toBeNull()
  })

  /**
   * AC-25, whole. Two tabs, a restored set holding one of them:
   *
   * - `index.html` is **re-read**, because the bytes behind it have changed;
   * - `about.html`'s tab is **closed** and its buffer dropped, because the path
   *   is gone and a tab over a deleted file would offer to Save it back;
   * - the dirty buffer's discard is **announced** (D22).
   */
  it('re-reads a surviving tab, closes a deleted one, and announces the discard', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ file: storedIndex }))
    await store.selectFile('index.html')
    fetchMock.mockResolvedValueOnce(response({ file: storedAbout }))
    await store.selectFile('about.html')
    await store.selectFile('index.html')
    store.editContent('my unsaved edit')
    fetchMock.mockClear()
    expect(store.openTabs).toEqual(['index.html', 'about.html'])

    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE], changed: true }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))
    fetchMock.mockResolvedValueOnce(
      response({ file: { ...INDEX_FILE, content: '<h1>Restored</h1>\n' } }),
    )
    await store.restoreSnapshot('snap-1')

    expect(requests()).toEqual([
      'POST /api/projects/proj-1/snapshots/snap-1/restore',
      'GET /api/projects/proj-1/snapshots',
      'GET /api/projects/proj-1/files/index.html',
    ])
    expect(store.openTabs).toEqual(['index.html'])
    expect(store.selectedPath).toBe('index.html')
    expect(store.buffers['about.html']).toBeUndefined()
    expect(store.editorContent).toBe('<h1>Restored</h1>\n')
    expect(store.fileDirty).toBe(false)
    expect(store.fileReplaced).toBe(true)
  })

  it('re-reads a clean surviving tab without the notice', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ file: storedIndex }))
    await store.selectFile('index.html')
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE], changed: true }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW] }))
    fetchMock.mockResolvedValueOnce(
      response({ file: { ...INDEX_FILE, content: '<h1>Restored</h1>\n' } }),
    )
    await store.restoreSnapshot('snap-1')

    expect(store.editorContent).toBe('<h1>Restored</h1>\n')
    expect(store.fileReplaced).toBe(false)
  })

  /**
   * P6. `applyGenerationFiles` drops the closed buffers a generation *rewrote*;
   * a restore potentially rewrites or deletes everything, so the equivalent set
   * is **all of them** — the response carries no per-path record of what moved.
   * The next open fetches the server's copy, which is the same guarantee reached
   * the same way, and no request is issued for a tab nobody has open.
   */
  it('drops every closed-but-buffered file, and the next open re-fetches it', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ file: storedAbout }))
    await store.selectFile('about.html')
    store.closeTab('about.html')
    fetchMock.mockResolvedValueOnce(response({ file: storedIndex }))
    await store.selectFile('index.html')
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, ABOUT_FILE], changed: true }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW] }))
    fetchMock.mockResolvedValueOnce(response({ file: storedIndex }))
    await store.restoreSnapshot('snap-1')

    expect(store.buffers['about.html']).toBeUndefined()
    expect(requests()).toEqual([
      'POST /api/projects/proj-1/snapshots/snap-1/restore',
      'GET /api/projects/proj-1/snapshots',
      'GET /api/projects/proj-1/files/index.html',
    ])

    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(response({ file: { ...ABOUT_FILE, content: 'restored' } }))
    await store.selectFile('about.html')

    expect(requests()).toEqual(['GET /api/projects/proj-1/files/about.html'])
    expect(store.editorContent).toBe('restored')
  })

  /*
   * D10 from the client's side. `changed: false` is the project already being
   * this version: nothing was written, so nothing on screen is stale — and
   * re-reading the tabs would discard an unsaved edit for a change that did not
   * happen. The list is still applied, because it is the server's own word.
   */
  it('leaves every tab and buffer alone when nothing changed', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ file: storedIndex }))
    await store.selectFile('index.html')
    store.editContent('my unsaved edit')
    const before = JSON.parse(JSON.stringify(store.buffers)) as unknown
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, ABOUT_FILE], changed: false }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW] }))
    await store.restoreSnapshot('snap-1')

    expect(requests()).toEqual([
      'POST /api/projects/proj-1/snapshots/snap-1/restore',
      'GET /api/projects/proj-1/snapshots',
    ])
    expect(store.buffers).toEqual(before)
    expect(store.editorContent).toBe('my unsaved edit')
    expect(store.fileDirty).toBe(true)
  })

  /**
   * AC-26. A restore and a generation are two writers for one set of documents,
   * and the sheet is reachable while a stream is open — so the store re-checks
   * the rule the sheet renders, because nothing guarantees the click came from
   * the button.
   */
  it('issues no request while a generation is open', async () => {
    const store = await openedWithHistory()
    const stream = pushableStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    const running = store.retryGeneration()
    // The stream's own request, waited for rather than assumed: `generating` is
    // set before `fetch` is reached, so clearing the log on the flag alone races
    // the very call this case is counting.
    await vi.waitFor(() => {
      expect(store.generating).toBe(true)
      expect(requests()).toEqual(['POST /generate'])
    })
    fetchMock.mockClear()

    await store.restoreSnapshot('snap-1')

    expect(requests()).toEqual([])
    expect(store.restoringId).toBeNull()

    stream.push(frame('done', { message: ASSISTANT_MESSAGE, files: [], fileError: null }))
    stream.close()
    await running
  })

  /** A second restore would race its own response, and the later reply wins. */
  it('issues no second request while a restore is already in flight', async () => {
    const store = await openedWithHistory()
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const first = store.restoreSnapshot('snap-1')
    await vi.waitFor(() => {
      expect(store.restoringId).toBe('snap-1')
    })

    await store.restoreSnapshot('snap-2')

    expect(requests()).toEqual(['POST /api/projects/proj-1/snapshots/snap-1/restore'])
    expect(store.restoringId).toBe('snap-1')

    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW] }))
    slow.settle(response({ files: [INDEX_FILE], changed: true }))
    await first
  })

  it('issues no request without a project open', async () => {
    await useWorkspaceStore().restoreSnapshot('snap-1')

    expect(requests()).toEqual([])
  })

  /*
   * AC-28's restore half. A restore answering for a project the user has left
   * must not write another project's files into the panel in front of them.
   */
  it('does not apply a restore that lands after another project was opened', async () => {
    const store = await openedWithHistory()
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const stale = store.restoreSnapshot('snap-1')

    fetchMock.mockResolvedValueOnce(response({ project: OTHER_PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [] }))
    await store.open('proj-2')
    fetchMock.mockClear()

    slow.settle(response({ files: [INDEX_FILE], changed: true }))
    await stale

    expect(requests()).toEqual([])
    expect(store.files).toEqual([])
    expect(store.restoringId).toBeNull()
    expect(store.restoreError).toBeNull()
  })
})

/**
 * What a restore owes the preview — found at ship time, when Slice 10 rebased
 * onto a `main` that had already taken Slice 11.
 *
 * The two slices never touched the same lines: Slice 11 wrote `restoreSnapshot`,
 * Slice 10 wrote the two counters, and the rebase produced one trivial conflict in
 * the store's exported interface. The result was still wrong. A restore rewrites
 * the **whole** stored file set — Slice 10's `filesRevision` counts exactly that,
 * and moved for a one-file save while sitting still for a twenty-file rollback.
 * The preview kept rendering the version the user had just replaced, with no hint
 * that it was stale and no way to know except pressing Refresh on spec.
 *
 * `generationsApplied` deliberately does **not** move (Slice 10, D12). It is the
 * unasked rebuild, and every rebuild re-runs the generated app's HighLevel calls
 * against a 100-request/10-second account budget; a restore is a deliberate act
 * whose result the user may want to read before spending that. The hint is the
 * honest middle, and it is the same answer a save gets for the same reason.
 */
describe('restoreSnapshot — the preview’s signals', () => {
  async function openedWithHistory(): Promise<ReturnType<typeof useWorkspaceStore>> {
    fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, ABOUT_FILE] }))
    const store = useWorkspaceStore()
    await store.open('proj-1')
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))
    await store.loadSnapshots()
    fetchMock.mockClear()
    return store
  }

  it('moves filesRevision and not generationsApplied on a restore that changed the files', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE], changed: true }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))

    await store.restoreSnapshot('snap-1')

    expect(store.filesRevision).toBe(1)
    expect(store.generationsApplied).toBe(0)
  })

  /*
   * Slice 11's D10: `changed: false` is the project already *being* that version.
   * Nothing was written, so the document on screen is the document the files
   * describe — offering a Refresh would spend a rebuild to render it again.
   */
  it('moves neither counter when the restore changed nothing', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ files: [INDEX_FILE, ABOUT_FILE], changed: false }))
    fetchMock.mockResolvedValueOnce(response({ snapshots: [SNAPSHOT_NEW, SNAPSHOT_OLD] }))

    await store.restoreSnapshot('snap-1')

    expect(store.filesRevision).toBe(0)
    expect(store.generationsApplied).toBe(0)
  })

  /* A restore that failed wrote nothing — the batch is all-or-nothing. */
  it('moves neither counter when the restore fails', async () => {
    const store = await openedWithHistory()
    fetchMock.mockResolvedValueOnce(response({ error: 'Could not restore that version.' }, 500))

    await store.restoreSnapshot('snap-1')

    expect(store.restoreError).not.toBeNull()
    expect(store.filesRevision).toBe(0)
    expect(store.generationsApplied).toBe(0)
  })
})
