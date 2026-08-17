import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adminDb, framesOf, idTokenFor, postGenerate, resetEmulators, seedUser } from './helpers'

/**
 * What the model was actually **shown** — AC-27, over the wire.
 *
 * This is the only level at which the slice's central wiring is observable at
 * all. `handleGenerate` reads the project's files, `buildParams` turns them into
 * a system block, and the block goes out after the `cache_control` breakpoint;
 * each of those three is unit-tested on its own, and all three could be correct
 * while the handler never called any of them. Every other test in this repository
 * would still pass.
 *
 * So the emulator-only fake answers the `__context` marker with a report of its
 * own input — how many system blocks it received, how many messages, and which
 * paths it was shown (D25). The report travels back as an ordinary `token` frame
 * through a real SSE response, so what is asserted here is the request that a
 * real generation would have sent.
 *
 * **The block count is written out rather than imported.** These tests run
 * against the *built* functions bundle and deliberately share no module with it;
 * the relationship between the counts is `params.spec.ts`'s business, and what
 * this file owns is the number that actually went over the wire. If the stable
 * prefix ever gains a block, this file should be edited deliberately.
 */

/** The stable prefix: identity, file format, HighLevel cheat-sheet. */
const STABLE_BLOCKS = 3

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'gencontext-alice@example.test'

let aliceUid: string
let aliceToken: string

const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })

async function seedProject(uid: string, id: string): Promise<void> {
  await adminDb()
    .doc(`users/${uid}/projects/${id}`)
    .set({
      name: `Project ${id}`,
      description: null,
      locationId: null,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      deletedAt: null,
    })
}

/** Write a prompt past the routes, so a generation has a transcript to read. */
async function seedPrompt(uid: string, projectId: string, content: string): Promise<void> {
  await adminDb()
    .doc(`users/${uid}/projects/${projectId}/messages/msg-a`)
    .set({
      role: 'user',
      content,
      seq: 0,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      truncated: false,
    })
}

/**
 * A file document, written directly so a **corrupt** one can be written too.
 *
 * `id` and `path` are separate parameters for exactly that reason: the routes
 * cannot produce a document where they disagree, and that is the shape the last
 * case here needs.
 */
async function seedFile(
  uid: string,
  projectId: string,
  id: string,
  path: string,
  content: string,
): Promise<void> {
  await adminDb()
    .doc(`users/${uid}/projects/${projectId}/files/${id}`)
    .set({
      path,
      content,
      size: Buffer.byteLength(content, 'utf8'),
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
    })
}

interface ContextReport {
  systemBlocks: number
  messages: number
  paths: string[]
}

/** Run one `__context` turn in its own project and read the fake's report. */
async function contextOf(projectId: string): Promise<ContextReport> {
  await seedPrompt(aliceUid, projectId, '__context build a contact dashboard')

  const res = await postGenerate({ projectId }, auth(aliceToken))
  expect(res.status).toBe(200)
  expect(res.contentType).toContain('text/event-stream')

  const text = framesOf(res.frames, 'token')
    .map((frame) => (frame.data as { text: string }).text)
    .join('')

  return JSON.parse(text) as ContextReport
}

beforeAll(async () => {
  await resetEmulators()
  aliceUid = await seedUser(ALICE, PASSWORD, true)
  aliceToken = await idTokenFor(ALICE, PASSWORD)
})

beforeEach(async () => {
  const refs = await adminDb().collection(`users/${aliceUid}/projects`).listDocuments()
  await Promise.all(refs.map((ref) => adminDb().recursiveDelete(ref)))
})

describe('the project’s files reach the request (AC-27)', () => {
  it('sends one extra system block naming every file the project holds', async () => {
    await seedProject(aliceUid, 'three')
    await seedFile(aliceUid, 'three', 'index.html', 'index.html', '<!doctype html>\n')
    await seedFile(aliceUid, 'three', 'app.js', 'app.js', 'const a = 1\n')
    await seedFile(aliceUid, 'three', 'styles.css', 'styles.css', 'body { margin: 0 }\n')

    const report = await contextOf('three')

    expect(report.systemBlocks).toBe(STABLE_BLOCKS + 1)
    // `index.html` first, then ascending size — the builder's order (D14), not
    // Firestore's `orderBy('path')`.
    expect(report.paths).toEqual(['index.html', 'app.js', 'styles.css'])
  })

  /*
   * AC-13 over the wire. A project with no files appends no block at all, so the
   * request is byte-identical in shape to the one Slice 5 sent — which is what
   * keeps the cached prefix a single array the process can reuse.
   */
  it('sends the stable prefix alone for a project holding no files', async () => {
    await seedProject(aliceUid, 'empty')

    const report = await contextOf('empty')

    expect(report.systemBlocks).toBe(STABLE_BLOCKS)
    expect(report.paths).toEqual([])
  })

  /*
   * The neighbouring real behaviour the plan moved AC-28's L4 slot to: **a
   * corrupt file document does not break a generation.**
   *
   * A document whose id and `path` disagree cannot be shown in the right row of a
   * tree or answered for the right `GET`, so it is known to be unusable (Slice 6
   * D13) — and the question that matters here is what a *generation* does with
   * one. It is skipped and logged, the turn completes, and the other two files
   * still reach the model. The alternative, which is what an unguarded parse
   * would give, is a project that can never generate again because of one bad
   * document.
   */
  it('completes the generation and omits a file document whose id and path disagree', async () => {
    await seedProject(aliceUid, 'corrupt')
    await seedFile(aliceUid, 'corrupt', 'index.html', 'index.html', '<!doctype html>\n')
    await seedFile(aliceUid, 'corrupt', 'app.js', 'app.js', 'const a = 1\n')
    // Filed under one name, claiming another. Only a direct write can make it.
    await seedFile(aliceUid, 'corrupt', 'ghost.js', 'other.js', 'const b = 2\n')

    const report = await contextOf('corrupt')

    expect(report.paths).toEqual(['index.html', 'app.js'])
    expect(report.paths).not.toContain('ghost.js')
    expect(report.paths).not.toContain('other.js')
    expect(report.systemBlocks).toBe(STABLE_BLOCKS + 1)
  })

  /*
   * The transcript half of the same report. `buildContext` drops trailing
   * assistant turns before anything else runs (Slice 5 D6), so what the model is
   * sent is the one user turn — not the two documents the collection holds.
   */
  it('sends the trimmed transcript, not the stored one', async () => {
    await seedProject(aliceUid, 'transcript')
    await adminDb()
      .doc(`users/${aliceUid}/projects/transcript/messages/msg-b`)
      .set({
        role: 'assistant',
        content: 'an interrupted reply',
        seq: 1,
        createdAt: Timestamp.fromMillis(1_700_000_100_000),
        truncated: true,
      })

    const report = await contextOf('transcript')

    expect(report.messages).toBe(1)
  })
})
