import type { Request, Response } from 'express'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Hoisted for the same reason as appCheck.spec.ts: vi.mock lifts above the
// imports, and this package compiles to CommonJS so there is no top-level await
// to reach for instead.
const { verifyIdToken } = vi.hoisted(() => ({ verifyIdToken: vi.fn() }))

vi.mock('../lib/firebase', () => ({
  getAdminAuth: () => ({ verifyIdToken }),
}))

import { withVerifiedUser } from './requireUser'
import { HttpError } from '../lib/errors'

/**
 * The gate, for callers that are not a browser.
 *
 * Slice 1 put an unverified user behind a router guard and behind Firestore
 * rules. A router guard stops a browser and stops nobody holding a valid ID
 * token, and Firestore rules do not cover a Cloud Function's own surface — so
 * every authenticated endpoint has to check `email_verified` on the decoded
 * token itself. That is Slice 1's D26, and this slice's endpoints are the first
 * to need it.
 *
 * Every case below is a rejection bar one. A wrapper that only ever calls the
 * handler is indistinguishable from no check at all, which is the bug worth
 * catching.
 */
describe('withVerifiedUser', () => {
  let res: Response
  let handler: ReturnType<typeof vi.fn>

  function requestWith(authorization?: string): Request {
    return {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? authorization : undefined,
    } as unknown as Request
  }

  /** The rejection the wrapper produced, or undefined if it allowed the call. */
  async function run(authorization?: string): Promise<HttpError | undefined> {
    try {
      await withVerifiedUser(handler as never)(requestWith(authorization), res)
      return undefined
    } catch (err) {
      return err instanceof HttpError ? err : undefined
    }
  }

  beforeEach(() => {
    verifyIdToken.mockReset()
    handler = vi.fn().mockResolvedValue(undefined)
    res = {} as Response
  })

  it('passes the uid to the handler for a verified caller', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'user-1', email_verified: true })

    await run('Bearer good-token')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]?.[2]).toBe('user-1')
  })

  it('rejects when there is no Authorization header', async () => {
    const err = await run(undefined)

    expect(err?.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
    expect(verifyIdToken).not.toHaveBeenCalled()
  })

  it.each([
    ['not a Bearer scheme', 'Basic abc123'],
    ['Bearer with nothing after it', 'Bearer '],
    ['a bare token with no scheme', 'just-a-token'],
  ])('rejects a header that is %s', async (_why, header) => {
    const err = await run(header)

    expect(err?.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a token the Admin SDK will not verify', async () => {
    verifyIdToken.mockRejectedValue(new Error('token expired'))

    const err = await run('Bearer forged')

    expect(err?.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  /*
   * The case this wrapper exists for. The token is genuine — correctly signed,
   * not expired, a real account — and must still be refused, because the
   * address behind it has never been proven.
   */
  it('refuses a valid token whose address is unverified', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'user-1', email_verified: false })

    const err = await run('Bearer valid-but-unverified')

    expect(err?.status).toBe(403)
    expect(err?.code).toBe('email_unverified')
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses a token with no email_verified claim at all', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'user-1' })

    expect((await run('Bearer no-claim'))?.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('surfaces a handler rejection rather than swallowing it', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'user-1', email_verified: true })
    handler.mockRejectedValue(new HttpError(500, 'boom', 'internal'))

    expect((await run('Bearer good-token'))?.status).toBe(500)
  })
})
