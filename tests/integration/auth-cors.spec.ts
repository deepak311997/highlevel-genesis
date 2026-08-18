import { describe, expect, it } from 'vitest'

import { API_BASE } from './helpers'

/**
 * Covers the criterion proposed as AC-56 in the technical plan's coverage gaps — the PRD
 * mandates an origin allowlist in its contracts section but never turned it into a numbered
 * criterion.
 *
 * These endpoints are same-origin in production, reached through a Hosting rewrite, so this is
 * defence in depth rather than the primary control. It still matters: `cors({ origin: true })`
 * reflects whatever Origin it is given, which turns every browser on the internet into a
 * permitted caller and makes the reflected value useless as a signal.
 */
async function preflight(origin: string): Promise<Response> {
  return fetch(`${API_BASE}/auth/register`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
}

describe('CORS', () => {
  it('permits the app origin', async () => {
    const res = await preflight('http://localhost:5173')

    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('does not reflect an origin that is not on the allowlist', async () => {
    const res = await preflight('https://evil.test')

    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it.each([
    ['a lookalike suffix', 'https://localhost:5173.evil.test'],
    ['a lookalike prefix', 'https://evil-localhost:5173'],
    ['plain http on another host', 'http://attacker.test'],
    ['the null origin', 'null'],
  ])('does not reflect %s', async (_label, origin) => {
    const res = await preflight(origin)

    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('still serves a request that carries no Origin at all', async () => {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'no-origin@example.test', password: 'Correct-Horse-9' }),
    })

    expect(res.status).toBe(200)
  })
})
