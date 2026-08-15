import { beforeEach, describe, expect, it } from 'vitest'

import { adminAuth, API_BASE, postJson, resetEmulators, seedUser } from './helpers'

/** Mirrors THROTTLE_LIMIT in functions/src/auth/throttle.ts. */
const LIMIT = 5

const EMAIL = 'alice@example.test'
const UNKNOWN = 'nobody@example.test'
const PASSWORD = 'Correct-Horse-9'

beforeEach(async () => {
  await resetEmulators()
})

async function registerTimes(email: string, times: number, headers: Record<string, string> = {}) {
  const results = []
  for (let i = 0; i < times; i += 1) {
    results.push(await postJson('/auth/register', { email, password: PASSWORD }, headers))
  }
  return results
}

describe('rate limiting the auth endpoints', () => {
  it('allows attempts up to the limit and refuses the next one', async () => {
    const results = await registerTimes(UNKNOWN, LIMIT + 1)

    expect(results.slice(0, LIMIT).map((r) => r.status)).toEqual(Array(LIMIT).fill(200))

    const last = results[LIMIT]
    expect(last?.status).toBe(429)
    expect(last?.body).toEqual({ error: expect.any(String), code: 'throttled' })
  })

  /**
   * The counter has to advance identically for an address that exists and one
   * that does not. If it only counted real accounts, the 429 boundary would
   * answer "does this account exist?" — reintroducing, through the rate
   * limiter, exactly the oracle the uniform registration response closes.
   */
  it('refuses at the same point for a registered and an unregistered address', async () => {
    await seedUser(EMAIL, PASSWORD, true)

    const known = await registerTimes(EMAIL, LIMIT + 1)
    const unknown = await registerTimes(UNKNOWN, LIMIT + 1)

    expect(known.map((r) => r.status)).toEqual(unknown.map((r) => r.status))
    expect(known[LIMIT]?.raw).toBe(unknown[LIMIT]?.raw)
  })

  /**
   * X-Forwarded-For is set by the client, so an IP-only limit is evaded by
   * changing a header. The email key is the one that actually holds.
   */
  it('still refuses when the caller rotates their forwarded IP', async () => {
    const results = []
    for (let i = 0; i < LIMIT + 1; i += 1) {
      results.push(
        await postJson(
          '/auth/register',
          { email: UNKNOWN, password: PASSWORD },
          { 'X-Forwarded-For': `203.0.113.${String(i)}` },
        ),
      )
    }

    expect(results[LIMIT]?.status).toBe(429)
  })

  it('counts each address separately, so one user cannot lock out another', async () => {
    await registerTimes(UNKNOWN, LIMIT + 1)

    const other = await postJson('/auth/register', {
      email: 'someone-else@example.test',
      password: PASSWORD,
    })

    expect(other.status).toBe(200)
  })

  it('creates no account for a refused attempt', async () => {
    await registerTimes(UNKNOWN, LIMIT)

    await postJson('/auth/register', { email: 'refused@example.test', password: PASSWORD })
    await registerTimes('refused@example.test', LIMIT + 1)

    const { users } = await adminAuth().listUsers()
    expect(users.filter((u) => u.email === 'refused@example.test')).toHaveLength(1)
  })

  it('tells the caller how long to wait', async () => {
    await registerTimes(UNKNOWN, LIMIT)

    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: UNKNOWN, password: PASSWORD }),
    })

    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})
