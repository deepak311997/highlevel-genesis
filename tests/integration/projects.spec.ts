import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adminDb, getJson, idTokenFor, postJson, resetEmulators, seedUser } from './helpers'

/**
 * `/api/projects*` — the whole of the browser's access to its projects.
 *
 * `users/{uid}/projects/{projectId}` is denied to every client by
 * `firestore.rules` and written only by the Admin SDK inside these routes. What
 * that buys is checked here rather than assumed, and the property worth the most
 * is a structural one: the document path is `users/{token uid}/projects/{id}`,
 * so another user's project is not addressable by a request at all. There is no
 * `ownerUid` comparison anywhere for a test to catch missing — which is why the
 * cross-tenant cases assert bob's document is *unchanged* rather than only that
 * alice got a 404.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'projects-alice@example.test'
const BOB = 'projects-bob@example.test'
const UNVERIFIED = 'projects-unverified@example.test'

let aliceUid: string
let bobUid: string
let aliceToken: string
let unverifiedToken: string

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** Write a project past the routes, so a read has something to find. */
async function seedProject(
  uid: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await adminDb()
    .doc(`users/${uid}/projects/${id}`)
    .set({
      name: `Project ${id}`,
      description: null,
      locationId: null,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      deletedAt: null,
      ...overrides,
    })
}

/**
 * Fill the collection to the cap in one batch.
 *
 * `deleted` of them carry a `deletedAt`, which is what proves the cap counts
 * live projects rather than documents.
 */
async function seedMany(uid: string, count: number, deleted = 0): Promise<void> {
  const batch = adminDb().batch()
  for (let index = 0; index < count; index += 1) {
    batch.set(adminDb().doc(`users/${uid}/projects/bulk-${String(index)}`), {
      name: `Bulk ${String(index)}`,
      description: null,
      locationId: null,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000 + index),
      deletedAt: index < deleted ? Timestamp.fromMillis(1_700_000_900_000) : null,
    })
  }
  await batch.commit()
}

async function clearProjects(uid: string): Promise<void> {
  const refs = await adminDb().collection(`users/${uid}/projects`).listDocuments()
  await Promise.all(refs.map((ref) => ref.delete()))
}

async function countProjects(uid: string): Promise<number> {
  return (await adminDb().collection(`users/${uid}/projects`).listDocuments()).length
}

function projectsOf(body: unknown): Record<string, unknown>[] {
  return (body as { projects: Record<string, unknown>[] }).projects
}

function projectOf(body: unknown): Record<string, unknown> {
  return (body as { project: Record<string, unknown> }).project
}

function codeOf(body: unknown): string | undefined {
  return (body as { code?: string }).code
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
  await clearProjects(aliceUid)
  await clearProjects(bobUid)
  await adminDb().doc(`hlConnections/${aliceUid}`).delete()
})

describe('GET /api/projects', () => {
  /** AC-3. Newest-updated first, and `deletedAt` never on the wire. */
  it('returns the live projects, updatedAt descending, in the wire shape', async () => {
    await seedProject(aliceUid, 'oldest', {
      name: 'Oldest',
      updatedAt: Timestamp.fromMillis(1_700_000_100_000),
    })
    await seedProject(aliceUid, 'newest', {
      name: 'Newest',
      updatedAt: Timestamp.fromMillis(1_700_000_300_000),
    })
    await seedProject(aliceUid, 'middle', {
      name: 'Middle',
      updatedAt: Timestamp.fromMillis(1_700_000_200_000),
    })

    const res = await getJson('/api/projects', auth(aliceToken))
    const projects = projectsOf(res.body)

    expect(res.status).toBe(200)
    expect(projects.map((project) => project['name'])).toEqual(['Newest', 'Middle', 'Oldest'])
    for (const project of projects) {
      expect(Object.keys(project).sort()).toEqual([
        'createdAt',
        'description',
        'id',
        'locationId',
        'name',
        'updatedAt',
      ])
      expect(new Date(project['createdAt'] as string).toISOString()).toBe(project['createdAt'])
    }
  })

  /*
   * AC-4. "Signed in, no projects yet" is the card's empty state and an
   * ordinary place to be — answering it through the error channel would make the
   * first client that forgot to translate a 404 show an error to a healthy
   * account.
   */
  it('answers 200 with an empty array rather than 404 when there are none', async () => {
    const res = await getJson('/api/projects', auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ projects: [] })
  })

  /** AC-10. */
  it('refuses an unauthenticated caller with 401', async () => {
    const res = await getJson('/api/projects')

    expect(res.status).toBe(401)
    expect(codeOf(res.body)).toBe('unauthenticated')
  })

  /** AC-11. A router guard stops a browser; it does not stop a direct call. */
  it('refuses an unverified caller with 403', async () => {
    const res = await getJson('/api/projects', auth(unverifiedToken))

    expect(res.status).toBe(403)
    expect(codeOf(res.body)).toBe('email_unverified')
  })

  /*
   * AC-13, and R1's whole defence. The query is
   * `collection('users/{token uid}/projects')`, so it is scoped before a `where`
   * clause is written — bob's projects are not filtered out, they were never in
   * range.
   */
  it("returns only alice's projects, with bob's seeded alongside", async () => {
    await seedProject(aliceUid, 'alice-1', { name: "Alice's" })
    await seedProject(bobUid, 'bob-1', { name: "Bob's" })

    const projects = projectsOf((await getJson('/api/projects', auth(aliceToken))).body)

    expect(projects.map((project) => project['name'])).toEqual(["Alice's"])
  })

  /*
   * AC-20. A half-populated project drawn as a row is a row the user can click
   * actions on and cannot fix, so it is omitted — and its siblings still render,
   * because one bad document is not a broken screen.
   */
  it('omits a document that cannot be parsed, and returns its siblings', async () => {
    await seedProject(aliceUid, 'good', { name: 'Good' })
    await adminDb().doc(`users/${aliceUid}/projects/corrupt`).set({ description: 'no name here' })

    const projects = projectsOf((await getJson('/api/projects', auth(aliceToken))).body)

    expect(projects.map((project) => project['name'])).toEqual(['Good'])
  })

  /*
   * D6, and R3 from the other side. `where('deletedAt','==',null)` matches
   * documents whose field *is* null and skips documents where it is absent — so
   * a project written before the field existed would be invisible to its own
   * list if the query were the only guard. It is not: the field is written
   * explicitly on create, and this pins that a soft-deleted one is excluded.
   */
  it('excludes a soft-deleted project', async () => {
    await seedProject(aliceUid, 'live', { name: 'Live' })
    await seedProject(aliceUid, 'gone', {
      name: 'Gone',
      deletedAt: Timestamp.fromMillis(1_700_000_400_000),
    })

    const projects = projectsOf((await getJson('/api/projects', auth(aliceToken))).body)

    expect(projects.map((project) => project['name'])).toEqual(['Live'])
  })
})

describe('POST /api/projects', () => {
  /*
   * AC-1, and R3. The stored `deletedAt` is asserted rather than only the
   * response: `where('deletedAt','==',null)` skips documents where the field is
   * *absent*, so a create that omitted it would produce a project invisible to
   * its own list — a bug no response-shape assertion can see.
   */
  it('creates a project, returns 201, and stores an explicit null deletedAt', async () => {
    const res = await postJson('/api/projects', { name: 'Contact dashboard' }, auth(aliceToken))
    const project = projectOf(res.body)

    expect(res.status).toBe(201)
    expect(project['name']).toBe('Contact dashboard')
    expect(project['description']).toBeNull()
    expect(typeof project['id']).toBe('string')
    expect(new Date(project['createdAt'] as string).toISOString()).toBe(project['createdAt'])
    expect(new Date(project['updatedAt'] as string).toISOString()).toBe(project['updatedAt'])

    const snapshot = await adminDb()
      .doc(`users/${aliceUid}/projects/${String(project['id'])}`)
      .get()
    expect(snapshot.exists).toBe(true)
    expect(snapshot.get('deletedAt')).toBeNull()
  })

  /** The id is the server's to generate (D5), so it is never the name. */
  it('generates the id rather than deriving it from the name', async () => {
    const project = projectOf(
      (await postJson('/api/projects', { name: 'Contact dashboard' }, auth(aliceToken))).body,
    )

    expect(project['id']).not.toBe('Contact dashboard')
    expect(project['id']).not.toContain(' ')
  })

  /** AC-2. */
  it('trims a description on the way in', async () => {
    const project = projectOf(
      (
        await postJson(
          '/api/projects',
          { name: 'Contacts', description: '  Lists and filters contacts  ' },
          auth(aliceToken),
        )
      ).body,
    )

    expect(project['description']).toBe('Lists and filters contacts')
    const stored = await adminDb()
      .doc(`users/${aliceUid}/projects/${String(project['id'])}`)
      .get()
    expect(stored.get('description')).toBe('Lists and filters contacts')
  })

  /*
   * AC-14. Every one of these is a field the server owns. The second assertion
   * is the one that matters — nothing was written, because the body is parsed
   * before anything touches Firestore.
   */
  it.each(['ownerUid', 'id', 'locationId', 'createdAt', 'deletedAt'])(
    'refuses a body carrying %s, writing nothing',
    async (key) => {
      const res = await postJson('/api/projects', { name: 'A', [key]: 'x' }, auth(aliceToken))

      expect(res.status).toBe(400)
      expect(codeOf(res.body)).toBe('invalid_body')
      expect(await countProjects(aliceUid)).toBe(0)
    },
  )

  /** AC-15. */
  it.each([
    ['a missing name', {}],
    ['a blank name', { name: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a non-string name', { name: 42 }],
    ['an over-length name', { name: 'a'.repeat(81) }],
    ['an over-length description', { name: 'A', description: 'a'.repeat(501) }],
  ])('refuses %s', async (_label, body) => {
    const res = await postJson('/api/projects', body, auth(aliceToken))

    expect(res.status).toBe(400)
    expect(codeOf(res.body)).toBe('invalid_body')
    expect(await countProjects(aliceUid)).toBe(0)
  })

  /*
   * AC-19, D9. The location is read from `hlConnections/{uid}` server-side and
   * snapshotted at create — reconnecting to a different location later does not
   * silently repoint an existing project, and a caller cannot name one.
   */
  it('takes locationId from the connection, and null when there is none', async () => {
    const withoutConnection = projectOf(
      (await postJson('/api/projects', { name: 'Unconnected' }, auth(aliceToken))).body,
    )
    expect(withoutConnection['locationId']).toBeNull()

    await adminDb()
      .doc(`hlConnections/${aliceUid}`)
      .set({ accessToken: 'x', refreshToken: 'y', locationId: 'loc_123', needsReconnect: false })

    const withConnection = projectOf(
      (await postJson('/api/projects', { name: 'Connected' }, auth(aliceToken))).body,
    )
    expect(withConnection['locationId']).toBe('loc_123')
    const stored = await adminDb()
      .doc(`users/${aliceUid}/projects/${String(withConnection['id'])}`)
      .get()
    expect(stored.get('locationId')).toBe('loc_123')
  })

  /*
   * AC-18, D8. The cap is what makes the unpaginated list honest: creation stops
   * at exactly what the list can show, so "you are seeing all of your projects"
   * is a guarantee rather than a hope.
   */
  it('refuses a 101st live project with 409, writing nothing', async () => {
    await seedMany(aliceUid, 100)

    const res = await postJson('/api/projects', { name: 'One too many' }, auth(aliceToken))

    expect(res.status).toBe(409)
    expect(codeOf(res.body)).toBe('project_limit')
    expect((res.body as { error?: string }).error).toContain('100')
    expect(await countProjects(aliceUid)).toBe(100)
  })

  /** AC-18's second half: deleted projects do not count toward the cap. */
  it('allows a create when half of a full collection is soft-deleted', async () => {
    await seedMany(aliceUid, 100, 50)

    const res = await postJson('/api/projects', { name: 'Room for this' }, auth(aliceToken))

    expect(res.status).toBe(201)
    expect(await countProjects(aliceUid)).toBe(101)
  })

  /** AC-10. */
  it('refuses an unauthenticated caller with 401, writing nothing', async () => {
    const res = await postJson('/api/projects', { name: 'A' })

    expect(res.status).toBe(401)
    expect(codeOf(res.body)).toBe('unauthenticated')
    expect(await countProjects(aliceUid)).toBe(0)
  })

  /** AC-11. */
  it('refuses an unverified caller with 403, writing nothing', async () => {
    const res = await postJson('/api/projects', { name: 'A' }, auth(unverifiedToken))

    expect(res.status).toBe(403)
    expect(codeOf(res.body)).toBe('email_unverified')
  })
})
