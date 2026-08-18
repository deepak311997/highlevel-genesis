import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminDb,
  framesOf,
  GENERATE_URL,
  getJson,
  idTokenFor,
  postGenerate,
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
 *
 * **From Slice 6 `reply.json` also streams three file blocks** (D26, R8). Its
 * prose is byte-identical, and every assertion below is about that prose or about
 * the frame protocol, so none of them changed — but the cases here now exercise
 * the file path too, which is the point. What the files themselves do is
 * `generate-files.spec.ts`.
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
    const res = await postGenerate({ projectId: 'proj-1', retry: true })

    expectJsonRefusal(res, 401, 'unauthenticated')
    expect(await countMessages(aliceUid, 'proj-1')).toBe(1)
  })

  it('refuses a malformed Authorization header', async () => {
    const res = await postGenerate(
      { projectId: 'proj-1', retry: true },
      { Authorization: 'Bearer not-a-token' },
    )

    expectJsonRefusal(res, 401, 'unauthenticated')
  })

  /** AC-21. A router guard stops a browser; it does not stop a direct call. */
  it('refuses an unverified caller with 403, as JSON, writing nothing', async () => {
    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(unverifiedToken))

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

    const res = await postGenerate({ projectId: 'bob-1', retry: true }, auth(aliceToken))

    expectJsonRefusal(res, 404, 'not_found')
    expect(await storedMessages(bobUid, 'bob-1')).toEqual(before)
  })

  /** AC-23. Soft-deleted and never-existed collapse into the one answer (D14). */
  it('answers 404 for a soft-deleted project, writing nothing', async () => {
    await seedProject(aliceUid, 'gone', { deletedAt: Timestamp.fromMillis(1_700_000_900_000) })
    await seedMessage(aliceUid, 'gone', 'msg-a')

    expectJsonRefusal(
      await postGenerate({ projectId: 'gone', retry: true }, auth(aliceToken)),
      404,
      'not_found',
    )

    expect(await countMessages(aliceUid, 'gone')).toBe(1)
  })

  it('answers 404 for an id that never existed, writing nothing', async () => {
    const res = await postGenerate({ projectId: 'neverExisted', retry: true }, auth(aliceToken))

    expectJsonRefusal(res, 404, 'not_found')
    expect(await countMessages(aliceUid, 'neverExisted')).toBe(0)
  })

  it('answers 404 for a project document that cannot be parsed', async () => {
    await adminDb().doc(`users/${aliceUid}/projects/corrupt`).set({ description: 'no name here' })

    expectJsonRefusal(
      await postGenerate({ projectId: 'corrupt', retry: true }, auth(aliceToken)),
      404,
      'not_found',
    )
  })

  /*
   * AC-24. Every one of these is refused **before any Firestore read**, which is
   * why the body parse is the first statement of the handler.
   *
   * `content` is a real field now — a turn is one request, and the prompt
   * travels in it — so what the table guards has moved rather than gone. The
   * load-bearing pair is the first two: a body carrying **both** `content` and
   * `retry` is a caller that has not decided what it wants, and a body carrying
   * **neither** would silently generate a second reply to whatever the
   * transcript happens to end with. The refine says exactly one; this is the
   * proof it is enforced at the boundary rather than in the handler.
   */
  it.each([
    ['both content and retry', { projectId: 'proj-1', content: 'a prompt', retry: true }],
    ['neither content nor retry', { projectId: 'proj-1' }],
    ['retry: false', { projectId: 'proj-1', retry: false }],
    ['an empty content', { projectId: 'proj-1', content: '   ' }],
    ['a content past the cap', { projectId: 'proj-1', content: 'a'.repeat(4001) }],
    ['a numeric content', { projectId: 'proj-1', content: 42 }],
    ['an extra role key', { projectId: 'proj-1', retry: true, role: 'assistant' }],
    ['an extra uid key', { projectId: 'proj-1', retry: true, uid: 'somebody-else' }],
    ['a missing projectId', {}],
    ['a numeric projectId', { projectId: 42, retry: true }],
    ['a 65-character projectId', { projectId: 'a'.repeat(65), retry: true }],
    ['a punctuated projectId', { projectId: 'bad!id', retry: true }],
    ['a slashed projectId', { projectId: 'a/b', retry: true }],
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

    const res = await postGenerate({ projectId: 'echoes', retry: true }, auth(aliceToken))

    expectJsonRefusal(res, 400, 'empty_context')
    expect((res.body as { error?: string }).error).toBe(
      'There is nothing to generate from yet. Send a message first.',
    )
    expect(await countMessages(aliceUid, 'echoes')).toBe(1)
  })

  /*
   * The 200-message cap, on the endpoint that also writes into the collection.
   *
   * `POST /api/projects/:projectId/messages` refuses at 199 so the reply it is
   * about to trigger has room — but `/generate` writes an assistant message
   * without going through that route, and **Retry re-opens it with no new user
   * message at all** (D26). Unchecked, a transcript at the cap grows past it once
   * per Retry, and `transcriptQuery`'s own `limit(200)` then hides every document
   * beyond the two-hundredth: the reply arrives on screen and is gone on the next
   * load. D34 leans on this cap to bound a project's spend absolutely, which only
   * holds if the endpoint that spends the money honours it.
   *
   * Asserted through `expectJsonRefusal` like every other pre-flush refusal: a
   * status alone would not notice a handler that opened the stream first.
   */
  it('answers 409 message_limit for a transcript at the cap, writing nothing', async () => {
    await seedProject(aliceUid, 'full')
    const batch = adminDb().batch()
    for (let index = 0; index < 200; index += 1) {
      batch.set(adminDb().doc(`users/${aliceUid}/projects/full/messages/m${String(index)}`), {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${String(index)}`,
        seq: index % 2,
        createdAt: Timestamp.fromMillis(1_700_000_000_000 + index * 1000),
        truncated: false,
      })
    }
    await batch.commit()

    const res = await postGenerate({ projectId: 'full', retry: true }, auth(aliceToken))

    expectJsonRefusal(res, 409, 'message_limit')
    expect((res.body as { error?: string }).error).toBe(
      'This project has reached its limit of 200 messages.',
    )
    // Not one document more: the collection is exactly what was seeded.
    expect(await countMessages(aliceUid, 'full')).toBe(200)
  })

  it('answers 400 empty_context for a project with no messages at all', async () => {
    await seedProject(aliceUid, 'empty')

    expectJsonRefusal(
      await postGenerate({ projectId: 'empty', retry: true }, auth(aliceToken)),
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
    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

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
      body: JSON.stringify({ projectId: 'proj-1', retry: true }),
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
    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    const stored = await storedMessages(aliceUid, 'proj-1')
    expect(stored).toHaveLength(2)
    const assistant = stored[1] as Record<string, unknown>
    expect(assistant['role']).toBe('assistant')
    expect(assistant['content']).toBe(tokenText(res))
    expect(assistant['seq']).toBe(1)
    expect(assistant['truncated']).toBe(false)
  })

  it('describes that document in the done frame, in wire shape', async () => {
    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))
    const message = doneMessage(res)

    const snapshot = await adminDb()
      .collection(`users/${aliceUid}/projects/proj-1/messages`)
      .where('role', '==', 'assistant')
      .get()
    const doc = snapshot.docs[0]

    expect(message['id']).toBe(doc?.id)
    expect(message['content']).toBe(doc?.get('content'))
    expect(message['createdAt']).toBe((doc?.get('createdAt') as Timestamp).toDate().toISOString())
    // The wire shape, and `seq` is still not part of it. `error` is: a turn
    // that failed has to be able to say so on the next page load.
    expect(Object.keys(message).sort()).toEqual([
      'content',
      'createdAt',
      'error',
      'id',
      'role',
      'truncated',
    ])
  })

  /* AC-11 end to end: `reply.json` carries a recorded thinking delta, and it
   * must not have become a token. */
  it('forwards no thinking text as a token', async () => {
    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    expect(tokenText(res)).not.toContain('The user wants')
    expect(tokenText(res)).toContain('Here is a contact dashboard.')
  })

  /** AC-3. The transcript, read back the way the browser reads it. */
  it('returns the user message before the assistant one, both untruncated', async () => {
    await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

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

    const res = await postGenerate({ projectId: 'slow', retry: true }, auth(aliceToken))

    const firstToken = res.frames.findIndex((frame) => frame.event === 'token')
    const comments = res.frames.filter((frame) => frame.comment !== null)
    expect(comments.length).toBeGreaterThan(0)
    expect(res.frames.findIndex((frame) => frame.comment !== null)).toBeLessThan(firstToken)
    // More than the one written at the flush: the interval really is ticking.
    expect(comments.length).toBeGreaterThan(1)
  })

  /*
   * Two whole turns, and the second one carries its own prompt — which is now
   * all a turn is. The prompt used to go through `POST /api/projects/:id/
   * messages` before a second request opened the stream; that route is gone,
   * and with it the window where a client could die between the two.
   *
   * It is also R1 end to end: the second `/generate` reads a transcript that
   * ends `user → assistant` and appends its own prompt to it, so what reaches
   * the model ends `user`. A trailing assistant would be a prefill and a 400;
   * neither call is.
   */
  it('answers a second turn, so the transcript grows rather than being replaced', async () => {
    await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    const second = await postGenerate(
      { projectId: 'proj-1', content: 'and add a search box' },
      auth(aliceToken),
    )

    expect(second.status).toBe(200)
    expect(framesOf(second.frames, 'done')).toHaveLength(1)
    const stored = await storedMessages(aliceUid, 'proj-1')
    expect(stored.map((doc) => doc['role'])).toEqual(['user', 'assistant', 'user', 'assistant'])
  })
})

/** The `error` frame's payload, narrowed for assertions. */
function errorPayload(res: GenerateResponse): {
  error: string
  code: string
  message: Record<string, unknown> | null
} {
  const frame = framesOf(res.frames, 'error')[0]
  if (frame === undefined) throw new Error('no error frame')
  return frame.data as { error: string; code: string; message: Record<string, unknown> | null }
}

async function assistantMessages(
  uid: string,
  projectId: string,
): Promise<Record<string, unknown>[]> {
  return (await storedMessages(uid, projectId)).filter((doc) => doc['role'] === 'assistant')
}

describe('POST /generate — failure, mid-stream', () => {
  /*
   * AC-12. The partial is the whole point (F8.2): a user who watched two
   * sentences arrive must come back to those two sentences, not to a prompt with
   * no answer. And the `error` frame carries the persisted document, so success
   * and interruption are **one** client code path (D9) — whatever arrives, the
   * placeholder is replaced by what the server actually stored.
   */
  it('answers tokens then one upstream error, persisting the partial as truncated', async () => {
    await seedMessage(aliceUid, 'proj-1', 'msg-a', {
      content: '__fail_midstream build a contact dashboard',
    })

    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    expect(res.status).toBe(200)
    expect(framesOf(res.frames, 'token')).toHaveLength(2)
    expect(framesOf(res.frames, 'error')).toHaveLength(1)
    expect(framesOf(res.frames, 'done')).toHaveLength(0)
    expect(res.frames.at(-1)?.event).toBe('error')

    const payload = errorPayload(res)
    expect(payload.code).toBe('upstream')

    const stored = await assistantMessages(aliceUid, 'proj-1')
    expect(stored).toHaveLength(1)
    expect(stored[0]?.['content']).toBe(tokenText(res))
    expect(stored[0]?.['truncated']).toBe(true)
    expect(payload.message?.['content']).toBe(stored[0]?.['content'])
    expect(payload.message?.['truncated']).toBe(true)
  })

  /**
   * AC-13, **rewritten by "a failure survives a refresh"**.
   *
   * It used to say that a generation producing no prose wrote nothing at all —
   * and that was the bug: the only trace of the failure was an in-memory flag,
   * so a reload showed a transcript that had silently swallowed the turn. A
   * failed turn now stores an assistant document with no prose and the reason
   * there is none, and the `error` frame carries that document so the client
   * replaces its placeholder with what was actually written.
   */
  it('persists the failure itself when the generation fails upfront', async () => {
    await seedMessage(aliceUid, 'proj-1', 'msg-a', { content: '__fail_upfront build a dashboard' })

    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    expect(res.status).toBe(200)
    expect(framesOf(res.frames, 'token')).toHaveLength(0)
    expect(framesOf(res.frames, 'error')).toHaveLength(1)
    expect(errorPayload(res).code).toBe('upstream')

    const stored = await assistantMessages(aliceUid, 'proj-1')
    expect(stored).toHaveLength(1)
    expect(stored[0]?.['content']).toBe('')
    expect(stored[0]?.['error']).toBe('upstream')
    // The frame is the document, so success and failure are one client path.
    expect(errorPayload(res).message?.['id']).toBeDefined()
    expect(errorPayload(res).message?.['error']).toBe('upstream')
  })

  /*
   * AC-14, D18. A refusal is HTTP 200 with `stop_reason: 'refusal'` and no
   * content, so a handler reading `content[0]` would break on exactly the case it
   * exists to report. Nothing is persisted, because there is nothing to persist.
   */
  it('answers one refused error and writes nothing when the model declines', async () => {
    await seedMessage(aliceUid, 'proj-1', 'msg-a', { content: '__refuse do something dubious' })

    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    expect(res.status).toBe(200)
    expect(framesOf(res.frames, 'error')).toHaveLength(1)
    expect(errorPayload(res).code).toBe('refused')
    expect(errorPayload(res).error).toBe('Claude declined to answer that. Try rephrasing.')

    // Nothing was said, and the reason it was not said is what gets stored.
    const stored = await assistantMessages(aliceUid, 'proj-1')
    expect(stored).toHaveLength(1)
    expect(stored[0]?.['content']).toBe('')
    expect(stored[0]?.['error']).toBe('refused')
  })

  /*
   * AC-15, D23. `max_tokens` is a real, useful, incomplete answer — `done`, not
   * an error, so no Retry is offered for something that did not fail and the text
   * that did arrive is not hidden behind an error state.
   */
  it('ends with done and truncated true when the model hits max_tokens', async () => {
    await seedMessage(aliceUid, 'proj-1', 'msg-a', { content: '__max_tokens write me an epic' })

    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    expect(framesOf(res.frames, 'done')).toHaveLength(1)
    expect(framesOf(res.frames, 'error')).toHaveLength(0)
    expect(doneMessage(res)['truncated']).toBe(true)
    expect((await assistantMessages(aliceUid, 'proj-1'))[0]?.['truncated']).toBe(true)
  })

  /*
   * AC-16, D22. The cap converts the worst available failure — a generation that
   * succeeded, streamed perfectly, and then failed at the Firestore write — into
   * a truncated-but-saved reply.
   */
  it('caps a runaway generation, ending in done with a stored reply under the limit', async () => {
    await seedMessage(aliceUid, 'proj-1', 'msg-a', { content: '__long write me everything' })

    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    expect(framesOf(res.frames, 'done')).toHaveLength(1)
    const stored = (await assistantMessages(aliceUid, 'proj-1'))[0]
    expect(stored?.['truncated']).toBe(true)
    const content = String(stored?.['content'])
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(800_000)
    // And the cap really bit, rather than the fixture happening to be short.
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(400_000)
    // What the client saw is byte-identical to what was stored.
    expect(content).toBe(tokenText(res))
  })
})

/*
 * **AC-17 and AC-18 are not here, and that is a finding rather than a gap.**
 *
 * The client disconnect cannot be observed through the functions emulator. This
 * was measured, not assumed: instrumenting `req.on('close')`, `req.on('aborted')`,
 * `res.on('aborted')` and `res.on('close')`, then aborting a real `fetch` two
 * tokens into a `__slow` stream, produces no `req` event at all, no `aborted`
 * event at all, the generation running to completion (`stopReason: 'end_turn'`,
 * `durationMs: 1213`), and `res close` arriving only afterwards with
 * `writableEnded: true`. The emulator terminates the client connection at its own
 * proxy and never propagates it to the function runtime.
 *
 * So the half we own — given the signal, abort the stream, persist the partial
 * marked `truncated`, and write nothing to the dead socket — is driven at L1 in
 * `functions/src/generate.spec.ts`, where the signal can be delivered. The half
 * the platform owns is a Slice 13 hand-check against the deploy, beside R2's.
 *
 * A test that cannot fail for the right reason is worse than no test, because
 * `it('persists the partial')` reads as proof either way.
 */

describe('POST /generate — a transcript ending in an assistant turn', () => {
  /*
   * **R1, end to end.** A trailing assistant message is an assistant prefill, and
   * prefill is a 400 on `claude-opus-5` — so untreated, this is the shape that
   * breaks Retry after an interruption, every single time, on the one path that
   * is supposed to work when something has already gone wrong.
   *
   * The transcript is seeded past the routes into exactly the shape an
   * interrupted turn leaves behind, and then generated from.
   */
  it('drops the trailing assistant turn and streams normally', async () => {
    await seedMessage(aliceUid, 'proj-1', 'bot-a', {
      role: 'assistant',
      content: 'Here is a cont',
      seq: 1,
      createdAt: Timestamp.fromMillis(1_700_000_100_000),
      truncated: true,
    })

    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    expect(res.status).toBe(200)
    expect(framesOf(res.frames, 'done')).toHaveLength(1)
    expect(framesOf(res.frames, 'error')).toHaveLength(0)
    // The interrupted reply is still there — D26's append-only rule under
    // pressure — and the new one is beside it.
    const stored = await assistantMessages(aliceUid, 'proj-1')
    expect(stored).toHaveLength(2)
    expect(stored.map((doc) => doc['truncated'])).toEqual([true, false])
  })

  /* Three in a row, which two interruptions and a Retry produce. */
  it('drops several trailing assistant turns', async () => {
    for (const [index, id] of ['bot-a', 'bot-b', 'bot-c'].entries()) {
      await seedMessage(aliceUid, 'proj-1', id, {
        role: 'assistant',
        content: `partial ${String(index)}`,
        seq: 1,
        createdAt: Timestamp.fromMillis(1_700_000_100_000 + index * 1000),
        truncated: true,
      })
    }

    const res = await postGenerate({ projectId: 'proj-1', retry: true }, auth(aliceToken))

    expect(res.status).toBe(200)
    expect(framesOf(res.frames, 'done')).toHaveLength(1)
  })
})

/** The `user` frame's payload — the prompt as stored, echoed before the tokens. */
function userMessage(res: GenerateResponse): Record<string, unknown> {
  const frame = framesOf(res.frames, 'user')[0]
  const payload = frame?.data as { message?: Record<string, unknown> } | undefined
  if (payload?.message === undefined) throw new Error('no user frame carrying a message')
  return payload.message
}

/**
 * The prompt travels with the turn — one request, and this is what it buys.
 *
 * A turn used to take two requests: `POST /api/projects/:id/messages` wrote the
 * prompt, then `POST /generate` streamed the reply. The property that split was
 * protecting is that the prompt is durable before the expensive half starts, and
 * it is preserved here by *ordering inside the handler* rather than by a round
 * trip — so the guarantees the message route used to carry are asserted against
 * `/generate` now, because that is where they live.
 *
 * The window the old shape had is what is really being closed: a client that
 * died between the two requests left a transcript ending on a prompt no reply
 * was ever coming for, with nothing on screen to say so. There is no "between"
 * any more.
 */
describe('POST /generate — the prompt travels with the turn', () => {
  /* The project seeded by `beforeEach` already holds one message, so these cases
     use projects of their own where the count is the assertion. */
  it('writes the prompt as seq 0 and echoes the stored document before the tokens', async () => {
    await seedProject(aliceUid, 'fresh')

    const res = await postGenerate(
      { projectId: 'fresh', content: 'build a contact dashboard' },
      auth(aliceToken),
    )

    expect(res.status).toBe(200)
    const stored = await storedMessages(aliceUid, 'fresh')
    expect(stored.map((doc) => doc['role'])).toEqual(['user', 'assistant'])
    expect(stored[0]?.['seq']).toBe(0)
    expect(stored[0]?.['content']).toBe('build a contact dashboard')

    /*
     * The echo is not decoration: without it the browser would have to invent an
     * id and a timestamp for the bubble it drew optimistically, and be wrong
     * about both until the next refetch.
     */
    const echoed = userMessage(res)
    expect(echoed['content']).toBe('build a contact dashboard')
    expect(echoed['role']).toBe('user')
    expect(Object.keys(echoed).sort()).toEqual([
      'content',
      'createdAt',
      'error',
      'id',
      'role',
      'truncated',
    ])
    // Before a single token, or the bubble is replaced after the reply lands.
    expect(res.frames.findIndex((frame) => frame.event === 'user')).toBeLessThan(
      res.frames.findIndex((frame) => frame.event === 'token'),
    )
  })

  /* Trimmed on the way in, so a prompt is never stored with the whitespace a
     text area left on it — the same rule the message route enforced. */
  it('trims the prompt', async () => {
    await seedProject(aliceUid, 'trimmed')

    await postGenerate(
      { projectId: 'trimmed', content: '  build a contact dashboard  ' },
      auth(aliceToken),
    )

    expect((await storedMessages(aliceUid, 'trimmed'))[0]?.['content']).toBe(
      'build a contact dashboard',
    )
  })

  /**
   * The ordering, asserted where it matters: **the prompt survives a generation
   * that never produced a byte.**
   *
   * This is the case the two-request shape existed for. Written after the
   * upstream call instead, a failed generation would lose the prompt as well as
   * the reply, and the user would be looking at a transcript that had silently
   * dropped what they typed.
   */
  it('keeps the prompt when the generation fails before its first token', async () => {
    await seedProject(aliceUid, 'doomed')

    const res = await postGenerate(
      { projectId: 'doomed', content: '__fail_upfront build a dashboard' },
      auth(aliceToken),
    )

    expect(framesOf(res.frames, 'error')).toHaveLength(1)
    const stored = await storedMessages(aliceUid, 'doomed')
    // The prompt, and beside it the assistant document that says why no reply
    // came — both of which a reload has to be able to read back.
    expect(stored.map((doc) => doc['role'])).toEqual(['user', 'assistant'])
    expect(stored[0]?.['content']).toBe('__fail_upfront build a dashboard')
    expect(stored[1]?.['content']).toBe('')
    expect(stored[1]?.['error']).toBe('upstream')
  })

  /**
   * The cap, and **a new turn needs room for two documents where a retry needs
   * one**.
   *
   * Refusing a new turn at 199 is what stops a transcript ending on a prompt
   * with nowhere to put its answer. Refusing a retry only at 200 is the other
   * half: a retry writes no prompt, so a transcript with one slot left has room
   * for exactly the reply it is asking for.
   */
  async function seedTranscript(projectId: string, count: number): Promise<void> {
    await seedProject(aliceUid, projectId)
    const batch = adminDb().batch()
    for (let index = 0; index < count; index += 1) {
      batch.set(
        adminDb().doc(`users/${aliceUid}/projects/${projectId}/messages/m${String(index)}`),
        {
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `message ${String(index)}`,
          seq: index % 2,
          createdAt: Timestamp.fromMillis(1_700_000_000_000 + index * 1000),
          truncated: false,
        },
      )
    }
    await batch.commit()
  }

  it('refuses a new turn at 199, where only one of the pair would fit', async () => {
    await seedTranscript('at199', 199)

    const res = await postGenerate({ projectId: 'at199', content: 'one more' }, auth(aliceToken))

    expectJsonRefusal(res, 409, 'message_limit')
    expect(await countMessages(aliceUid, 'at199')).toBe(199)
  })

  it('accepts a new turn at 198, leaving exactly one slot for the reply', async () => {
    await seedTranscript('at198', 198)

    const res = await postGenerate({ projectId: 'at198', content: 'one more' }, auth(aliceToken))

    expect(res.status).toBe(200)
    expect(framesOf(res.frames, 'done')).toHaveLength(1)
    expect(await countMessages(aliceUid, 'at198')).toBe(200)
  })

  /* A retry writes no prompt, so the last slot is the reply's. */
  it('accepts a retry at 199 and refuses one at 200', async () => {
    await seedTranscript('retry199', 199)
    const accepted = await postGenerate({ projectId: 'retry199', retry: true }, auth(aliceToken))

    expect(accepted.status).toBe(200)
    expect(await countMessages(aliceUid, 'retry199')).toBe(200)

    await seedTranscript('retry200', 200)
    expectJsonRefusal(
      await postGenerate({ projectId: 'retry200', retry: true }, auth(aliceToken)),
      409,
      'message_limit',
    )
    expect(await countMessages(aliceUid, 'retry200')).toBe(200)
  })

  /* The project document is not the transcript: a turn touches neither its name
     nor its timestamps. */
  it('leaves the project document byte-identical', async () => {
    await seedProject(aliceUid, 'untouched')
    const before = (await adminDb().doc(`users/${aliceUid}/projects/untouched`).get()).data()

    await postGenerate(
      { projectId: 'untouched', content: 'build a contact dashboard' },
      auth(aliceToken),
    )

    expect((await adminDb().doc(`users/${aliceUid}/projects/untouched`).get()).data()).toEqual(
      before,
    )
  })
})
