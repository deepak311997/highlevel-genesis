import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { idTokenFor, postJson, resetEmulators, seedUser } from './helpers'

/**
 * `POST /api/hl/connect` — where a connection starts.
 *
 * The endpoint hands back a URL and nothing else, which makes it easy to under-test. What
 * actually matters is who is allowed to obtain one: the URL carries a `state` binding a Firebase
 * uid, and the callback will write a HighLevel connection against whatever uid that state names.
 * So an endpoint that minted one for an unauthenticated or unverified caller would let someone
 * attach a CRM to an account they had not proven they own.
 */

const PASSWORD = 'Correct-Horse-9'
const VERIFIED = 'connect-verified@example.test'
const UNVERIFIED = 'connect-unverified@example.test'

let verifiedToken: string
let unverifiedToken: string
let verifiedUid: string

beforeAll(async () => {
  await resetEmulators()

  verifiedUid = await seedUser(VERIFIED, PASSWORD, true)
  await seedUser(UNVERIFIED, PASSWORD, false)

  verifiedToken = await idTokenFor(VERIFIED, PASSWORD)
  unverifiedToken = await idTokenFor(UNVERIFIED, PASSWORD)
})

beforeEach(() => {
  expect(verifiedToken).toBeTruthy()
})

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('POST /api/hl/connect', () => {
  it('returns an authorize URL for a verified user', async () => {
    const res = await postJson('/api/hl/connect', {}, auth(verifiedToken))

    expect(res.status).toBe(200)
    const { authorizeUrl } = res.body as { authorizeUrl: string }
    expect(authorizeUrl).toContain('/v2/oauth/chooselocation')
    expect(new URL(authorizeUrl).searchParams.get('response_type')).toBe('code')
  })

  it('carries a state, which is the only link back to the caller', async () => {
    const res = await postJson('/api/hl/connect', {}, auth(verifiedToken))
    const { authorizeUrl } = res.body as { authorizeUrl: string }

    const state = new URL(authorizeUrl).searchParams.get('state')
    expect(state).toBeTruthy()
    // Opaque on the wire. A signed token would put the uid in HighLevel's logs.
    expect(state).not.toContain(verifiedUid)
  })

  it('mints a different state each time', async () => {
    const [a, b] = await Promise.all([
      postJson('/api/hl/connect', {}, auth(verifiedToken)),
      postJson('/api/hl/connect', {}, auth(verifiedToken)),
    ])

    const stateOf = (res: typeof a): string | null =>
      new URL((res.body as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')

    expect(stateOf(a)).not.toBe(stateOf(b))
  })

  /*
   * Regression. The functions emulator loads `functions/.env`, whose values *override* anything
   * the shell exported — so the local flow silently inherited the production redirect URI and
   * completed on the deployed site, where no callback exists.
   */
  it('sends the callback back to this app, never to the deployed site', async () => {
    const res = await postJson('/api/hl/connect', {}, auth(verifiedToken))
    const { authorizeUrl } = res.body as { authorizeUrl: string }

    const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri') ?? ''
    // Derived from the same variable the test script sets, so moving the suite
    // to a second port set cannot make this assertion stale.
    const appPort = process.env['E2E_PORT'] ?? '5173'
    expect(new URL(redirect).origin).toBe(`http://localhost:${appPort}`)
    expect(redirect).not.toContain('web.app')
  })

  it('refuses a caller with no token', async () => {
    const res = await postJson('/api/hl/connect', {})

    expect(res.status).toBe(401)
    expect(res.raw).not.toContain('chooselocation')
  })

  it('refuses a token it cannot verify', async () => {
    const res = await postJson('/api/hl/connect', {}, auth('not-a-real-token'))

    expect(res.status).toBe(401)
  })

  /*
   * The D26 case. This caller holds a genuine, unexpired token for a real account — a router
   * guard would never see them, because they need not use a browser at all.
   */
  it('refuses a signed-in caller whose address is unverified', async () => {
    const res = await postJson('/api/hl/connect', {}, auth(unverifiedToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('email_unverified')
    expect(res.raw).not.toContain('chooselocation')
  })
})
