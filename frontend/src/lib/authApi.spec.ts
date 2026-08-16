import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// Stubbed rather than exercised: `./appCheck` reaches Firebase and reCAPTCHA,
// neither of which belongs in a test about how this module shapes a request.
// Its own behaviour — memoisation, and degrading to no header — is covered by
// `appCheck.spec.ts`.
const appCheckHeader = vi.fn(async () => ({ 'X-Firebase-AppCheck': 'test-attestation' }))
vi.mock('./appCheck', () => ({ appCheckHeader: () => appCheckHeader() }))

import { register } from './authApi'

function stubFetch(impl: () => Promise<Response>) {
  const spy = vi.fn(impl)
  vi.stubGlobal('fetch', spy)
  return spy
}

/** The first fetch call, narrowed rather than asserted. */
function firstCall(spy: ReturnType<typeof stubFetch>): { url: string; init: RequestInit } {
  const call = (spy.mock.calls as unknown as [string, RequestInit][])[0]
  if (call === undefined) throw new Error('fetch was never called')
  return { url: call[0], init: call[1] }
}

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function failure(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authApi', () => {
  it('posts JSON to the register endpoint', async () => {
    const spy = stubFetch(async () => ok())

    await register('a@b.test', 'A-Password-1')

    const { url, init } = firstCall(spy)
    expect(url).toContain('/api/auth/register')
    expect(init.method).toBe('POST')
  })

  it('attests the request with an App Check token', async () => {
    const spy = stubFetch(async () => ok())

    await register('a@b.test', 'A-Password-1')

    // The backend refuses an unattested request with a 401, so a header that
    // silently stopped being sent would break sign-up in production while
    // every emulator-backed test stayed green — the emulator bypasses App
    // Check. This assertion is the only thing standing between those two facts.
    expect(firstCall(spy).init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Firebase-AppCheck': 'test-attestation',
    })
  })

  it('resolves without inspecting the body, which is identical across branches', async () => {
    stubFetch(async () => ok())

    await expect(register('a@b.test', 'A-Password-1')).resolves.toBeUndefined()
  })

  it('surfaces the field error the server sent', async () => {
    stubFetch(async () => failure(400, { error: 'Use at least 8 characters.', code: 'invalid' }))

    await expect(register('a@b.test', 'short')).rejects.toThrow('Use at least 8 characters.')
  })

  it('uses its own message for a throttle refusal', async () => {
    stubFetch(async () => failure(429, { error: 'whatever', code: 'throttled' }))

    await expect(register('a@b.test', 'A-Password-1')).rejects.toThrow('Too many attempts')
  })

  it('reports a network failure as one, not as a server error', async () => {
    stubFetch(() => Promise.reject(new Error('offline')))

    await expect(register('a@b.test', 'A-Password-1')).rejects.toThrow('connection')
  })

  it('degrades when the response is not JSON at all', async () => {
    stubFetch(async () => new Response('<html>502</html>', { status: 502 }))

    await expect(register('a@b.test', 'A-Password-1')).rejects.toThrow('Something went wrong')
  })
})

/**
 * AC-6, checked against the source rather than trusted to review.
 *
 * The ESLint rule in eslint.config.js is the thing that prevents this, but a
 * rule can be disabled inline. This is the assertion that would notice.
 */
describe('the client never creates accounts itself', () => {
  const BANNED = ['createUserWithEmailAndPassword', 'fetchSignInMethodsForEmail']

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) return sourceFiles(full)
      return /\.(ts|vue)$/.test(entry) && !entry.endsWith('.spec.ts') ? [full] : []
    })
  }

  it.each(BANNED)('does not call %s anywhere in src', (name) => {
    const offenders = sourceFiles(join(import.meta.dirname, '..')).filter((file) =>
      readFileSync(file, 'utf8').includes(name),
    )

    expect(offenders).toEqual([])
  })
})
