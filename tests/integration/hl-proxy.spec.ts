import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminDb,
  deleteJson,
  getJson,
  idTokenFor,
  postJson,
  resetEmulators,
  seedUser,
} from './helpers'

/**
 * `/api/hl/proxy/**` — the boundary, over the wire.
 *
 * The unit tests prove the matcher refuses what it should. This file proves the *refusals reach
 * a caller*, in the right order, with nothing touched on the way — which is a different claim
 * and the one R1 and R3 actually rest on.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'proxy-alice@example.test'
const BOB = 'proxy-bob@example.test'
const UNVERIFIED = 'proxy-unverified@example.test'

/** The fake's own location, and the one its fixtures are recorded against. */
const ALICE_LOCATION = 'lUanVn0CtZJTlymH8ySo'
const BOB_LOCATION = 'aB9zzQ1CtZJTlymH8ySo'

const ACCESS_TOKEN = 'alice-access-token-must-never-be-returned'
const REFRESH_TOKEN = 'alice-refresh-token-must-never-be-returned'

let aliceUid: string
let bobUid: string
let aliceToken: string
let bobToken: string
let unverifiedToken: string

/**
 * A connection an hour from expiry, so nothing here refreshes by accident.
 *
 * `tests/integration/hl-token-refresh.spec.ts` owns the skew; a case in this file that rotated a
 * token would be testing that file's subject with this file's fixtures.
 */
async function seedConnection(uid: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await adminDb()
    .doc(`hlConnections/${uid}`)
    .set({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      locationId: ALICE_LOCATION,
      locationName: 'India Square',
      companyId: 'swdGTJYeSOLEHFfgZgPf',
      hlUserId: 'hl-user-1',
      scope: 'contacts.readonly',
      needsReconnect: false,
      connectedAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      ...overrides,
    })
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** How many requests the stub has received since the last reset. */
async function upstreamCalls(): Promise<number> {
  const res = await getJson('/__fake-hl/__calls')
  return (res.body as { total: number }).total
}

beforeAll(async () => {
  await resetEmulators()
  aliceUid = await seedUser(ALICE, PASSWORD, true)
  bobUid = await seedUser(BOB, PASSWORD, true)
  await seedUser(UNVERIFIED, PASSWORD, false)
  aliceToken = await idTokenFor(ALICE, PASSWORD)
  bobToken = await idTokenFor(BOB, PASSWORD)
  unverifiedToken = await idTokenFor(UNVERIFIED, PASSWORD)
})

beforeEach(async () => {
  await adminDb().doc(`hlConnections/${aliceUid}`).delete()
  await adminDb().doc(`hlConnections/${bobUid}`).delete()
  await deleteJson('/__fake-hl/__calls')
})

describe('the proxy boundary', () => {
  it('refuses a request with no Authorization header', async () => {
    await seedConnection(aliceUid)

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 })

    expect(res.status).toBe(401)
    expect((res.body as { code?: string }).code).toBe('unauthenticated')
    expect(await upstreamCalls()).toBe(0)

    // Untouched, field for field — a refusal that still wrote something would
    // pass a status assertion and fail AC-17's actual claim.
    const stored = (await adminDb().doc(`hlConnections/${aliceUid}`).get()).data()
    expect(stored?.['accessToken']).toBe(ACCESS_TOKEN)
    expect(stored?.['needsReconnect']).toBe(false)
  })

  it('refuses a caller whose email is not verified', async () => {
    const res = await postJson(
      '/api/hl/proxy/contacts/search',
      { pageLimit: 1 },
      auth(unverifiedToken),
    )

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('email_unverified')
    expect(await upstreamCalls()).toBe(0)
  })

  it('refuses a route the allowlist does not name', async () => {
    await seedConnection(aliceUid)

    const res = await deleteJson('/api/hl/proxy/contacts/abc123', auth(aliceToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_not_allowed')
    expect(await upstreamCalls()).toBe(0)
  })

  /*
   * The ordering proof described at the top of this file. Bob has no connection document at all:
   * a proxy that resolved a token before consulting the table would answer `409
   * hl_not_connected` here, and that is the only way the difference is observable from outside.
   */
  it('consults the allowlist before it reads a connection', async () => {
    const res = await deleteJson('/api/hl/proxy/contacts/abc123', auth(bobToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_not_allowed')
  })

  it('refuses the bare subtree rather than 404ing', async () => {
    await seedConnection(aliceUid)

    const res = await getJson('/api/hl/proxy', auth(aliceToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_not_allowed')
  })

  it('refuses an allowlisted path reached with the wrong method', async () => {
    await seedConnection(aliceUid)

    const res = await getJson('/api/hl/proxy/contacts/search', auth(aliceToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_not_allowed')
    expect(await upstreamCalls()).toBe(0)
  })

  it('refuses a path parameter outside the grammar', async () => {
    await seedConnection(aliceUid)

    const res = await getJson('/api/hl/proxy/contacts/%2E%2E%2Foauth', auth(aliceToken))

    expect(res.status).toBe(400)
    expect((res.body as { code?: string }).code).toBe('invalid_path')
    expect(await upstreamCalls()).toBe(0)
  })

  /*
   * `route_disabled` and **not** `route_not_allowed`, which is the whole point:
   * the row exists and is deliberately safed, so the refusal has to read
   * differently from one for a path nobody put on the table (D5, R5).
   */
  it('refuses the message-send route, which is off in every environment', async () => {
    await seedConnection(aliceUid)

    const res = await postJson(
      '/api/hl/proxy/conversations/messages',
      { type: 'SMS', message: 'hello' },
      auth(aliceToken),
    )

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('route_disabled')
    expect(await upstreamCalls()).toBe(0)
  })

  it('answers hl_not_connected when there is no connection document', async () => {
    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(aliceToken))

    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('hl_not_connected')
    expect(await upstreamCalls()).toBe(0)
  })

  /*
   * AC-29 over the wire. The pure half is in `functions/src/hl/token.spec.ts`;
   * what this adds is that no refresh request leaves the process — the counter
   * would see it, because the token endpoint is on the same stub.
   */
  it('refuses a connection already marked needsReconnect, without refreshing', async () => {
    await seedConnection(aliceUid, {
      needsReconnect: true,
      // Inside the skew, so a handler that checked freshness first would refresh.
      expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
    })

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(aliceToken))

    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('hl_reconnect_required')
    expect(await upstreamCalls()).toBe(0)
  })

  it('puts no token material in a refusal', async () => {
    await seedConnection(aliceUid, { needsReconnect: true })

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(aliceToken))

    expect(res.raw).not.toContain(ACCESS_TOKEN)
    expect(res.raw).not.toContain(REFRESH_TOKEN)
    expect(res.raw).not.toContain(aliceUid)
  })

  it("never reads another user's connection", async () => {
    await seedConnection(bobUid, { locationId: BOB_LOCATION })

    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(aliceToken))

    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('hl_not_connected')
  })
})

/**
 * What actually crosses the boundary, in both directions.
 *
 * The upstream half is observed through the stub rather than argued about: it refuses any
 * surface request that arrives without `Authorization` and `Version`, so reaching a 200 at all
 * is the assertion that we attach them; and it filters its fixtures by the `locationId` it was
 * given, so a proxy that forgot to inject ours returns **the wrong records** rather than failing
 * a claim about an argument. That is what makes AC-11 a result and not a mock expectation.
 */
interface EchoedRequest {
  headers: Record<string, string>
}

describe('the upstream call', () => {
  beforeEach(async () => {
    await seedConnection(aliceUid)
  })

  it("returns HighLevel's body byte for byte, with its status and rate limits", async () => {
    const res = await postJson('/api/hl/proxy/contacts/search', { pageLimit: 1 }, auth(aliceToken))

    expect(res.status).toBe(200)

    // The same request put to the stub directly. Comparing raw text against raw
    // text is the only form of this assertion that would notice a re-serialised
    // body — one that parses identically and is not the same bytes (D17).
    const direct = await postJson(
      '/__fake-hl/contacts/search',
      { locationId: ALICE_LOCATION },
      { Authorization: 'Bearer anything', Version: '2021-07-28' },
    )
    expect(res.raw).toBe(direct.raw)
    expect((res.body as { total?: number }).total).toBe(5)

    for (const name of [
      'x-ratelimit-limit-daily',
      'x-ratelimit-daily-remaining',
      'x-ratelimit-interval-milliseconds',
      'x-ratelimit-max',
      'x-ratelimit-remaining',
    ]) {
      expect(res.headers.get(name)).toBe(direct.headers.get(name))
      expect(res.headers.get(name)).not.toBeNull()
    }
  })

  it('mirrors a 201 on a create rather than flattening it to 200', async () => {
    const res = await postJson('/api/hl/proxy/contacts/', { firstName: 'Casey' }, auth(aliceToken))

    expect(res.status).toBe(201)
  })

  it('attaches our Authorization, the row’s Version and Accept', async () => {
    const res = await getJson('/api/hl/proxy/contacts/__echo', auth(aliceToken))

    expect(res.status).toBe(200)
    const { headers } = res.body as EchoedRequest
    expect(headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(headers['version']).toBe('2021-07-28')
    expect(headers['accept']).toBe('application/json')
  })

  /*
   * Per row, not per prefix. The two surfaces genuinely disagree about which date they want, and
   * a version taken from anywhere but the table is a version a caller could choose.
   */
  it("sends the row's own Version on each surface", async () => {
    const contacts = await getJson('/api/hl/proxy/contacts/__echo', auth(aliceToken))
    const calendars = await getJson('/api/hl/proxy/calendars/__echo', auth(aliceToken))

    expect((contacts.body as EchoedRequest).headers['version']).toBe('2021-07-28')
    expect((calendars.body as EchoedRequest).headers['version']).toBe('2021-04-15')
  })

  /*
   * A forwarded header is an input we did not decide to accept, and two of these are worse than
   * untidy: a caller-supplied `Authorization` would be credential substitution, and a caller-
   * supplied `Version` a way to reach undocumented behaviour.
   */
  it('forwards no header the caller sent', async () => {
    const res = await getJson('/api/hl/proxy/contacts/__echo', {
      ...auth(aliceToken),
      Version: 'v3',
      Cookie: 'hl_session=caller-cookie-value',
      'X-Forwarded-For': '10.9.8.7',
    })

    const { headers } = res.body as EchoedRequest
    const seen = JSON.stringify(headers)

    expect(headers['version']).toBe('2021-07-28')
    expect(headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(seen).not.toContain('caller-cookie-value')
    expect(seen).not.toContain('10.9.8.7')
    // The caller's own ID token is a credential too, and it has no business
    // upstream even in a header nobody reads.
    expect(seen).not.toContain(aliceToken)
  })

  /*
   * R1, made observable. Bob names alice's location in his own body; the proxy writes his over
   * it, and the stub — which filters by the value it actually received — answers with nothing.
   */
  it('gives each user only their own location’s records', async () => {
    await seedConnection(bobUid, { locationId: BOB_LOCATION })

    const alice = await postJson(
      '/api/hl/proxy/contacts/search',
      { pageLimit: 1 },
      auth(aliceToken),
    )
    const bob = await postJson(
      '/api/hl/proxy/contacts/search',
      { pageLimit: 1, locationId: ALICE_LOCATION },
      auth(bobToken),
    )

    expect((alice.body as { total: number }).total).toBe(5)
    expect((bob.body as { total: number }).total).toBe(0)
    expect((bob.body as { contacts: unknown[] }).contacts).toEqual([])
  })
})

/**
 * Every way HighLevel can fail us, over the wire.
 *
 * The pure mapping is proved row by row in `functions/src/hl/proxyError.spec.ts`. What this adds
 * is the two halves that file cannot see: that the mapped status is what a caller actually
 * receives, and that the **side effects** happen — a 401 marks the connection, an abort is a
 * real abort rather than a request still running behind a returned error.
 */
describe('upstream failures', () => {
  beforeEach(async () => {
    await seedConnection(aliceUid)
  })

  async function storedFlag(): Promise<unknown> {
    return (await adminDb().doc(`hlConnections/${aliceUid}`).get()).data()?.['needsReconnect']
  }

  /*
   * Never 401, and the reason is not cosmetic: `apiClient` reads a 401 as "your session died"
   * and signs the user out of Genesis.
   */
  it('turns an upstream 401 into a 409 and marks the connection', async () => {
    const res = await getJson('/api/hl/proxy/contacts/__401', auth(aliceToken))

    expect(res.status).toBe(409)
    expect(res.status).not.toBe(401)
    expect((res.body as { code?: string }).code).toBe('hl_reconnect_required')
    expect(await storedFlag()).toBe(true)
  })

  it("forwards HighLevel's own message as detail", async () => {
    const res = await getJson('/api/hl/proxy/contacts/__401', auth(aliceToken))

    expect((res.body as { detail?: string }).detail).toBe('Invalid JWT')
  })

  /* The headers are the whole value of a 429: they turn "try again later" into a number. */
  it('maps a 429 with the rate-limit headers still attached', async () => {
    const res = await getJson('/api/hl/proxy/contacts/__429', auth(aliceToken))

    expect(res.status).toBe(429)
    expect((res.body as { code?: string }).code).toBe('hl_rate_limited')
    expect(res.headers.get('x-ratelimit-remaining')).not.toBeNull()
    expect(await storedFlag()).toBe(false)
  })

  it('maps an upstream 5xx to hl_unavailable without marking the connection', async () => {
    const res = await getJson('/api/hl/proxy/contacts/__500', auth(aliceToken))

    expect(res.status).toBe(502)
    expect((res.body as { code?: string }).code).toBe('hl_unavailable')
    expect(await storedFlag()).toBe(false)
  })

  /*
   * The `api` function's own budget is 60 s, so an unbounded upstream call would spend the whole
   * request and answer nothing.
   */
  it('aborts an upstream that will not answer', async () => {
    const res = await getJson('/api/hl/proxy/contacts/__slow', auth(aliceToken))

    expect(res.status).toBe(504)
    expect((res.body as { code?: string }).code).toBe('hl_timeout')
  })

  it('refuses an upstream body over the cap when its length is declared', async () => {
    const res = await getJson('/api/hl/proxy/contacts/__huge', auth(aliceToken))

    expect(res.status).toBe(502)
    expect((res.body as { code?: string }).code).toBe('hl_too_large')
  })

  /*
   * The same cap, reached the other way. A chunked response declares no `Content-Length`, so the
   * short-circuit cannot see it and the running byte count is the only thing standing between a
   * pathological `pageLimit` and an out-of-memory.
   */
  it('refuses an upstream body over the cap when it arrives chunked', async () => {
    const res = await getJson('/api/hl/proxy/contacts/__hugestream', auth(aliceToken))

    expect(res.status).toBe(502)
    expect((res.body as { code?: string }).code).toBe('hl_too_large')
  })

  it('puts no token material in any upstream failure', async () => {
    for (const marker of ['__401', '__429', '__500', '__slow', '__huge']) {
      const res = await getJson(`/api/hl/proxy/contacts/${marker}`, auth(aliceToken))

      expect(res.raw).not.toContain(ACCESS_TOKEN)
      expect(res.raw).not.toContain(REFRESH_TOKEN)
      expect(res.raw).not.toContain(aliceUid)
    }
  })
})
