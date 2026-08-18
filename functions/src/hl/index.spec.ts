import express, { Router, type Express } from 'express'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AddressInfo } from 'node:net'
import type { Request, Response } from 'express'

/**
 * What the router actually attaches to each route — the half of AC-19 that no emulator-backed
 * test can reach.
 *
 * `requireAppCheck` short-circuits under `FUNCTIONS_EMULATOR` and there is no App Check emulator
 * to stand in for it, so the integration suite cannot observe attestation at all.
 * `auth/appCheck.spec.ts` proves the middleware refuses an unattested caller; nothing proved it
 * was **on this route**, and deleting the word `attested` from the proxy's mount line broke no
 * test in the repo. That is the wrong thing to leave to a reading, on the one endpoint where an
 * unattested caller spends a finite third-party budget and can write to somebody's CRM.
 */

/*
 * The router is built **at import**, so `withVerifiedUser` has to be wrapping things by then —
 * its implementation is baked into the hoisted factory rather than set in a hook, and its call
 * record is the record of what the router wrapped, made once and never reset.
 */
const requireAppCheck = vi.hoisted(() => vi.fn())
const handleProxy = vi.hoisted(() => vi.fn())
const handleConnect = vi.hoisted(() => vi.fn())
const handleGetConnection = vi.hoisted(() => vi.fn())
const handleDeleteConnection = vi.hoisted(() => vi.fn())
const handleCallback = vi.hoisted(() => vi.fn())
const withVerifiedUser = vi.hoisted(() =>
  // Stands in for a wrapper that has already verified an ID token, so a refusal
  // below can only be attestation.
  vi.fn(
    (handler: (req: unknown, res: unknown, uid: string) => unknown) =>
      (req: unknown, res: unknown, next: (err?: unknown) => void) => {
        Promise.resolve(handler(req, res, 'alice')).catch(next)
      },
  ),
)

vi.mock('../auth/appCheck', () => ({ requireAppCheck }))
vi.mock('../auth/requireUser', () => ({ withVerifiedUser }))
vi.mock('./proxy', () => ({ handleProxy }))
vi.mock('./connect', () => ({ handleConnect }))
vi.mock('./connection', () => ({ handleGetConnection, handleDeleteConnection }))
vi.mock('./callback', () => ({ handleCallback }))
vi.mock('./fake', () => ({ buildFakeHlRouter: () => Router() }))

import { errorHandler, HttpError } from '../lib/errors'
import { hlRouter } from './index'

/** The deployed behaviour: no valid App Check token, so no further. */
function refuseAttestation(): void {
  requireAppCheck.mockImplementation(() => {
    throw new HttpError(
      401,
      'Request could not be verified. Reload the page and try again.',
      'app_check_failed',
    )
  })
}

/** A handler that reached is a handler that says so. */
function reached(res: Response): void {
  res.status(403).json({ code: 'forwarded' })
}

let server: Server
let origin: string

beforeAll(async () => {
  const app: Express = express()
  app.use(express.json())
  // Both prefixes, exactly as createApiApp mounts it.
  app.use('/', hlRouter)
  app.use('/api', hlRouter)
  app.use(errorHandler)

  server = createServer(app)
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((closed) => {
    server.close(() => {
      closed()
    })
  })
})

/** Attested, unless a case says otherwise. */
function allowAttestation(): void {
  requireAppCheck.mockImplementation((_req: unknown, _res: unknown, next: () => void) => {
    next()
  })
}

beforeEach(() => {
  // Deliberately not `resetAllMocks`: that would erase the record of what the
  // router wrapped at import, which is half of what this file asserts.
  for (const handler of [
    handleProxy,
    handleConnect,
    handleGetConnection,
    handleDeleteConnection,
    handleCallback,
  ]) {
    handler.mockReset()
  }
  requireAppCheck.mockReset()
  allowAttestation()
})

interface Answer {
  status: number
  code: string | undefined
}

async function call(method: string, path: string): Promise<Answer> {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}),
  })
  const body = (await res.json()) as { code?: string }
  return { status: res.status, code: body.code }
}

describe('the proxy mount', () => {
  it.each([
    ['GET', '/api/hl/proxy/calendars/'],
    ['POST', '/api/hl/proxy/contacts/search'],
    ['PUT', '/api/hl/proxy/contacts/abc123'],
    ['DELETE', '/api/hl/proxy/contacts/abc123'],
    ['GET', '/api/hl/proxy'],
  ])('refuses an unattested %s %s before the handler', async (method, path) => {
    refuseAttestation()
    handleProxy.mockImplementation((_req: Request, res: Response) => {
      reached(res)
    })

    const answer = await call(method, path)

    expect(answer).toEqual({ status: 401, code: 'app_check_failed' })
    expect(handleProxy).not.toHaveBeenCalled()
  })

  /*
   * The pathful `use` — attested once, not twice. A pathless `router.use` would
   * match under both mounts and run the whole chain a second time, which on a
   * write row means two upstream calls for one request.
   */
  it('attests exactly once for one request, under either mount', async () => {
    handleProxy.mockImplementation((_req: Request, res: Response) => {
      reached(res)
    })

    expect(await call('GET', '/api/hl/proxy/calendars/')).toEqual({
      status: 403,
      code: 'forwarded',
    })
    expect(requireAppCheck).toHaveBeenCalledTimes(1)
    expect(handleProxy).toHaveBeenCalledTimes(1)
  })

  it('resolves the uid from the verified token rather than the path', async () => {
    handleProxy.mockImplementation((_req: Request, res: Response, uid: string) => {
      res.status(200).json({ code: uid })
    })

    expect(await call('GET', '/api/hl/proxy/calendars/')).toEqual({ status: 200, code: 'alice' })
    expect(withVerifiedUser).toHaveBeenCalledWith(handleProxy)
  })
})

/**
 * The rest of the router's attestation policy, stated rather than left to the comments above
 * each line — including the two routes that are deliberately *not* attested, since a test that
 * only checked the positives would pass against a router that attested everything and would not
 * notice the day reading a status started costing an attestation.
 */
describe('the connection routes', () => {
  it.each([
    ['POST', '/api/hl/connect'],
    ['DELETE', '/api/hl/connection'],
  ])('attests %s %s', async (method, path) => {
    refuseAttestation()

    expect(await call(method, path)).toEqual({ status: 401, code: 'app_check_failed' })
  })

  it('does not attest reading the connection status', async () => {
    refuseAttestation()
    handleGetConnection.mockImplementation((_req: Request, res: Response) => {
      reached(res)
    })

    expect(await call('GET', '/api/hl/connection')).toEqual({ status: 403, code: 'forwarded' })
    expect(requireAppCheck).not.toHaveBeenCalled()
  })

  /*
   * HighLevel redirects a browser here and there is no session on the request, so there is
   * nothing to attest and nothing to verify — the encrypted state is the authorisation.
   */
  it('leaves the OAuth callback unattested and unverified', async () => {
    refuseAttestation()
    handleCallback.mockImplementation((_req: Request, res: Response) => {
      reached(res)
    })

    expect(await call('GET', '/api/oauth/callback')).toEqual({ status: 403, code: 'forwarded' })
    expect(requireAppCheck).not.toHaveBeenCalled()
    expect(withVerifiedUser).not.toHaveBeenCalledWith(handleCallback)
  })
})
