import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authHeaders = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({ authHeaders }))

const { streamGeneration } = await import('./generateApi')
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

let fetchMock: ReturnType<typeof vi.fn>

function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1) ?? []
  return [String(call[0]), (call[1] ?? {}) as RequestInit]
}

async function collect(signal = new AbortController().signal): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const event of streamGeneration('proj-1', signal)) out.push(event)
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
  vi.unstubAllGlobals()
})

describe('streamGeneration — the request', () => {
  /** AC-30. */
  it('POSTs to /generate with a body of exactly { projectId }', async () => {
    await collect()
    const [url, init] = lastCall()

    expect(url).toContain('/generate')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"projectId":"proj-1"}')
  })

  it('sends both credentials and a JSON content type', async () => {
    await collect()
    const headers = lastCall()[1].headers as Record<string, string>

    expect(headers['Authorization']).toBe('Bearer id-token-1')
    expect(headers['X-Firebase-AppCheck']).toBe('app-check-token')
    expect(headers['Content-Type']).toBe('application/json')
  })

  /* The prompt is not in the body (D2): the transcript is the server's record. */
  it('sends no prompt, role or content', async () => {
    await collect()

    // The client always sends a JSON string; narrowed rather than coerced, since
    // `RequestInit['body']` also admits shapes with no useful stringification.
    const { body } = lastCall()[1]
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({ projectId: 'proj-1' })
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
        for await (const event of streamGeneration('proj-1', new AbortController().signal)) {
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
