import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SMTP2GO_API_URL, Smtp2GoTransport } from './smtp2go'
import type { EmailMessage } from './types'

const API_KEY = 'api-abc123-secret'
const SENDER = 'Genesis <no-reply@example.test>'

const MESSAGE: EmailMessage = {
  to: 'alice@example.test',
  subject: 'Verify your email',
  textBody: 'Open the link.',
  htmlBody: '<p>Open the link.</p>',
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl as unknown as typeof fetch)
  vi.stubGlobal('fetch', spy)
  return spy
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function transport(): Smtp2GoTransport {
  return new Smtp2GoTransport(API_KEY, SENDER)
}

/**
 * The first fetch call, narrowed rather than asserted.
 *
 * Throwing on the unexpected shape keeps a wrong call from silently reading as
 * a passing assertion — `undefined` compared against `undefined` is green.
 */
function firstCall(spy: ReturnType<typeof stubFetch>): { url: string; init: RequestInit } {
  const call = spy.mock.calls[0]
  if (call === undefined) throw new Error('fetch was never called')
  const [url, init] = call
  if (typeof url !== 'string') throw new Error('expected a string URL')
  if (init === undefined) throw new Error('expected a fetch init object')
  return { url, init }
}

/** The parsed request body from the first fetch call. */
function sentBody(spy: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const { init } = firstCall(spy)
  if (typeof init.body !== 'string') throw new Error('expected a serialised body')
  return JSON.parse(init.body) as Record<string, unknown>
}

describe('Smtp2GoTransport', () => {
  beforeEach(() => {
    vi.stubGlobal('console', { ...console, info: vi.fn(), error: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts to the SMTP2GO v3 send endpoint', async () => {
    const spy = stubFetch(async () => jsonResponse({ data: { succeeded: 1 } }))

    await transport().send(MESSAGE)

    const { url, init } = firstCall(spy)
    expect(url).toBe(SMTP2GO_API_URL)
    expect(init.method).toBe('POST')
  })

  it('authenticates with the X-Smtp2go-Api-Key header, not a query parameter', async () => {
    const spy = stubFetch(async () => jsonResponse({ data: { succeeded: 1 } }))

    await transport().send(MESSAGE)

    const { url, init } = firstCall(spy)
    const headers = init.headers as Record<string, string>
    expect(headers['X-Smtp2go-Api-Key']).toBe(API_KEY)
    // A key in the URL lands in access logs and proxy history.
    expect(url).not.toContain(API_KEY)
  })

  it('sends the documented payload shape', async () => {
    const spy = stubFetch(async () => jsonResponse({ data: { succeeded: 1 } }))

    await transport().send(MESSAGE)

    expect(sentBody(spy)).toEqual({
      sender: SENDER,
      to: [MESSAGE.to],
      subject: MESSAGE.subject,
      text_body: MESSAGE.textBody,
      html_body: MESSAGE.htmlBody,
    })
  })

  it('omits html_body when the message has none', async () => {
    const spy = stubFetch(async () => jsonResponse({ data: { succeeded: 1 } }))

    await transport().send({ to: MESSAGE.to, subject: 'x', textBody: 'y' })

    expect(sentBody(spy)).not.toHaveProperty('html_body')
  })

  it('passes an abort signal so a hung provider cannot pin the instance open', async () => {
    const spy = stubFetch(async () => jsonResponse({ data: { succeeded: 1 } }))

    await transport().send(MESSAGE)

    expect(firstCall(spy).init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports success only when the provider confirms at least one send', async () => {
    stubFetch(async () => jsonResponse({ data: { succeeded: 1 } }))

    await expect(transport().send(MESSAGE)).resolves.toBe(true)
  })

  it.each([
    ['zero sends', { data: { succeeded: 0, failed: 1 } }, 200],
    ['no data envelope', {}, 200],
    ['an error payload', { data: { error: 'bad key' } }, 401],
    ['a server error', { data: {} }, 500],
  ])('reports failure for %s', async (_label, body, status) => {
    stubFetch(async () => jsonResponse(body, status))

    await expect(transport().send(MESSAGE)).resolves.toBe(false)
  })

  // Registration must return an identical response whether or not mail went
  // out, so a transport failure can never become an exception that changes it.
  it('returns false rather than throwing when the network fails', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNRESET')))

    await expect(transport().send(MESSAGE)).resolves.toBe(false)
  })

  it('returns false rather than throwing when the body is not JSON', async () => {
    stubFetch(async () => new Response('<html>502</html>', { status: 502 }))

    await expect(transport().send(MESSAGE)).resolves.toBe(false)
  })

  it('never writes the API key or the recipient into a log line on failure', async () => {
    const error = vi.fn()
    const info = vi.fn()
    vi.stubGlobal('console', { ...console, error, info })
    stubFetch(() => Promise.reject(new Error(`auth failed for key ${API_KEY}`)))

    await transport().send(MESSAGE)

    const logged = JSON.stringify([...error.mock.calls, ...info.mock.calls])
    expect(logged).not.toContain(API_KEY)
    expect(logged).not.toContain(MESSAGE.to)
  })
})
