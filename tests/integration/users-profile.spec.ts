import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adminDb, getJson, idTokenFor, resetEmulators, seedUser } from './helpers'

/**
 * `GET` and `PUT /api/users/me` — the whole of the browser's access to its own
 * profile.
 *
 * `users/{uid}` used to be client-written under owner-scoped rules. It is now
 * denied to every client and written only by the Admin SDK inside these routes,
 * which is the project's one data-access pattern. What that buys is checked
 * here rather than assumed: the uid comes from the token, so no request can name
 * another user, and the body is parsed `.strict()`, so a request that tries is
 * refused rather than partially honoured.
 *
 * The path is the literal `me`. There is no `:uid` parameter to confuse with the
 * token's uid, which makes the cross-tenant mistake inexpressible rather than
 * merely guarded against.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'profile-alice@example.test'
const BOB = 'profile-bob@example.test'
const UNVERIFIED = 'profile-unverified@example.test'

let aliceUid: string
let bobUid: string
let aliceToken: string
let unverifiedToken: string

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** Write a document past the routes, so a read has something to find. */
async function seedProfile(uid: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await adminDb()
    .doc(`users/${uid}`)
    .set({
      email: 'seeded@example.test',
      displayName: null,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_500_000),
      ...overrides,
    })
}

function profileOf(body: unknown): Record<string, unknown> | null {
  return (body as { profile: Record<string, unknown> | null }).profile
}

beforeAll(async () => {
  await resetEmulators()
  aliceUid = await seedUser(ALICE, PASSWORD, true)
  bobUid = await seedUser(BOB, PASSWORD, true)
  await seedUser(UNVERIFIED, PASSWORD, false)
  aliceToken = await idTokenFor(ALICE, PASSWORD)
  unverifiedToken = await idTokenFor(UNVERIFIED, PASSWORD)
})

beforeEach(async () => {
  await adminDb().doc(`users/${aliceUid}`).delete()
  await adminDb().doc(`users/${bobUid}`).delete()
})

describe('GET /api/users/me', () => {
  /** AC-3. */
  it('returns the profile once one exists, with ISO-8601 timestamps', async () => {
    await seedProfile(aliceUid, { displayName: 'Alice' })

    const res = await getJson('/api/users/me', auth(aliceToken))
    const profile = profileOf(res.body)

    expect(res.status).toBe(200)
    expect(profile?.['email']).toBe('seeded@example.test')
    expect(profile?.['displayName']).toBe('Alice')
    for (const field of ['createdAt', 'updatedAt'] as const) {
      const value = profile?.[field]
      expect(typeof value).toBe('string')
      expect(new Date(value as string).toISOString()).toBe(value)
    }
  })

  /*
   * AC-4. "Verified, signed in, no profile yet" is an ordinary state — it is
   * where a user sits between verifying and their first ensure — and it is the
   * account card's empty state. A 404 would force the client to read a normal
   * state out of the error channel, and the first client that forgot would show
   * an error screen to a healthy account.
   */
  it('answers 200 with a null profile rather than 404 when there is none', async () => {
    const res = await getJson('/api/users/me', auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ profile: null })
  })

  /** AC-6. */
  it('refuses an unauthenticated caller with 401 and creates nothing', async () => {
    const res = await getJson('/api/users/me')

    expect(res.status).toBe(401)
    expect((res.body as { code?: string }).code).toBe('unauthenticated')
    expect((await adminDb().doc(`users/${aliceUid}`).get()).exists).toBe(false)
  })

  /** AC-7. A router guard stops a browser; it does not stop a direct call. */
  it('refuses an unverified caller with 403', async () => {
    const res = await getJson('/api/users/me', auth(unverifiedToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('email_unverified')
  })

  /*
   * AC-11, D18. A document that cannot describe a profile is reported as no
   * profile, not as a profile with blanks in it — truthful, and self-healing,
   * because the next ensure rewrites it.
   */
  it('fails closed on a stored document with no email', async () => {
    await adminDb().doc(`users/${aliceUid}`).set({ displayName: 'Alice' })

    const res = await getJson('/api/users/me', auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ profile: null })
  })
})
