import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, apiGet, apiUrl, errorForResponse } from './api'

function stubFetch(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiUrl', () => {
  it('keeps paths relative so the proxy and the Hosting rewrite both apply', () => {
    expect(apiUrl('/api/health')).toBe('/api/health')
  })

  it('tolerates a path without a leading slash', () => {
    expect(apiUrl('api/health')).toBe('/api/health')
  })
})

describe('apiGet', () => {
  it('returns the parsed body on success', async () => {
    stubFetch(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(apiGet<{ ok: boolean }>('/api/health')).resolves.toEqual({ ok: true })
  })

  it('reports the status for a non-2xx response', async () => {
    stubFetch(new Response('nope', { status: 503 }))

    await expect(apiGet('/api/health')).rejects.toThrow(ApiError)
    await expect(apiGet('/api/health')).rejects.toThrow('503')
  })

  // Regression: a 200 of index.html used to reach JSON.parse and surface as
  // "Unexpected token '<'", which tells the user nothing about the real cause.
  it('explains a 200 that returns HTML instead of letting JSON.parse fail', async () => {
    stubFetch(
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )

    await expect(apiGet('/api/health')).rejects.toThrow(/did not reach a Cloud Function/)
    await expect(apiGet('/api/health')).rejects.not.toThrow(/Unexpected token/)
  })
})

describe('errorForResponse', () => {
  function errorResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  // The proxy passes HighLevel's own words through as `detail` (functions/src/lib/errors.ts),
  // and the preview is the first caller that has anything to do with them: a brokered
  // failure has to say what was wrong with the call, not just that something was.
  it('carries the code and detail from the error envelope', async () => {
    const err = await errorForResponse(
      errorResponse(409, {
        error: 'Your HighLevel connection expired.',
        code: 'hl_reconnect_required',
        detail: 'token revoked',
      }),
    )

    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('Your HighLevel connection expired.')
    expect(err.status).toBe(409)
    expect(err.code).toBe('hl_reconnect_required')
    expect(err.detail).toBe('token revoked')
  })

  it('falls back to a message a person can act on', async () => {
    const err = await errorForResponse(errorResponse(500, { code: 'internal' }))

    expect(err.message).toBe('Something went wrong. Please try again.')
    expect(err.status).toBe(500)
    expect(err.code).toBe('internal')
  })

  // The one message that overrides the server's, and the reason this function is
  // shared rather than copied: a client that had lost this case told a throttled
  // user "something went wrong" instead of to wait.
  it('keeps the 429 message', async () => {
    const err = await errorForResponse(
      errorResponse(429, { error: 'Rate limited', code: 'throttled' }),
    )

    expect(err.message).toBe('Too many attempts. Try again in a few minutes.')
    expect(err.status).toBe(429)
    // Still lifted: the message is fixed, the envelope is not.
    expect(err.code).toBe('throttled')
  })

  it('leaves code and detail undefined when the body carries neither', async () => {
    const err = await errorForResponse(errorResponse(400, { error: 'Bad request' }))

    expect(err.message).toBe('Bad request')
    expect(err.code).toBeUndefined()
    expect(err.detail).toBeUndefined()
  })

  // index.html from the SPA fallback, i.e. the request never reached a Cloud
  // Function. `res.json()` rejects; the fallback message is the whole answer.
  it('survives a non-JSON body', async () => {
    const res = new Response('<!doctype html><html></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })

    const err = await errorForResponse(res)

    expect(err.message).toBe('Something went wrong. Please try again.')
    expect(err.status).toBe(502)
    expect(err.code).toBeUndefined()
  })
})
