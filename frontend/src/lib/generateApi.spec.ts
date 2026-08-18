import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authHeaders = vi.hoisted(() => vi.fn())

// Stubbed so importing `apiClient` for real below cannot reach the Firebase
// SDK: the session-expiry latch is module state, and the only way to assert
// this client shares it with `request` is to exercise the real one (AC-16).
vi.mock('@/lib/firebase', () => ({ auth: { currentUser: null } }))
vi.mock('@/lib/appCheck', () => ({ appCheckHeader: () => Promise.resolve({}) }))

vi.mock('@/lib/apiClient', async () => ({
  ...(await vi.importActual<typeof import('./apiClient')>('./apiClient')),
  authHeaders,
}))

const { streamGeneration } = await import('./generateApi')

/** A turn carrying a prompt. `{ retry: true }` is the other shape. */
const TURN = { content: 'Build a contacts view' } as const
const { registerSessionExpiredHook } = await import('./apiClient')
const { ApiError } = await import('./api')

/**
 * The streaming client — the one call in the app that cannot go through
 * `request`, because it must not read its body as JSON.
 *
 * **D9's two channels are one code path on this side.** A refusal decided before
 * the server flushed its headers is an ordinary JSON error with a real status,
 * so it *rejects* — before yielding anything, which is what stops a placeholder
 * bubble appearing for a request that never opened. A failure that happened
 * mid-stream arrives as an `error` event on a 200, so it is yielded like any
 * other. The caller therefore has one `try` and one loop rather than two ways to
 * learn the same thing.
 */

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const MESSAGE = {
  id: 'msg-2',
  role: 'assistant' as const,
  content: 'Here is a contact dashboard',
  createdAt: '2026-08-17T09:00:00.000Z',
  truncated: false,
  error: null,
}

/** A `Response` whose body streams the given chunks, in order. */
function streaming(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder()
  let index = 0

  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            index < chunks.length
              ? { done: false, value: encoder.encode(chunks[index++]) }
              : { done: true, value: undefined },
          ),
        cancel: () => Promise.resolve(),
      }),
    },
  } as unknown as Response
}

/** A refused response — JSON, with no stream at all (D9). */
function refused(body: unknown, status: number): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
    body: null,
  } as unknown as Response
}

/** A 200 that carries no stream at all — a server that answered nothing. */
function bodiless(): Response {
  return { ok: true, status: 200, body: null } as unknown as Response
}

/**
 * A `Response` whose stream delivers the given chunks and then **drops**.
 *
 * The shape of a connection lost after the headers flushed: the reader resolves
 * normally for a while and then rejects, which is a different failure from the
 * opening `fetch` throwing and is why it needs its own handling.
 */
function dropping(chunks: readonly string[], reason: Error): Response {
  const encoder = new TextEncoder()
  let index = 0

  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          index < chunks.length
            ? Promise.resolve({ done: false, value: encoder.encode(chunks[index++]) })
            : Promise.reject(reason),
        cancel: () => Promise.resolve(),
      }),
    },
  } as unknown as Response
}

/**
 * A `Response` whose reader never ends, and whose `cancel` is observable.
 *
 * The shape of a generation still in flight: the server is producing tokens and
 * will go on producing them until it is told to stop or reaches `max_tokens`.
 * What a consumer that walks away does with that is the question the tests
 * below ask.
 */
function endless(cancel: () => Promise<void>): Response {
  const encoder = new TextEncoder()

  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve({ done: false, value: encoder.encode(frame('token', { text: 'x' })) }),
        cancel,
      }),
    },
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1) ?? []
  return [String(call[0]), (call[1] ?? {}) as RequestInit]
}

async function collect(signal = new AbortController().signal): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const event of streamGeneration('proj-1', { content: 'Build a contacts view' }, signal)) out.push(event)
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  authHeaders.mockResolvedValue({
    Authorization: 'Bearer id-token-1',
    'X-Firebase-AppCheck': 'app-check-token',
  })
  fetchMock = vi.fn().mockResolvedValue(streaming([frame('done', { message: MESSAGE })]))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  registerSessionExpiredHook(null)
  vi.unstubAllGlobals()
})

describe('streamGeneration — the request', () => {
  /** AC-30. */
  it('POSTs to /generate with the project and the prompt', async () => {
    await collect()
    const [url, init] = lastCall()

    expect(url).toContain('/generate')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"projectId":"proj-1","content":"Build a contacts view"}')
  })

  it('sends both credentials and a JSON content type', async () => {
    await collect()
    const headers = lastCall()[1].headers as Record<string, string>

    expect(headers['Authorization']).toBe('Bearer id-token-1')
    expect(headers['X-Firebase-AppCheck']).toBe('app-check-token')
    expect(headers['Content-Type']).toBe('application/json')
  })

  /* The prompt is not in the body (D2): the transcript is the server's record. */
  /*
   * The prompt travels with the request that streams the reply, so a turn
   * cannot half-happen. Nothing else a chat payload tends to carry goes with
   * it — no role, no model, no transcript: those are the server's.
   */
  it('sends the project and the prompt, and nothing else', async () => {
    await collect()

    // The client always sends a JSON string; narrowed rather than coerced, since
    // `RequestInit['body']` also admits shapes with no useful stringification.
    const { body } = lastCall()[1]
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({
      projectId: 'proj-1',
      content: 'Build a contacts view',
    })
  })

  /* A retry names itself and carries no prompt: the turn is already stored. */
  it('sends retry instead of a prompt when re-running a turn', async () => {
    fetchMock.mockResolvedValueOnce(streaming([`event: done\ndata: {"message":null}\n\n`]))
    const drained = streamGeneration('proj-1', { retry: true }, new AbortController().signal)
    for await (const event of drained) void event

    const { body } = lastCall()[1]
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({
      projectId: 'proj-1',
      retry: true,
    })
  })

  it('passes the abort signal through to fetch', async () => {
    const controller = new AbortController()

    await collect(controller.signal)

    expect(lastCall()[1].signal).toBe(controller.signal)
  })
})

describe('streamGeneration — the events', () => {
  it('yields tokens then done, in order', async () => {
    fetchMock.mockResolvedValue(
      streaming([
        ': keep-alive\n\n',
        frame('token', { text: 'Here is ' }),
        frame('token', { text: 'a contact dashboard' }),
        frame('done', { message: MESSAGE }),
      ]),
    )

    await expect(collect()).resolves.toEqual([
      { type: 'token', text: 'Here is ' },
      { type: 'token', text: 'a contact dashboard' },
      // From Slice 6 a `done` always carries `files` and `fileError`; a server
      // that sends neither defaults to "no files were written", which is the
      // truthful answer as well as the safe one.
      { type: 'done', message: MESSAGE, files: [], fileError: null },
    ])
  })

  /* A mid-stream failure is a 200 with an `error` event, not a rejection. */
  it('yields an error event carrying the persisted partial', async () => {
    fetchMock.mockResolvedValue(
      streaming([
        frame('token', { text: 'Here is ' }),
        frame('error', {
          error: 'The reply was interrupted. Try again.',
          code: 'upstream',
          message: { ...MESSAGE, truncated: true },
        }),
      ]),
    )

    await expect(collect()).resolves.toEqual([
      { type: 'token', text: 'Here is ' },
      {
        type: 'error',
        error: 'The reply was interrupted. Try again.',
        code: 'upstream',
        message: { ...MESSAGE, truncated: true },
      },
    ])
  })

  it('yields an error event whose message is null', async () => {
    fetchMock.mockResolvedValue(
      streaming([frame('error', { error: 'Declined.', code: 'refused', message: null })]),
    )

    await expect(collect()).resolves.toEqual([
      { type: 'error', error: 'Declined.', code: 'refused', message: null },
    ])
  })

  /*
   * A frame split across chunks is the normal case, not an edge one — the same
   * fact `sse.ts` exists for, asserted once here so the two are wired together.
   */
  it('reassembles a frame split across chunks', async () => {
    const whole = frame('token', { text: 'a contact dashboard' })
    fetchMock.mockResolvedValue(streaming([whole.slice(0, 20), whole.slice(20)]))

    await expect(collect()).resolves.toEqual([{ type: 'token', text: 'a contact dashboard' }])
  })

  /*
   * Unrecognised events are skipped rather than thrown, which is what let Slice 6
   * add the three file events without changing anything above this line. The
   * example moved from `file_start` to a name nothing sends, because `file_start`
   * is recognised now.
   */
  it('skips an event it does not recognise', async () => {
    fetchMock.mockResolvedValue(
      streaming([frame('snapshot', { id: 'snap-1' }), frame('done', { message: MESSAGE })]),
    )

    await expect(collect()).resolves.toEqual([
      { type: 'done', message: MESSAGE, files: [], fileError: null },
    ])
  })

  it('skips a token frame whose payload is the wrong shape', async () => {
    fetchMock.mockResolvedValue(
      streaming([frame('token', { text: 42 }), frame('done', { message: MESSAGE })]),
    )

    await expect(collect()).resolves.toEqual([
      { type: 'done', message: MESSAGE, files: [], fileError: null },
    ])
  })
})

describe('streamGeneration — refusals', () => {
  /*
   * AC-31. **Rejects, and yields nothing.** Before the flush the server answers
   * with a real status and the ordinary envelope, and the store has to be able
   * to show that message without ever having opened a placeholder bubble.
   */
  it('rejects with an ApiError carrying the server’s message and status', async () => {
    fetchMock.mockResolvedValue(refused({ error: 'That project no longer exists.' }, 404))

    await expect(collect()).rejects.toBeInstanceOf(ApiError)
    await expect(collect()).rejects.toMatchObject({
      status: 404,
      message: 'That project no longer exists.',
    })
  })

  it('yields no events at all when the response is not ok', async () => {
    fetchMock.mockResolvedValue(refused({ error: 'Sign in and try again.' }, 401))
    const seen: unknown[] = []

    await expect(
      (async () => {
        for await (const event of streamGeneration('proj-1', TURN, new AbortController().signal)) {
          seen.push(event)
        }
      })(),
    ).rejects.toThrow()

    expect(seen).toEqual([])
  })

  it('tells a throttled caller to wait rather than that something went wrong', async () => {
    fetchMock.mockResolvedValue(refused({}, 429))

    await expect(collect()).rejects.toThrow(/Too many attempts/)
  })

  /* A network failure has no status and no body — it still has to be renderable. */
  it('maps a network failure to a message the user can act on', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(collect()).rejects.toMatchObject({
      status: 0,
      message: expect.stringMatching(/connection/i) as unknown as string,
    })
  })

  /* A 200 with no body at all is a server that answered nothing. */
  it('rejects when the response carries no body', async () => {
    fetchMock.mockResolvedValue(bodiless())

    await expect(collect()).rejects.toBeInstanceOf(ApiError)
  })
})

/**
 * AC-16. The stream is not a hole in the sign-out hook.
 *
 * `streamGeneration` is the one call that cannot go through `request`, so
 * without this it is also the one call that could meet a dead session and say
 * nothing about it — and it is the call a user is most likely to make on a tab
 * left open long enough for the session to die.
 */
describe('streamGeneration — the session hook', () => {
  it('invokes the session hook when the stream is refused with a 401 unauthenticated', async () => {
    const hook = vi.fn()
    registerSessionExpiredHook(hook)
    fetchMock.mockResolvedValue(
      refused({ error: 'Sign in and try again.', code: 'unauthenticated' }, 401),
    )

    await expect(collect()).rejects.toBeInstanceOf(ApiError)
    expect(hook).toHaveBeenCalledTimes(1)
  })

  /* The page failed attestation, not the session — reloading fixes it, and
   * signing the user out would throw away the reply they are waiting for. */
  it('does not invoke it for a 401 app_check_failed', async () => {
    const hook = vi.fn()
    registerSessionExpiredHook(hook)
    fetchMock.mockResolvedValue(
      refused(
        {
          error: 'Request could not be verified. Reload the page and try again.',
          code: 'app_check_failed',
        },
        401,
      ),
    )

    await expect(collect()).rejects.toThrow('Request could not be verified')
    expect(hook).not.toHaveBeenCalled()
  })

  /* A stream that opened proves the session is alive, so the next death is a
   * new one — the same latch, cleared from the same place `request` clears it. */
  it('re-arms the hook once a stream has opened', async () => {
    const hook = vi.fn()
    registerSessionExpiredHook(hook)
    const dead = () => refused({ error: 'Sign in and try again.', code: 'unauthenticated' }, 401)

    fetchMock.mockResolvedValue(dead())
    await expect(collect()).rejects.toThrow()

    fetchMock.mockResolvedValue(streaming([frame('done', { message: MESSAGE })]))
    await collect()

    fetchMock.mockResolvedValue(dead())
    await expect(collect()).rejects.toThrow()

    expect(hook).toHaveBeenCalledTimes(2)
  })
})

/**
 * The file half of the protocol (AC-36, D5).
 *
 * Every frame repeats its path, which is what lets the store route a chunk
 * without tracking a mode — and what stops a client that dropped a `file_start`
 * from misrouting code into the chat bubble. Malformed frames are **skipped**
 * rather than thrown, because a stream that dies on one bad frame loses the whole
 * reply including the terminal event.
 */
describe('the file events', () => {
  it('yields file_start, file_chunk and file_end as typed events', async () => {
    fetchMock.mockResolvedValue(
      streaming([
        frame('file_start', { path: 'index.html' }),
        frame('file_chunk', { path: 'index.html', text: '<h1>x</h1>\n' }),
        frame('file_end', { path: 'index.html' }),
        frame('done', { message: MESSAGE, files: ['index.html'], fileError: null }),
      ]),
    )

    expect(await collect()).toEqual([
      { type: 'file_start', path: 'index.html' },
      { type: 'file_chunk', path: 'index.html', text: '<h1>x</h1>\n' },
      { type: 'file_end', path: 'index.html' },
      { type: 'done', message: MESSAGE, files: ['index.html'], fileError: null },
    ])
  })

  it('carries files and fileError off a done frame', async () => {
    fetchMock.mockResolvedValue(
      streaming([
        frame('done', {
          message: MESSAGE,
          files: ['app.js', 'index.html'],
          fileError: 'Genesis could not save the generated files.',
        }),
      ]),
    )

    expect(await collect()).toEqual([
      {
        type: 'done',
        message: MESSAGE,
        files: ['app.js', 'index.html'],
        fileError: 'Genesis could not save the generated files.',
      },
    ])
  })

  /*
   * A `done` from a server that predates the file half — or one whose fields
   * arrived malformed — must still replace the placeholder bubble. Defaulting is
   * the difference between "no files were written" and a broken reply.
   */
  it.each([
    ['no new fields at all', { message: MESSAGE }],
    ['a non-array files', { message: MESSAGE, files: 'index.html', fileError: null }],
    ['a files carrying non-strings', { message: MESSAGE, files: [1, 2], fileError: null }],
    ['a non-string fileError', { message: MESSAGE, files: [], fileError: 42 }],
  ])('defaults a done with %s to no files and no error', async (_label, data) => {
    fetchMock.mockResolvedValue(streaming([frame('done', data)]))

    expect(await collect()).toEqual([
      { type: 'done', message: MESSAGE, files: [], fileError: null },
    ])
  })

  it.each([
    ['a file_start with no path', 'file_start', {}],
    ['a file_start with a numeric path', 'file_start', { path: 7 }],
    ['a file_chunk with no path', 'file_chunk', { text: 'x' }],
    ['a file_chunk with no text', 'file_chunk', { path: 'app.js' }],
    ['a file_end with no path', 'file_end', {}],
  ])('skips %s rather than throwing', async (_label, name, data) => {
    fetchMock.mockResolvedValue(
      streaming([
        frame(name, data),
        frame('done', { message: MESSAGE, files: [], fileError: null }),
      ]),
    )

    expect(await collect()).toEqual([
      { type: 'done', message: MESSAGE, files: [], fileError: null },
    ])
  })

  /* An empty chunk is legal — the server never sends one, and skipping it would
   * be a client deciding what the protocol means. */
  it('keeps a file_chunk carrying an empty string', async () => {
    fetchMock.mockResolvedValue(streaming([frame('file_chunk', { path: 'app.js', text: '' })]))

    expect(await collect()).toEqual([{ type: 'file_chunk', path: 'app.js', text: '' }])
  })
})

/**
 * AC-8. A connection that drops **after** the stream opened speaks our language.
 *
 * The opening `fetch`'s own failure was already mapped to `ApiError(…, 0)`; the
 * read loop's was not, so whatever the browser called it went straight to the
 * screen — `Failed to fetch` in Chrome, `NetworkError when attempting to fetch
 * resource.` in Firefox. Two browsers, two strings, neither ours, and F8.2 asks
 * for a retry the user understands the need for.
 */
describe('streamGeneration — a connection that drops mid-stream', () => {
  it('maps a mid-stream read failure to a message the user can act on', async () => {
    fetchMock.mockResolvedValue(
      dropping([frame('token', { text: 'Here' })], new TypeError('Failed to fetch')),
    )

    const seen: unknown[] = []
    const walk = (async () => {
      for await (const event of streamGeneration('proj-1', TURN, new AbortController().signal)) {
        seen.push(event)
      }
    })()

    await expect(walk).rejects.toMatchObject({
      status: 0,
      message: 'Something went wrong. Check your connection and try again.',
    })
    await expect(walk).rejects.toBeInstanceOf(ApiError)

    // The events that did arrive are still the caller's — the partial reply is
    // what the transcript keeps and what Retry is offered under.
    expect(seen).toEqual([{ type: 'token', text: 'Here' }])
  })

  it('says nothing about what the browser called it', async () => {
    fetchMock.mockResolvedValue(dropping([], new TypeError('Failed to fetch')))

    await expect(collect()).rejects.not.toThrow(/Failed to fetch/)
  })

  /*
   * A user who left the project is not a user whose connection dropped, and
   * telling them to check it would be a lie. The original rejection propagates.
   */
  it('rethrows a cancellation unchanged', async () => {
    const controller = new AbortController()
    const cancelled = new DOMException('The operation was aborted.', 'AbortError')
    fetchMock.mockResolvedValue(dropping([], cancelled))
    controller.abort()

    await expect(collect(controller.signal)).rejects.toBe(cancelled)
  })
})

/**
 * A consumer that stops reading has to stop the *request*, not just its own
 * loop.
 *
 * Breaking out of a `for await`, or throwing inside one, finalises this
 * generator — but finalising a generator does not close a `fetch` body. The
 * socket stays open, `generate`'s `res.on('close')` never fires, and the model
 * goes on producing to `max_tokens: 64000` for a reply nobody will ever read.
 * That is a full completion billed for nothing, and the store has a real path
 * into it: any throw from the loop body in `runGeneration` — `openTab`, the
 * `messages` spread, `applyGenerationFiles` — is swallowed by the `catch` below
 * it, and its `finally` nulls the controller without aborting it.
 *
 * So the generator releases the body itself, on every exit. That is the one
 * place that cannot be forgotten by a caller.
 */
describe('streamGeneration — a consumer that stops reading', () => {
  it('cancels the body when the consumer breaks out of the loop', async () => {
    const cancel = vi.fn(() => Promise.resolve())
    fetchMock.mockResolvedValue(endless(cancel))

    for await (const event of streamGeneration('proj-1', TURN, new AbortController().signal)) {
      expect(event).toEqual({ type: 'token', text: 'x' })
      break
    }

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels the body when the consumer throws', async () => {
    const cancel = vi.fn(() => Promise.resolve())
    fetchMock.mockResolvedValue(endless(cancel))
    const boom = new Error('openTab blew up')

    const walk = (async () => {
      for await (const event of streamGeneration('proj-1', TURN, new AbortController().signal)) {
        expect(event).toEqual({ type: 'token', text: 'x' })
        throw boom
      }
    })()

    await expect(walk).rejects.toBe(boom)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  /*
   * `cancel()` rejects on a stream that already errored — which is precisely the
   * case a dropped connection brings us to — so the release must not turn a
   * mapped `ApiError` into an unhandled rejection, or into the wrong error.
   */
  it('still reports the connection failure when releasing the body rejects', async () => {
    const encoder = new TextEncoder()
    let index = 0
    const chunks = [frame('token', { text: 'Here' })]
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            index < chunks.length
              ? Promise.resolve({ done: false, value: encoder.encode(chunks[index++]) })
              : Promise.reject(new TypeError('Failed to fetch')),
          cancel: () => Promise.reject(new TypeError('Failed to fetch')),
        }),
      },
    })

    await expect(collect()).rejects.toMatchObject({
      status: 0,
      message: 'Something went wrong. Check your connection and try again.',
    })
  })
})
