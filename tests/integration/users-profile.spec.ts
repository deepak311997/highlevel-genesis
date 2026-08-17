import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adminDb, getJson, idTokenFor, putJson, resetEmulators, seedUser } from './helpers'

/**
 * `GET` and `PUT /api/profile` — the whole of the browser's access to its own
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
let bobToken: string
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
  bobToken = await idTokenFor(BOB, PASSWORD)
  unverifiedToken = await idTokenFor(UNVERIFIED, PASSWORD)
})

beforeEach(async () => {
  await adminDb().doc(`users/${aliceUid}`).delete()
  await adminDb().doc(`users/${bobUid}`).delete()
})

describe('GET /api/profile', () => {
  /** AC-3. */
  it('returns the profile once one exists, with ISO-8601 timestamps', async () => {
    await seedProfile(aliceUid, { displayName: 'Alice' })

    const res = await getJson('/api/profile', auth(aliceToken))
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
    const res = await getJson('/api/profile', auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ profile: null })
  })

  /** AC-6. */
  it('refuses an unauthenticated caller with 401 and creates nothing', async () => {
    const res = await getJson('/api/profile')

    expect(res.status).toBe(401)
    expect((res.body as { code?: string }).code).toBe('unauthenticated')
    expect((await adminDb().doc(`users/${aliceUid}`).get()).exists).toBe(false)
  })

  /** AC-7. A router guard stops a browser; it does not stop a direct call. */
  it('refuses an unverified caller with 403', async () => {
    const res = await getJson('/api/profile', auth(unverifiedToken))

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

    const res = await getJson('/api/profile', auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ profile: null })
  })

  /* D18's second half: the corruption is repaired by the next ensure. */
  it('is repaired by a following PUT', async () => {
    await adminDb().doc(`users/${aliceUid}`).set({ displayName: 'Alice' })

    await putJson('/api/profile', {}, auth(aliceToken))
    const profile = profileOf((await getJson('/api/profile', auth(aliceToken))).body)

    expect(profile?.['email']).toBe(ALICE)
  })
})

describe('PUT /api/profile', () => {
  /** AC-1. */
  it('creates the document and returns it, with the email from the Auth record', async () => {
    const res = await putJson('/api/profile', {}, auth(aliceToken))
    const profile = profileOf(res.body)

    expect(res.status).toBe(200)
    expect(profile?.['email']).toBe(ALICE)
    expect(profile?.['displayName']).toBeNull()
    expect(typeof profile?.['createdAt']).toBe('string')
    expect((await adminDb().doc(`users/${aliceUid}`).get()).exists).toBe(true)
  })

  /*
   * AC-2. The verb is `PUT` because the operation is an ensure — create if
   * absent, touch if present, same result however many times it is called. A
   * refresh, a second tab and a retry after a timeout all land here.
   *
   * The sleep is not padding: the wire format is millisecond-precision ISO, and
   * two back-to-back writes can land inside a single millisecond, which would
   * make "strictly later" a flake rather than a bug.
   */
  it('preserves createdAt and advances updatedAt on a second call', async () => {
    const first = profileOf((await putJson('/api/profile', {}, auth(aliceToken))).body)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = profileOf((await putJson('/api/profile', {}, auth(aliceToken))).body)

    expect(second?.['createdAt']).toBe(first?.['createdAt'])
    expect(String(second?.['updatedAt']) > String(first?.['updatedAt'])).toBe(true)
  })

  /** AC-5. Absent leaves the name alone; an explicit null clears it. */
  it('sets and then clears displayName', async () => {
    const set = profileOf(
      (await putJson('/api/profile', { displayName: 'Alice' }, auth(aliceToken))).body,
    )
    expect(set?.['displayName']).toBe('Alice')

    const untouched = profileOf((await putJson('/api/profile', {}, auth(aliceToken))).body)
    expect(untouched?.['displayName']).toBe('Alice')

    const cleared = profileOf(
      (await putJson('/api/profile', { displayName: null }, auth(aliceToken))).body,
    )
    expect(cleared?.['displayName']).toBeNull()
  })

  /*
   * AC-8, and R1's whole defence. `/me` means another user's id cannot be named
   * in the path; `.strict()` means it cannot be smuggled in the body either. The
   * assertion that matters is the second half — nothing was written, the
   * caller's own document included, because the body is parsed before anything
   * touches Firestore.
   */
  it("rejects a body carrying another user's uid, writing nothing", async () => {
    await seedProfile(bobUid, { email: BOB })

    const res = await putJson('/api/profile', { uid: bobUid }, auth(aliceToken))

    expect(res.status).toBe(400)
    expect((res.body as { code?: string }).code).toBe('invalid_body')
    expect((await adminDb().doc(`users/${aliceUid}`).get()).exists).toBe(false)
    expect((await adminDb().doc(`users/${bobUid}`).get()).get('email')).toBe(BOB)
  })

  it('rejects a body carrying an email, writing nothing', async () => {
    const res = await putJson('/api/profile', { email: 'attacker@example.test' }, auth(aliceToken))

    expect(res.status).toBe(400)
    expect((res.body as { code?: string }).code).toBe('invalid_body')
    expect((await adminDb().doc(`users/${aliceUid}`).get()).exists).toBe(false)
  })

  /** AC-9. */
  it.each([
    ['an over-length display name', { displayName: 'a'.repeat(81) }],
    ['a non-string display name', { displayName: 42 }],
  ])('rejects %s', async (_label, body) => {
    const res = await putJson('/api/profile', body, auth(aliceToken))

    expect(res.status).toBe(400)
    expect((res.body as { code?: string }).code).toBe('invalid_body')
  })

  /** AC-6. */
  it('refuses an unauthenticated caller with 401 and creates nothing', async () => {
    const res = await putJson('/api/profile', {})

    expect(res.status).toBe(401)
    expect((res.body as { code?: string }).code).toBe('unauthenticated')
    expect((await adminDb().doc(`users/${aliceUid}`).get()).exists).toBe(false)
  })

  /** AC-7. */
  it('refuses an unverified caller with 403 and creates nothing', async () => {
    const res = await putJson('/api/profile', {}, auth(unverifiedToken))

    expect(res.status).toBe(403)
    expect((res.body as { code?: string }).code).toBe('email_unverified')
  })

  /*
   * AC-10. The uid comes from the token and from nowhere else, so two users
   * holding valid tokens reach two documents — asserted rather than assumed,
   * because this is the property the whole route shape exists to guarantee.
   */
  it("returns alice's profile to alice and never touches bob's", async () => {
    await putJson('/api/profile', {}, auth(bobToken))
    const bobBefore = (await adminDb().doc(`users/${bobUid}`).get()).get('updatedAt') as {
      toMillis: () => number
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
    const put = profileOf((await putJson('/api/profile', {}, auth(aliceToken))).body)
    const got = profileOf((await getJson('/api/profile', auth(aliceToken))).body)

    expect(put?.['email']).toBe(ALICE)
    expect(got?.['email']).toBe(ALICE)

    const bobAfter = (await adminDb().doc(`users/${bobUid}`).get()).get('updatedAt') as {
      toMillis: () => number
    }
    expect(bobAfter.toMillis()).toBe(bobBefore.toMillis())
  })
})
