import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({ request }))

const { listMessages, sendMessage, MESSAGE_LIMIT } = await import('./messagesApi')

/**
 * The typed client for the two message routes.
 *
 * `request` is mocked here rather than `fetch`: header assembly has its own suite
 * in `apiClient.spec.ts`, and what is worth asserting at this level is the
 * contract — which path, which verb, which body.
 *
 * The body assertion is the one with a reason beyond symmetry. `POST` sends
 * `{ content }` and **exactly** that: `role` is the server's to assign, and a
 * client that helpfully sent one would get a 400 rather than a message. Pinning
 * the body here is what stops a later edit adding a field the API refuses.
 */

const USER = {
  id: 'msg-1',
  role: 'user' as const,
  content: 'build a contact dashboard',
  createdAt: '2026-08-17T09:00:00.000Z',
  truncated: false,
}

const ASSISTANT = {
  id: 'msg-2',
  role: 'assistant' as const,
  content: 'Here is a contact dashboard',
  createdAt: '2026-08-17T09:00:00.000Z',
  truncated: false,
}

/** An interrupted reply — the flag Slice 5 adds, off the wire (AC-40). */
const TRUNCATED = { ...ASSISTANT, id: 'msg-3', content: 'Here is a cont', truncated: true }

function callOf(index = 0): [string, RequestInit] {
  return request.mock.calls[index] as [string, RequestInit]
}

/** The serialised body, parsed back — the client always sends a JSON string. */
function bodyOf(init: RequestInit): unknown {
  return JSON.parse(typeof init.body === 'string' ? init.body : '')
}

beforeEach(() => {
  vi.clearAllMocks()
  request.mockResolvedValue({ messages: [USER, ASSISTANT] })
})

describe('listMessages', () => {
  it("GETs the project's messages and unwraps the envelope", async () => {
    await expect(listMessages('proj-1')).resolves.toEqual([USER, ASSISTANT])

    expect(request).toHaveBeenCalledWith('/api/projects/proj-1/messages')
  })

  it('resolves to an empty array for a project with no transcript', async () => {
    request.mockResolvedValue({ messages: [] })

    await expect(listMessages('proj-1')).resolves.toEqual([])
  })

  it("surfaces the server's message on a refusal", async () => {
    request.mockRejectedValue(new Error('That project no longer exists.'))

    await expect(listMessages('proj-1')).rejects.toThrow('That project no longer exists.')
  })

  /** AC-40's client half: `truncated` survives the trip through this module. */
  it('carries truncated through from the wire', async () => {
    request.mockResolvedValue({ messages: [USER, TRUNCATED] })

    await expect(listMessages('proj-1')).resolves.toEqual([USER, TRUNCATED])
  })
})

describe('sendMessage', () => {
  /**
   * AC-4, D3, D4. **One message back, not two.** The reply is no longer written
   * here — `POST /generate` writes it at the stream's terminal event — so this
   * resolves to the user's own turn and the array shape is kept with one element
   * in it, which is what makes the change invisible to the store's append.
   */
  it('POSTs the content as JSON and returns the one user message', async () => {
    request.mockResolvedValue({ messages: [USER] })

    await expect(sendMessage('proj-1', 'build a contact dashboard')).resolves.toEqual(USER)
    const [path, init] = callOf()

    expect(path).toBe('/api/projects/proj-1/messages')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  /*
   * A 201 with nothing in it is a server that answered and said nothing, and the
   * store's next line would otherwise append `undefined` to the transcript.
   * Rejecting is what turns that into the composer's error state.
   */
  it('rejects when the server returns no message', async () => {
    request.mockResolvedValue({ messages: [] })

    await expect(sendMessage('proj-1', 'hi')).rejects.toThrow()
  })

  /** `content` and nothing else — `role` is the server's (D5). */
  it('sends a body of exactly { content }', async () => {
    await sendMessage('proj-1', 'hi')

    expect(bodyOf(callOf()[1])).toEqual({ content: 'hi' })
  })

  it("surfaces the server's message on a refusal", async () => {
    request.mockRejectedValue(new Error('This project has reached its limit of 200 messages.'))

    await expect(sendMessage('proj-1', 'hi')).rejects.toThrow(
      'This project has reached its limit of 200 messages.',
    )
  })
})

/*
 * An id is a server-generated string that reaches us over the wire, so it is
 * encoded rather than trusted to be path-safe — the server refuses anything
 * outside `[A-Za-z0-9_-]`, and this makes the two agree instead of relying on the
 * refusal.
 */
describe('path encoding', () => {
  it.each([
    ['listMessages', () => listMessages('a/b')],
    ['sendMessage', () => sendMessage('a/b', 'hi')],
  ])('percent-encodes the id for %s', async (_label, call) => {
    await call()

    expect(callOf()[0]).toBe('/api/projects/a%2Fb/messages')
  })
})

describe('MESSAGE_LIMIT', () => {
  /*
   * Mirrors the server's cap. The functions package is not importable from
   * `frontend/`, so the number is duplicated — the same way `projectsApi.ts`
   * mirrors the wire shape — and this pins the copy, since the composer's
   * at-limit state is derived from it.
   */
  it('matches the cap the server enforces', () => {
    expect(MESSAGE_LIMIT).toBe(200)
  })
})
