import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adminDb, fetchNoRedirect, resetEmulators, seedUser } from './helpers'

/**
 * `GET /api/oauth/callback` — the unauthenticated endpoint.
 *
 * HighLevel redirects a browser here and there is no session on the request, so
 * the encrypted `state` is the whole authorisation: it names the Firebase user
 * this connection belongs to. Most of what follows is therefore about refusing
 * things, and every refusal has to leave no trace in Firestore.
 *
 * The fake HighLevel selects its behaviour from the authorization code, so the
 * intent of each test is on the line that writes the code rather than in setup.
 */

const PASSWORD = 'Correct-Horse-9'
const EMAIL = 'callback-user@example.test'

let uid: string
let state: string

/** A sealed state for our user, obtained the way the SPA obtains one. */
async function freshState(): Promise<string> {
  const { idTokenFor, postJson } = await import('./helpers')
  const token = await idTokenFor(EMAIL, PASSWORD)
  const res = await postJson('/api/hl/connect', {}, { Authorization: `Bearer ${token}` })
  const { authorizeUrl } = res.body as { authorizeUrl: string }
  return new URL(authorizeUrl).searchParams.get('state') ?? ''
}


/**
 * A fresh code per call.
 *
 * The fake consumes a code on first use, exactly as HighLevel does, so reusing
 * one across tests exercises the replay path by accident and fails for a reason
 * that has nothing to do with what is under test. Only the prefix carries
 * meaning — it selects the install shape.
 */
let codeCounter = 0
function code(prefix: string): string {
  codeCounter += 1
  return `${prefix}-${String(codeCounter)}`
}

async function callback(query: string): Promise<{ status: number; location: string }> {
  return fetchNoRedirect(`/api/oauth/callback?${query}`)
}

function connectionDoc(): Promise<FirebaseFirestore.DocumentSnapshot> {
  return adminDb().doc(`hlConnections/${uid}`).get()
}

beforeAll(async () => {
  await resetEmulators()
  uid = await seedUser(EMAIL, PASSWORD, true)
})

beforeEach(async () => {
  await adminDb().doc(`hlConnections/${uid}`).delete()
  state = await freshState()
})

describe('the happy path', () => {
  it('stores the connection and sends the browser into the SPA', async () => {
    const res = await callback(`code=${code('loc')}&state=${encodeURIComponent(state)}`)

    expect(res.status).toBe(302)
    expect(res.location).toBe('/hl/callback?status=connected')

    const data = (await connectionDoc()).data()
    expect(data?.['locationId']).toBe('lUanVn0CtZJTlymH8ySo')
    expect(data?.['accessToken']).toBeTruthy()
    expect(data?.['refreshToken']).toBeTruthy()
    expect(data?.['needsReconnect']).toBe(false)
    expect(data?.['connectedAt']).toBeTruthy()
  })

  it('stores the location name for the panel to show', async () => {
    await callback(`code=${code('loc')}&state=${encodeURIComponent(state)}`)

    expect((await connectionDoc()).data()?.['locationName']).toBe('India Square')
  })

  it('sets an expiry in the future, from the response rather than a guess', async () => {
    await callback(`code=${code('loc')}&state=${encodeURIComponent(state)}`)

    const expiresAt = (await connectionDoc()).data()?.['expiresAt'] as
      | { toMillis(): number }
      | undefined
    expect(expiresAt).toBeDefined()
    expect((expiresAt?.toMillis() ?? 0) - Date.now()).toBeGreaterThan(80_000_000)
  })

  it('replaces the previous connection rather than adding a second', async () => {
    await callback(`code=${code('loc')}&state=${encodeURIComponent(state)}`)
    const second = await freshState()
    await callback(`code=${code('loc')}&state=${encodeURIComponent(second)}`)

    const all = await adminDb().collection('hlConnections').get()
    expect(all.docs.filter((d) => d.id === uid)).toHaveLength(1)
  })
})

describe('an agency-wide install', () => {
  /*
   * The shape the marketplace's own install button produces. It is usable, but
   * only after asking which sub-accounts it covers and trading it for a
   * location-scoped token.
   */
  it('resolves a bulk install covering exactly one sub-account', async () => {
    const res = await callback(`code=${code('company-one')}&state=${encodeURIComponent(state)}`)

    expect(res.location).toBe('/hl/callback?status=connected')
    expect((await connectionDoc()).data()?.['locationId']).toBe('lUanVn0CtZJTlymH8ySo')
  })

  /*
   * The case that must never be guessed. Picking the first would bind a Genesis
   * project to an arbitrary client's CRM — the tenant-isolation mistake this
   * slice exists to avoid.
   */
  it('refuses a bulk install spanning several sub-accounts', async () => {
    const res = await callback(`code=${code('company-multi')}&state=${encodeURIComponent(state)}`)

    expect(res.location).toBe('/hl/callback?status=error&code=wrong_account_type')
    expect((await connectionDoc()).exists).toBe(false)
  })

  it('refuses a bulk install covering no sub-accounts', async () => {
    const res = await callback(`code=${code('company-none')}&state=${encodeURIComponent(state)}`)

    expect(res.location).toBe('/hl/callback?status=error&code=wrong_account_type')
    expect((await connectionDoc()).exists).toBe(false)
  })
})

describe('refusals', () => {
  it('reports a refusal at HighLevel as cancelled, not as an error', async () => {
    const res = await callback(`error=access_denied&state=${encodeURIComponent(state)}`)

    expect(res.location).toBe('/hl/callback?status=error&code=denied')
    expect((await connectionDoc()).exists).toBe(false)
  })

  it.each([
    ['absent', ''],
    ['not a token at all', 'state=nonsense'],
    ['truncated', 'state=YWJj'],
  ])('rejects a state that is %s', async (_why, query) => {
    const res = await callback(`code=${code('loc')}&${query}`)

    expect(res.location).toBe('/hl/callback?status=error&code=invalid_state')
    expect((await connectionDoc()).exists).toBe(false)
  })

  it('rejects a state whose ciphertext has been altered', async () => {
    const raw = Buffer.from(state, 'base64url')
    const target = raw.length - 20
    raw[target] = (raw[target] ?? 0) ^ 0x01
    const tampered = raw.toString('base64url')

    const res = await callback(`code=loc-abc&state=${encodeURIComponent(tampered)}`)

    expect(res.location).toBe('/hl/callback?status=error&code=invalid_state')
    expect((await connectionDoc()).exists).toBe(false)
  })

  it('reports a rejected code as an exchange failure', async () => {
    const res = await callback(`code=${code('bad')}&state=${encodeURIComponent(state)}`)

    expect(res.location).toBe('/hl/callback?status=error&code=exchange_failed')
    expect((await connectionDoc()).exists).toBe(false)
  })

  /*
   * Replay. HighLevel consumes an authorization code on first use, so a re-sent
   * callback URL fails at the exchange — which is what made a single-use state
   * store unnecessary. The existing connection must survive it untouched.
   */
  it('leaves an existing connection alone when a callback URL is replayed', async () => {
    // Deliberately the SAME code twice — that is the replay.
    const url = `code=${code('loc')}&state=${encodeURIComponent(state)}`
    await callback(url)
    const before = (await connectionDoc()).data()?.['accessToken']

    const res = await callback(url)

    expect(res.location).toBe('/hl/callback?status=error&code=exchange_failed')
    expect((await connectionDoc()).data()?.['accessToken']).toBe(before)
  })

  it('never writes a connection for a state it could not open', async () => {
    await callback(`code=${code('loc')}&state=forged`)

    expect((await adminDb().collection('hlConnections').get()).empty).toBe(true)
  })
})
