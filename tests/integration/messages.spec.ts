import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adminDb, getJson, idTokenFor, resetEmulators, seedUser } from './helpers'

/**
 * `/api/projects/:projectId/messages` — the whole of the browser's access to a
 * transcript.
 *
 * `users/{uid}/projects/{projectId}/messages` is denied to every client by
 * `firestore.rules` and written only by the Admin SDK inside these two routes.
 * Two properties are worth more than the rest here.
 *
 * The first is structural: the document path is
 * `users/{token uid}/projects/{id}/messages`, so another user's transcript is not
 * addressable by a request at all. There is no `ownerUid` comparison anywhere for
 * a test to catch missing — which is why the cross-tenant cases assert bob's
 * documents are *unchanged* rather than only that alice got a 404.
 *
 * The second is R1's, and it is the reason this file exists rather than trusting
 * the L1 query test alone. A `WriteBatch` gives every `serverTimestamp()` in it
 * the same commit timestamp, so the two messages of a turn are exactly tied on
 * `createdAt` — every single turn. Only a real commit read back through the real
 * query proves `seq` breaks that tie the right way round.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'messages-alice@example.test'
const BOB = 'messages-bob@example.test'
const UNVERIFIED = 'messages-unverified@example.test'

/** D7's echo, byte for byte. The composer and the e2e test both read it. */
const ECHO = 'You said: build a contact dashboard'

let aliceUid: string
let bobUid: string
let aliceToken: string
let unverifiedToken: string

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** Write a project past the routes, so a transcript has somewhere to live. */
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

/** Write a message past the routes, so a read has something to find. */
async function seedMessage(
  uid: string,
  projectId: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await adminDb()
    .doc(`users/${uid}/projects/${projectId}/messages/${id}`)
    .set({
      role: 'user',
      content: 'seeded',
      seq: 0,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      ...overrides,
    })
}

/**
 * Fill a transcript to an arbitrary depth in one batch.
 *
 * Every document gets a distinct `createdAt`, so the cap is the only thing under
 * test here and ordering is not accidentally part of it.
 */
async function seedMany(uid: string, projectId: string, count: number): Promise<void> {
  const batch = adminDb().batch()
  for (let index = 0; index < count; index += 1) {
    batch.set(adminDb().doc(`users/${uid}/projects/${projectId}/messages/bulk-${String(index)}`), {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Bulk ${String(index)}`,
      seq: index % 2,
      createdAt: Timestamp.fromMillis(1_700_000_000_000 + index * 1000),
    })
  }
  await batch.commit()
}

async function clearProjects(uid: string): Promise<void> {
  const refs = await adminDb().collection(`users/${uid}/projects`).listDocuments()
  await Promise.all(refs.map((ref) => adminDb().recursiveDelete(ref)))
}

async function storedMessages(uid: string, projectId: string): Promise<Record<string, unknown>[]> {
  const snapshot = await adminDb()
    .collection(`users/${uid}/projects/${projectId}/messages`)
    .orderBy('createdAt', 'asc')
    .orderBy('seq', 'asc')
    .get()
  return snapshot.docs.map((doc) => doc.data())
}

function messagesOf(body: unknown): Record<string, unknown>[] {
  return (body as { messages: Record<string, unknown>[] }).messages
}

function codeOf(body: unknown): string | undefined {
  return (body as { code?: string }).code
}

/**
 * The 404 the routes produce, asserted by its message as well as its code.
 *
 * The app's terminal catch-all also answers `404 not_found`, so a case checking
 * only the status and the code would pass against a route that does not exist —
 * which is precisely the state these tests start in. The user-facing copy is what
 * separates "this route answered" from "nothing matched", and it is the *project*
 * copy on purpose (D14): the project is what is gone.
 */
function expectNotFound(res: { status: number; body: unknown }): void {
  expect(res.status).toBe(404)
  expect(codeOf(res.body)).toBe('not_found')
  expect((res.body as { error?: string }).error).toBe('That project no longer exists.')
}

const path = (projectId: string) => `/api/projects/${projectId}/messages`

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
  await seedProject(aliceUid, 'proj-1')
})

describe('GET /api/projects/:projectId/messages', () => {
  /*
   * AC-2, and R1 from the direction that matters. The two documents carry the
   * *same* `createdAt` — which is not a contrivance, it is what a `WriteBatch`
   * actually produces — so ordering by `createdAt` alone would fall through to
   * Firestore's `__name__` tiebreak. `msg-b` sorts before `msg-a` by name, so a
   * handler missing the second `orderBy` returns the assistant first and fails
   * here.
   */
  it('returns the user message before its assistant reply when the two share a timestamp', async () => {
    const tied = Timestamp.fromMillis(1_700_000_500_000)
    await seedMessage(aliceUid, 'proj-1', 'msg-b', {
      role: 'assistant',
      content: ECHO,
      seq: 1,
      createdAt: tied,
    })
    await seedMessage(aliceUid, 'proj-1', 'msg-a', {
      role: 'user',
      content: 'build a contact dashboard',
      seq: 0,
      createdAt: tied,
    })

    const res = await getJson(path('proj-1'), auth(aliceToken))
    const messages = messagesOf(res.body)

    expect(res.status).toBe(200)
    expect(messages.map((message) => message['role'])).toEqual(['user', 'assistant'])
    expect(messages.map((message) => message['content'])).toEqual([
      'build a contact dashboard',
      ECHO,
    ])
  })

  /** AC-2's wire shape: four keys, and `seq` is not one of them. */
  it('puts the wire shape on the wire, carrying no seq', async () => {
    await seedMessage(aliceUid, 'proj-1', 'msg-a')

    const messages = messagesOf((await getJson(path('proj-1'), auth(aliceToken))).body)

    for (const message of messages) {
      expect(Object.keys(message).sort()).toEqual(['content', 'createdAt', 'id', 'role'])
      expect(new Date(message['createdAt'] as string).toISOString()).toBe(message['createdAt'])
    }
  })

  /*
   * AC-3. Across separate turns the commit timestamps genuinely differ, so this
   * is the case `seq` costs nothing on — and the one that would catch a handler
   * ordering by `seq` first, which would put every user message above every
   * assistant one across the whole history.
   */
  it('returns turns oldest-first across turns as well as within them', async () => {
    const turns = ['first', 'second', 'third']
    for (const [index, content] of turns.entries()) {
      const at = Timestamp.fromMillis(1_700_000_000_000 + index * 10_000)
      await seedMessage(aliceUid, 'proj-1', `user-${content}`, { content, seq: 0, createdAt: at })
      await seedMessage(aliceUid, 'proj-1', `bot-${content}`, {
        role: 'assistant',
        content: `You said: ${content}`,
        seq: 1,
        createdAt: at,
      })
    }

    const messages = messagesOf((await getJson(path('proj-1'), auth(aliceToken))).body)

    expect(messages.map((message) => message['content'])).toEqual([
      'first',
      'You said: first',
      'second',
      'You said: second',
      'third',
      'You said: third',
    ])
  })

  /*
   * AC-4. "This project has no messages yet" is the chat panel's empty state and
   * an ordinary place to be — answering it through the error channel would make
   * the first client that forgot to translate a 404 show an error on a healthy
   * project.
   */
  it('answers 200 with an empty array rather than 404 when there are none', async () => {
    const res = await getJson(path('proj-1'), auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ messages: [] })
  })

  /** AC-6. */
  it('refuses an unauthenticated caller with 401', async () => {
    const res = await getJson(path('proj-1'))

    expect(res.status).toBe(401)
    expect(codeOf(res.body)).toBe('unauthenticated')
  })

  /** AC-7. A router guard stops a browser; it does not stop a direct call. */
  it('refuses an unverified caller with 403', async () => {
    const res = await getJson(path('proj-1'), auth(unverifiedToken))

    expect(res.status).toBe(403)
    expect(codeOf(res.body)).toBe('email_unverified')
  })

  /*
   * AC-8. The 404 alone would be satisfied by a handler that read bob's
   * collection and then refused; the unchanged-documents assertion is what proves
   * it was never reachable. Alice's request names
   * `users/{alice}/projects/bob-1/messages`, which does not exist.
   */
  it("answers 404 for bob's project and leaves his transcript untouched", async () => {
    await seedProject(bobUid, 'bob-1')
    await seedMessage(bobUid, 'bob-1', 'msg-a', { content: "Bob's prompt" })
    const before = await storedMessages(bobUid, 'bob-1')

    expectNotFound(await getJson(path('bob-1'), auth(aliceToken)))

    expect(await storedMessages(bobUid, 'bob-1')).toEqual(before)
  })

  /** AC-9. Soft-deleted and never-existed collapse into the one answer (D14). */
  it('answers 404 for a soft-deleted project', async () => {
    await seedProject(aliceUid, 'gone', { deletedAt: Timestamp.fromMillis(1_700_000_900_000) })
    await seedMessage(aliceUid, 'gone', 'msg-a')

    expectNotFound(await getJson(path('gone'), auth(aliceToken)))
  })

  it('answers 404 for an id that never existed', async () => {
    expectNotFound(await getJson(path('neverExisted'), auth(aliceToken)))
  })

  /** AC-9's third shape: a project document that cannot be parsed reads as gone. */
  it('answers 404 for a project document that cannot be parsed', async () => {
    await adminDb().doc(`users/${aliceUid}/projects/corrupt`).set({ description: 'no name here' })

    expectNotFound(await getJson(path('corrupt'), auth(aliceToken)))
  })

  /*
   * AC-10. `a%2Fb` earns its place: it arrives at the router as one segment and
   * Express decodes it to `a/b`, so it is a path separator routing let through —
   * exactly what the id schema exists to catch, since `getDb().doc()` composes by
   * concatenation and a slash changes the *depth* of the path.
   *
   * `..` is absent deliberately: the WHATWG URL parser removes double-dot
   * segments before the request is sent, so it cannot be tested over the wire.
   * It is covered at L1 in `functions/src/projects/schema.spec.ts`.
   */
  it.each(['a'.repeat(65), 'bad!id', 'a%2Fb', 'has%20space'])(
    'refuses the malformed id %s with 400',
    async (id) => {
      const res = await getJson(path(id), auth(aliceToken))

      expect(res.status).toBe(400)
      expect(codeOf(res.body)).toBe('invalid_id')
    },
  )

  /*
   * AC-15. Omission is the whole behaviour, and it is asserted for all three
   * shapes rather than only the parseable-but-wrong ones — because two of the
   * three never reach the parser at all. A Firestore `orderBy` **excludes
   * documents where the field is absent**, so the one seeded without `createdAt`
   * is filtered by the query itself. The observable outcome is identical either
   * way, which is the only thing an integration test can see: the transcript is
   * shorter and its healthy siblings are still there.
   *
   * The two documents that must actually exercise the parse — a missing `content`
   * and a bad `role` — are therefore seeded **with** a valid `createdAt` and
   * `seq`, or they would prove nothing about it. The `message.unreadable` log
   * line is asserted at L1, where the process's console is reachable.
   */
  it('omits documents that cannot be parsed, and returns their siblings', async () => {
    await seedMessage(aliceUid, 'proj-1', 'good', {
      content: 'the healthy one',
      createdAt: Timestamp.fromMillis(1_700_000_100_000),
    })
    await adminDb()
      .doc(`users/${aliceUid}/projects/proj-1/messages/no-content`)
      .set({ role: 'user', seq: 0, createdAt: Timestamp.fromMillis(1_700_000_200_000) })
    await adminDb()
      .doc(`users/${aliceUid}/projects/proj-1/messages/bad-role`)
      .set({
        role: 'system',
        content: 'from nowhere',
        seq: 0,
        createdAt: Timestamp.fromMillis(1_700_000_300_000),
      })
    await adminDb()
      .doc(`users/${aliceUid}/projects/proj-1/messages/no-timestamp`)
      .set({ role: 'user', content: 'undated', seq: 0 })

    const messages = messagesOf((await getJson(path('proj-1'), auth(aliceToken))).body)

    expect(messages.map((message) => message['content'])).toEqual(['the healthy one'])
  })

  /** The cap is a read limit too, so the list cannot outgrow what it promises. */
  it('returns at most the cap, even if more documents exist', async () => {
    await seedMany(aliceUid, 'proj-1', 205)

    const messages = messagesOf((await getJson(path('proj-1'), auth(aliceToken))).body)

    expect(messages).toHaveLength(200)
    expect(messages[0]?.['content']).toBe('Bulk 0')
  })
})
