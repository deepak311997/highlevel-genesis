import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, apiGet, apiUrl } from './api'

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
