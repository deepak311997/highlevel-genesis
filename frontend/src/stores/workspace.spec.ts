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

/** The happy path: the project resolves, then an empty transcript. */
function respondOpenOk(): void {
  fetchMock.mockResolvedValueOnce(response({ project: PROJECT }))
  fetchMock.mockResolvedValueOnce(response({ messages: [] }))
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

    expect(requests()).toEqual(['GET /api/projects/proj-1', 'GET /api/projects/proj-1/messages'])
    for (const index of [0, 1]) {
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
    const store = useWorkspaceStore()
    await store.open('proj-1')
    expect(store.messages).toHaveLength(1)

    fetchMock.mockResolvedValueOnce(response({ project: { ...PROJECT, id: 'proj-2' } }))
    fetchMock.mockResolvedValueOnce(response({ messages: [] }))
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
    const store = useWorkspaceStore()
    await store.open('proj-1')
    expect(store.messagesError).toBe('Something went wrong.')

    fetchMock.mockResolvedValueOnce(response({ messages: [USER_MESSAGE] }))
    await store.loadMessages()

    expect(requests()).toEqual([
      'GET /api/projects/proj-1',
      'GET /api/projects/proj-1/messages',
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
