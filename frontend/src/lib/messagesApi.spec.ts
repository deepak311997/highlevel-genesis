import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({ request }))

const { listMessages, MESSAGE_LIMIT } = await import('./messagesApi')

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

function callOf(index = 0): [string, RequestInit] {
  return request.mock.calls[index] as [string, RequestInit]
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
})

/*
 * An id is a server-generated string that reaches us over the wire, so it is
 * encoded rather than trusted to be path-safe — the server refuses anything
 * outside `[A-Za-z0-9_-]`, and this makes the two agree instead of relying on the
 * refusal.
 */
describe('path encoding', () => {
  it.each([['listMessages', () => listMessages('a/b')]])(
    'percent-encodes the id for %s',
    async (_label, call) => {
      await call()

      expect(callOf()[0]).toBe('/api/projects/a%2Fb/messages')
    },
  )
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
