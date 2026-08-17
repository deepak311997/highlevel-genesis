import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminDb,
  framesOf,
  GENERATE_URL,
  getJson,
  idTokenFor,
  postGenerate,
  postJson,
  resetEmulators,
  seedUser,
  type GenerateResponse,
} from './helpers'

/**
 * `POST /generate` — the streaming endpoint, over the wire.
 *
 * **Two failure channels, and the boundary between them is `flushHeaders()`**
 * (D9, R6). Everything decided before the flush — auth, App Check, the body
 * parse, the project lookup, an empty context — is an ordinary JSON error with a
 * real status. Everything after it is an `error` event on a 200 stream, because
 * once the headers are gone the status line is spent.
 *
 * So every refusal case here asserts the `content-type` **is not** an event
 * stream, as well as the status. That is the half a status-code assertion cannot
 * see: a handler that opened the stream before deciding would answer `200
 * text/event-stream` carrying an `error` frame, and `expect(status).toBe(404)`
 * would be the only thing that noticed — on a test that had already been
 * rewritten to match.
 *
 * The LLM is the emulator-only fake (D20), driven by markers in the prompt. No
 * automated test in this project ever calls Anthropic.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'generate-alice@example.test'
const BOB = 'generate-bob@example.test'
const UNVERIFIED = 'generate-unverified@example.test'

let aliceUid: string
let bobUid: string
let aliceToken: string
let unverifiedToken: string

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

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

/** Write a message past the routes, so a generation has a transcript to read. */
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
      content: 'build a contact dashboard',
      seq: 0,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      truncated: false,
      ...overrides,
    })
}

async function storedMessages(uid: string, projectId: string): Promise<Record<string, unknown>[]> {
  const snapshot = await adminDb()
    .collection(`users/${uid}/projects/${projectId}/messages`)
    .orderBy('createdAt', 'asc')
    .orderBy('seq', 'asc')
    .get()
  return snapshot.docs.map((doc) => doc.data())
}

async function countMessages(uid: string, projectId: string): Promise<number> {
  return (await adminDb().collection(`users/${uid}/projects/${projectId}/messages`).listDocuments())
    .length
}

async function clearProjects(uid: string): Promise<void> {
  const refs = await adminDb().collection(`users/${uid}/projects`).listDocuments()
  await Promise.all(refs.map((ref) => adminDb().recursiveDelete(ref)))
}

function codeOf(body: unknown): string | undefined {
  return (body as { code?: string }).code
}

/**
 * A refusal, asserted on **both** channels.
 *
 * The content-type clause is the load-bearing one: it is what proves the
 * decision was made before a single byte of the response was committed.
 */
function expectJsonRefusal(res: GenerateResponse, status: number, code: string): void {
  expect(res.status).toBe(status)
  expect(codeOf(res.body)).toBe(code)
  expect(res.contentType).not.toContain('text/event-stream')
  expect(res.contentType).toContain('application/json')
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
  await seedProject(aliceUid, 'proj-1')
  await seedMessage(aliceUid, 'proj-1', 'msg-a')
})

describe('POST /generate — the boundary, before a byte is streamed', () => {
  /** AC-20. */
  it('refuses a request with no Authorization header, as JSON, writing nothing', async () => {
    const res = await postGenerate({ projectId: 'proj-1' })

    expectJsonRefusal(res, 401, 'unauthenticated')
    expect(await countMessages(aliceUid, 'proj-1')).toBe(1)
  })

  it('refuses a malformed Authorization header', async () => {
    const res = await postGenerate({ projectId: 'proj-1' }, { Authorization: 'Bearer not-a-token' })

    expectJsonRefusal(res, 401, 'unauthenticated')
  })

  /** AC-21. A router guard stops a browser; it does not stop a direct call. */
  it('refuses an unverified caller with 403, as JSON, writing nothing', async () => {
    const res = await postGenerate({ projectId: 'proj-1' }, auth(unverifiedToken))

    expectJsonRefusal(res, 403, 'email_unverified')
    expect(await countMessages(aliceUid, 'proj-1')).toBe(1)
  })

  /*
   * AC-22. The 404 alone would be satisfied by a handler that read bob's
   * transcript and then refused. The unchanged-documents assertion is what proves
   * it was never reachable: alice's request names
   * `users/{alice}/projects/bob-1/messages`, which does not exist.
   */
  it("answers 404 for bob's project and leaves his transcript byte-identical", async () => {
    await seedProject(bobUid, 'bob-1')
    await seedMessage(bobUid, 'bob-1', 'msg-a', { content: "Bob's prompt" })
    const before = await storedMessages(bobUid, 'bob-1')

    const res = await postGenerate({ projectId: 'bob-1' }, auth(aliceToken))

    expectJsonRefusal(res, 404, 'not_found')
    expect(await storedMessages(bobUid, 'bob-1')).toEqual(before)
  })

  /** AC-23. Soft-deleted and never-existed collapse into the one answer (D14). */
  it('answers 404 for a soft-deleted project, writing nothing', async () => {
    await seedProject(aliceUid, 'gone', { deletedAt: Timestamp.fromMillis(1_700_000_900_000) })
    await seedMessage(aliceUid, 'gone', 'msg-a')

    expectJsonRefusal(await postGenerate({ projectId: 'gone' }, auth(aliceToken)), 404, 'not_found')

    expect(await countMessages(aliceUid, 'gone')).toBe(1)
  })

  it('answers 404 for an id that never existed, writing nothing', async () => {
    const res = await postGenerate({ projectId: 'neverExisted' }, auth(aliceToken))

    expectJsonRefusal(res, 404, 'not_found')
    expect(await countMessages(aliceUid, 'neverExisted')).toBe(0)
  })

  it('answers 404 for a project document that cannot be parsed', async () => {
    await adminDb().doc(`users/${aliceUid}/projects/corrupt`).set({ description: 'no name here' })

    expectJsonRefusal(
      await postGenerate({ projectId: 'corrupt' }, auth(aliceToken)),
      404,
      'not_found',
    )
  })

  /*
   * AC-24, D2. Every one of these is refused **before any Firestore read**,
   * which is why the body parse is the first statement of the handler. `content`
   * is the one that matters: a body carrying the prompt is the shape every chat
   * tutorial uses, and accepting it would let the client's copy disagree with
   * what is stored.
   */
  it.each([
    ['an extra content key', { projectId: 'proj-1', content: 'my own prompt' }],
    ['an extra role key', { projectId: 'proj-1', role: 'assistant' }],
    ['an extra uid key', { projectId: 'proj-1', uid: 'somebody-else' }],
    ['a missing projectId', {}],
    ['a numeric projectId', { projectId: 42 }],
    ['a 65-character projectId', { projectId: 'a'.repeat(65) }],
    ['a punctuated projectId', { projectId: 'bad!id' }],
    ['a slashed projectId', { projectId: 'a/b' }],
  ])('refuses %s with 400 invalid_body, writing nothing', async (_label, body) => {
    const res = await postGenerate(body, auth(aliceToken))

    expectJsonRefusal(res, 400, 'invalid_body')
    expect(await countMessages(aliceUid, 'proj-1')).toBe(1)
  })

  /*
   * AC-10, D6, D7. Both shapes are reachable: a project whose only messages are
   * Slice 4 echoes, and a Retry on one. Dropping the trailing assistant leaves
   * nothing to send, and an empty `messages` array is a 400 from the API anyway —
   * answering it ourselves costs nothing and names the real cause.
   */
  it('answers 400 empty_context for a transcript of assistant turns only', async () => {
    await seedProject(aliceUid, 'echoes')
    await seedMessage(aliceUid, 'echoes', 'bot-a', {
      role: 'assistant',
      content: 'a reply',
      seq: 1,
    })

    const res = await postGenerate({ projectId: 'echoes' }, auth(aliceToken))

    expectJsonRefusal(res, 400, 'empty_context')
    expect((res.body as { error?: string }).error).toBe(
      'There is nothing to generate from yet. Send a message first.',
    )
    expect(await countMessages(aliceUid, 'echoes')).toBe(1)
  })

  it('answers 400 empty_context for a project with no messages at all', async () => {
    await seedProject(aliceUid, 'empty')

    expectJsonRefusal(
      await postGenerate({ projectId: 'empty' }, auth(aliceToken)),
      400,
      'empty_context',
    )
    expect(await countMessages(aliceUid, 'empty')).toBe(0)
  })
})

/** The `done` frame's payload, narrowed for assertions. */
function doneMessage(res: GenerateResponse): Record<string, unknown> {
  const frame = framesOf(res.frames, 'done')[0]
  const payload = frame?.data as { message?: Record<string, unknown> } | undefined
  if (payload?.message === undefined) throw new Error('no done frame carrying a message')
  return payload.message
}

const tokenText = (res: GenerateResponse): string =>
  framesOf(res.frames, 'token')
    .map((frame) => (frame.data as { text: string }).text)
    .join('')

describe('POST /generate — a turn that streams', () => {
  /** AC-1. The frame sequence, and the headers that make it a stream at all. */
  it('answers 200 with the streaming headers, tokens, then exactly one done', async () => {
    const res = await postGenerate({ projectId: 'proj-1' }, auth(aliceToken))

    expect(res.status).toBe(200)
    expect(res.contentType).toBe('text/event-stream; charset=utf-8')
    expect(framesOf(res.frames, 'token').length).toBeGreaterThan(0)
    expect(framesOf(res.frames, 'done')).toHaveLength(1)
    expect(framesOf(res.frames, 'error')).toHaveLength(0)
    expect(res.frames.at(-1)?.event).toBe('done')
  })

  it('sets the headers that stop an intermediary buffering the stream', async () => {
    const res = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(aliceToken) },
      body: JSON.stringify({ projectId: 'proj-1' }),
    })
    await res.text()

    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
  })

  /*
   * AC-2. The document, not merely the response: the `done` frame's message has
   * to *be* what was persisted, because the client replaces its placeholder
   * bubble with it and the next page load reads the document.
   */
  it('persists exactly one assistant message equal to the concatenated tokens', async () => {
    const res = await postGenerate({ projectId: 'proj-1' }, auth(aliceToken))

    const stored = await storedMessages(aliceUid, 'proj-1')
    expect(stored).toHaveLength(2)
    const assistant = stored[1] as Record<string, unknown>
    expect(assistant['role']).toBe('assistant')
    expect(assistant['content']).toBe(tokenText(res))
    expect(assistant['seq']).toBe(1)
    expect(assistant['truncated']).toBe(false)
  })

  it('describes that document in the done frame, in wire shape', async () => {
    const res = await postGenerate({ projectId: 'proj-1' }, auth(aliceToken))
    const message = doneMessage(res)

    const snapshot = await adminDb()
      .collection(`users/${aliceUid}/projects/proj-1/messages`)
      .where('role', '==', 'assistant')
      .get()
    const doc = snapshot.docs[0]

    expect(message['id']).toBe(doc?.id)
    expect(message['content']).toBe(doc?.get('content'))
    expect(message['createdAt']).toBe((doc?.get('createdAt') as Timestamp).toDate().toISOString())
    // The wire shape, and `seq` is still not part of it.
    expect(Object.keys(message).sort()).toEqual(['content', 'createdAt', 'id', 'role', 'truncated'])
  })

  /* AC-11 end to end: `reply.json` carries a recorded thinking delta, and it
   * must not have become a token. */
  it('forwards no thinking text as a token', async () => {
    const res = await postGenerate({ projectId: 'proj-1' }, auth(aliceToken))

    expect(tokenText(res)).not.toContain('The user wants')
    expect(tokenText(res)).toContain('Here is a contact dashboard.')
  })

  /** AC-3. The transcript, read back the way the browser reads it. */
  it('returns the user message before the assistant one, both untruncated', async () => {
    await postGenerate({ projectId: 'proj-1' }, auth(aliceToken))

    const res = await getJson(`/api/projects/proj-1/messages`, auth(aliceToken))
    const messages = (res.body as { messages: Record<string, unknown>[] }).messages

    expect(messages.map((message) => message['role'])).toEqual(['user', 'assistant'])
    expect(messages.map((message) => message['truncated'])).toEqual([false, false])
  })

  /*
   * AC-19, D28. The `__slow` fake pauses 600 ms before its first token, and the
   * suite runs with `GENERATE_TEST_KEEPALIVE_MS=250` — so a keep-alive comment
   * has to arrive first. Without it an intermediary that closes an idle
   * connection would kill the request during the model's most productive moment.
   */
  it('writes a comment frame before the first token on a slow generation', async () => {
    await seedProject(aliceUid, 'slow')
    await seedMessage(aliceUid, 'slow', 'msg-a', { content: '__slow build a contact dashboard' })

    const res = await postGenerate({ projectId: 'slow' }, auth(aliceToken))

    const firstToken = res.frames.findIndex((frame) => frame.event === 'token')
    const comments = res.frames.filter((frame) => frame.comment !== null)
    expect(comments.length).toBeGreaterThan(0)
    expect(res.frames.findIndex((frame) => frame.comment !== null)).toBeLessThan(firstToken)
    // More than the one written at the flush: the interval really is ticking.
    expect(comments.length).toBeGreaterThan(1)
  })

  /*
   * The whole two-request turn, twice — D3 executed. The second prompt goes
   * through the real `POST` route rather than being seeded, so the commit
   * timestamps are Firestore's own and the ordering is the one a browser sees.
   *
   * It is also R1 end to end: the second `/generate` reads a transcript that
   * ends `user → assistant → user`, and the first `/generate` read one ending
   * `user`. A trailing assistant would be a prefill and a 400; neither call is.
   */
  it('answers a second turn, so the transcript grows rather than being replaced', async () => {
    await postGenerate({ projectId: 'proj-1' }, auth(aliceToken))
    expect(
      (
        await postJson(
          '/api/projects/proj-1/messages',
          { content: 'and add a search box' },
          auth(aliceToken),
        )
      ).status,
    ).toBe(201)

    const second = await postGenerate({ projectId: 'proj-1' }, auth(aliceToken))

    expect(second.status).toBe(200)
    expect(framesOf(second.frames, 'done')).toHaveLength(1)
    const stored = await storedMessages(aliceUid, 'proj-1')
    expect(stored.map((doc) => doc['role'])).toEqual(['user', 'assistant', 'user', 'assistant'])
  })
})
