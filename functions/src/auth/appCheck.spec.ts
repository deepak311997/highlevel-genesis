import type { NextFunction, Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.hoisted` rather than a bare const: vi.mock is hoisted above the imports,
// so a factory closing over a plain module-scope variable would read it before
// it is assigned. A dynamic `await import` would also work in ESM, but this
// package compiles to CommonJS, where top-level await is not available.
const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }))

vi.mock('../lib/firebase', () => ({
  getAppCheckService: () => ({ verifyToken }),
}))

import { requireAppCheck } from './appCheck'

/**
 * App Check on the one public, unauthenticated, account-creating endpoint.
 *
 * Every case here is a *rejection* case bar one, deliberately. An allow-only test passes against
 * a middleware that calls `next()` unconditionally, which is precisely the bug worth catching:
 * App Check that does not reject is indistinguishable from no App Check at all.
 */
describe('requireAppCheck', () => {
  let req: Request
  let res: Response
  let next: NextFunction

  function requestWith(token?: string): Request {
    return {
      header: (name: string) => (name.toLowerCase() === 'x-firebase-appcheck' ? token : undefined),
    } as unknown as Request
  }

  beforeEach(() => {
    verifyToken.mockReset()
    delete process.env['FUNCTIONS_EMULATOR']
    req = requestWith('a-token')
    res = {} as Response
    next = vi.fn()
  })

  afterEach(() => {
    delete process.env['FUNCTIONS_EMULATOR']
  })

  it('rejects a request carrying no App Check header', async () => {
    await expect(requireAppCheck(requestWith(), res, next)).rejects.toMatchObject({
      status: 401,
    })

    expect(next).not.toHaveBeenCalled()
    // The point of AC-50: refused *before* anything is spent on it.
    expect(verifyToken).not.toHaveBeenCalled()
  })

  it('rejects an empty App Check header rather than treating it as absent', async () => {
    await expect(requireAppCheck(requestWith('   '), res, next)).rejects.toMatchObject({
      status: 401,
    })

    expect(verifyToken).not.toHaveBeenCalled()
  })

  it('rejects a token the App Check service refuses', async () => {
    verifyToken.mockRejectedValue(new Error('Invalid App Check token'))

    await expect(requireAppCheck(req, res, next)).rejects.toMatchObject({ status: 401 })

    expect(next).not.toHaveBeenCalled()
  })

  it('passes a verified token through', async () => {
    verifyToken.mockResolvedValue({ appId: '1:2:web:3' })

    await requireAppCheck(req, res, next)

    expect(verifyToken).toHaveBeenCalledWith('a-token')
    expect(next).toHaveBeenCalledOnce()
  })

  /**
   * There is no App Check emulator, so a deployed-style check cannot be satisfied locally and
   * would turn the whole e2e suite red.
   */
  it('bypasses verification under the emulator, and only there', async () => {
    process.env['FUNCTIONS_EMULATOR'] = 'true'

    await requireAppCheck(requestWith(), res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(verifyToken).not.toHaveBeenCalled()
  })

  it('does not accept a near-miss value of the emulator marker', async () => {
    process.env['FUNCTIONS_EMULATOR'] = 'TRUE'

    await expect(requireAppCheck(requestWith(), res, next)).rejects.toMatchObject({
      status: 401,
    })
  })
})
