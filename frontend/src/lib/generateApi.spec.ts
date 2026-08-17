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
      { type: 'done', message: MESSAGE },
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

  /* Unrecognised events are skipped rather than thrown — Slice 6 adds handlers. */
  it('skips an event it does not recognise', async () => {
    fetchMock.mockResolvedValue(
      streaming([frame('file_start', { path: 'src/app.js' }), frame('done', { message: MESSAGE })]),
    )

    await expect(collect()).resolves.toEqual([{ type: 'done', message: MESSAGE }])
  })

  it('skips a token frame whose payload is the wrong shape', async () => {
    fetchMock.mockResolvedValue(
      streaming([frame('token', { text: 42 }), frame('done', { message: MESSAGE })]),
    )

    await expect(collect()).resolves.toEqual([{ type: 'done', message: MESSAGE }])
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
