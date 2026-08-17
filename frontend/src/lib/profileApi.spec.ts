import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({ request }))

const { ensureProfile, getProfile } = await import('./profileApi')

/**
 * The typed client for the two profile routes.
 *
 * `request` is mocked here rather than `fetch`: header assembly has its own
 * suite in `apiClient.spec.ts`, and what is worth asserting at this level is the
 * contract — which path, which verb, and that "no profile yet" arrives as a
 * value rather than through the error channel.
 */

const PROFILE = {
  email: 'alice@example.test',
  displayName: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  request.mockResolvedValue({ profile: PROFILE })
})

describe('getProfile', () => {
  it('GETs /api/profile', async () => {
    await getProfile()

    expect(request).toHaveBeenCalledWith('/api/profile')
  })

  it('unwraps the envelope', async () => {
    await expect(getProfile()).resolves.toEqual(PROFILE)
  })

  /*
   * D4: an account between verifying and its first ensure has no profile, and
   * that is an ordinary state — the card's empty one. Surfacing it as a value
   * keeps it out of the error path, where the first caller to forget would show
   * an error screen to a perfectly healthy account.
   */
  it('returns null as a value when the server says there is no profile', async () => {
    request.mockResolvedValue({ profile: null })

    await expect(getProfile()).resolves.toBeNull()
  })
})

describe('ensureProfile', () => {
  it('PUTs /api/profile with a JSON body', async () => {
    await ensureProfile()

    const [path, init] = request.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/profile')
    expect(init.method).toBe('PUT')
    // An explicit `{}` with a JSON content type, so the request reaches the route
    // as a parsed body and genuinely exercises the `.strict()` boundary rather
    // than skirting it.
    expect(init.body).toBe('{}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('returns the profile the server stored', async () => {
    await expect(ensureProfile()).resolves.toEqual(PROFILE)
  })

  it("surfaces the server's message on a refusal", async () => {
    request.mockRejectedValue(new Error('Check the details and try again.'))

    await expect(ensureProfile()).rejects.toThrow('Check the details and try again.')
  })
})
