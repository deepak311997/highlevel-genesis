import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminDb,
  framesOf,
  idTokenFor,
  postGenerate,
  resetEmulators,
  seedUser,
  type GenerateResponse,
} from './helpers'

/**
 * `POST /generate` — the **file** half, over the wire (AC-16 to AC-25).
 *
 * The all-or-nothing rule is only provable end to end. An L1 test of `planFileWrites` asserts
 * *intent*; what F8.1 needs is the assertion that **no document exists** — which is why every
 * refusal case below reads the collection back rather than reading a return value.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'genfiles-alice@example.test'

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

interface StoredFileDoc {
  id: string
  path: string
  content: string
  size: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

async function storedFiles(uid: string, projectId: string): Promise<StoredFileDoc[]> {
  const snapshot = await adminDb()
    .collection(`users/${uid}/projects/${projectId}/files`)
    .orderBy('path')
    .get()

  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<StoredFileDoc, 'id'>) }))
}

async function assistantContent(uid: string, projectId: string): Promise<string[]> {
  const snapshot = await adminDb()
    .collection(`users/${uid}/projects/${projectId}/messages`)
    .where('role', '==', 'assistant')
    .get()
  return snapshot.docs.map((doc) => String(doc.get('content')))
}

async function clearProjects(uid: string): Promise<void> {
  const refs = await adminDb().collection(`users/${uid}/projects`).listDocuments()
  await Promise.all(refs.map((ref) => adminDb().recursiveDelete(ref)))
}

/** The `done` frame's payload, narrowed for assertions. */
function donePayload(res: GenerateResponse): {
  message: Record<string, unknown>
  files: string[]
  fileError: string | null
} {
  const frame = framesOf(res.frames, 'done')[0]
  if (frame === undefined) throw new Error('no done frame')
  return frame.data as {
    message: Record<string, unknown>
    files: string[]
    fileError: string | null
  }
}

const tokenText = (res: GenerateResponse): string =>
  framesOf(res.frames, 'token')
    .map((frame) => (frame.data as { text: string }).text)
    .join('')

const chunkText = (res: GenerateResponse, path: string): string =>
  framesOf(res.frames, 'file_chunk')
    .map((frame) => frame.data as { path: string; text: string })
    .filter((payload) => payload.path === path)
    .map((payload) => payload.text)
    .join('')

/**
 * Run one turn for `prompt`, in its own project.
 *
 * The prompt travels in the body: a turn is one request now, and the handler
 * writes the user message itself before it opens the stream. Seeding the
 * transcript first and then asking for a generation would exercise the retry
 * path instead, which is not what any case in this file is about.
 */
async function generate(projectId: string, prompt: string): Promise<GenerateResponse> {
  await seedProject(aliceUid, projectId)
  return postGenerate({ projectId, content: prompt }, auth(aliceToken))
}

beforeAll(async () => {
  await resetEmulators()
  aliceUid = await seedUser(ALICE, PASSWORD, true)
  aliceToken = await idTokenFor(ALICE, PASSWORD)
})

beforeEach(async () => {
  await clearProjects(aliceUid)
})

describe('a completed generation that writes three files', () => {
  /** AC-16. The documents, not merely the frames. */
  it('stores one document per file, at an id equal to its path', async () => {
    const res = await generate('happy', 'build a contact dashboard')

    const files = await storedFiles(aliceUid, 'happy')
    expect(files.map((file) => file.id)).toEqual(['app.js', 'index.html', 'styles.css'])
    expect(files.map((file) => file.path)).toEqual(files.map((file) => file.id))
    expect(framesOf(res.frames, 'done')).toHaveLength(1)
  })

  it('stores the repaired body, with a size equal to its UTF-8 byte length', async () => {
    await generate('happy', 'build a contact dashboard')

    for (const file of await storedFiles(aliceUid, 'happy')) {
      expect(file.size).toBe(Buffer.byteLength(file.content, 'utf8'))
      // D16: exactly one trailing newline, and no tag survived into the content.
      expect(file.content.endsWith('\n')).toBe(true)
      expect(file.content.endsWith('\n\n')).toBe(false)
      expect(file.content).not.toContain('genesis:file')
    }
  })

  it('carries the three sorted paths in done, with no fileError', async () => {
    const res = await generate('happy', 'build a contact dashboard')

    expect(donePayload(res).files).toEqual(['app.js', 'index.html', 'styles.css'])
    expect(donePayload(res).fileError).toBeNull()
  })

  /** AC-17. The transcript carries the markers and none of the code. */
  it('persists a message of prose and one marker per file, equal to the tokens', async () => {
    const res = await generate('happy', 'build a contact dashboard')

    const [content] = await assistantContent(aliceUid, 'happy')
    expect(content).toBe(tokenText(res))
    for (const path of ['index.html', 'styles.css', 'app.js']) {
      expect(content).toContain(`[file: ${path}]`)
    }
    for (const needle of ['<!doctype', 'genesis:file', 'document.getElementById']) {
      expect(content).not.toContain(needle)
    }
  })

  /** AC-25. The frames, per path, and the chat kept clean. */
  it('brackets every chunk with a start and an end, per path', async () => {
    const res = await generate('happy', 'build a contact dashboard')

    for (const path of ['index.html', 'styles.css', 'app.js']) {
      const positions = res.frames
        .map((frame, index) => ({ frame, index }))
        .filter(({ frame }) => (frame.data as { path?: string } | undefined)?.path === path)

      const start = positions.find(({ frame }) => frame.event === 'file_start')?.index
      const end = positions.find(({ frame }) => frame.event === 'file_end')?.index
      const chunks = positions
        .filter(({ frame }) => frame.event === 'file_chunk')
        .map(({ index }) => index)

      expect(start).toBeDefined()
      expect(end).toBeDefined()
      expect(chunks.length).toBeGreaterThan(0)
      expect(start).toBeLessThan(Math.min(...chunks))
      expect(end).toBeGreaterThan(Math.max(...chunks))
    }
  })

  it('emits chunks that concatenate to exactly the stored content', async () => {
    const res = await generate('happy', 'build a contact dashboard')

    for (const file of await storedFiles(aliceUid, 'happy')) {
      expect(chunkText(res, file.path)).toBe(file.content)
    }
  })

  it('puts no file content in any token frame', async () => {
    const res = await generate('happy', 'build a contact dashboard')

    const chat = tokenText(res)
    for (const file of await storedFiles(aliceUid, 'happy')) {
      const firstLine = file.content.split('\n')[0] ?? ''
      expect(chat).not.toContain(firstLine)
    }
  })

  /** D31. A file write does not reorder the dashboard. */
  it('leaves the project document untouched', async () => {
    await generate('happy', 'build a contact dashboard')

    const project = await adminDb().doc(`users/${aliceUid}/projects/happy`).get()
    expect((project.get('updatedAt') as Timestamp).toMillis()).toBe(1_700_000_000_000)
  })
})

describe('a second generation over the same paths (AC-19)', () => {
  it('updates the same documents, preserving createdAt and advancing updatedAt', async () => {
    await generate('twice', 'build a contact dashboard')
    const before = await storedFiles(aliceUid, 'twice')

    // A second prompt, so the transcript does not end on an assistant turn.
    await postGenerate({ projectId: 'twice', content: 'and add a search box' }, auth(aliceToken))

    const after = await storedFiles(aliceUid, 'twice')
    expect(after.map((file) => file.id)).toEqual(before.map((file) => file.id))
    expect(after).toHaveLength(3)
    for (const [index, file] of after.entries()) {
      const original = before[index]
      expect(file.createdAt.toMillis()).toBe(original?.createdAt.toMillis())
      expect(file.updatedAt.toMillis()).toBeGreaterThanOrEqual(original?.updatedAt.toMillis() ?? 0)
    }
  })
})

/**
 * The malformed cases — F8.1, and **the assertion is that no document exists**.
 *
 * Every one of these still writes the assistant message: the reply is a
 * legitimate turn whatever its file blocks did, and F8.2's partial-preservation
 * rule does not stop applying because a path was wrong.
 */
describe('a generation whose files are refused', () => {
  /** AC-18. */
  it('writes nothing and names the refused path for __bad_path', async () => {
    const res = await generate('badpath', '__bad_path build a contact dashboard')

    expect(await storedFiles(aliceUid, 'badpath')).toEqual([])
    expect(await assistantContent(aliceUid, 'badpath')).toHaveLength(1)
    expect(donePayload(res).files).toEqual([])
    expect(donePayload(res).fileError).toBe(
      'Genesis could not save the generated files: "../secrets.js" is not a file name we can store. Nothing was changed.',
    )
  })

  /*
   * The one that matters most: `index.html` was a perfectly good op in that same turn, and it is
   * refused with the rest.
   */
  it('refuses the good ops in the same turn as the bad one', async () => {
    await generate('badpath', '__bad_path build a contact dashboard')

    expect(await storedFiles(aliceUid, 'badpath')).toEqual([])
  })

  /** AC-23. */
  it('writes nothing and names the file for __unterminated', async () => {
    const res = await generate('unterm', '__unterminated build a contact dashboard')

    expect(await storedFiles(aliceUid, 'unterm')).toEqual([])
    expect(donePayload(res).fileError).toBe(
      'The reply ended in the middle of "index.html", so nothing was saved. Try again.',
    )
  })

  /** AC-24. */
  it('writes nothing and names the path for __dup_files', async () => {
    const res = await generate('dup', '__dup_files build a contact dashboard')

    expect(await storedFiles(aliceUid, 'dup')).toEqual([])
    expect(donePayload(res).fileError).toBe(
      'Genesis could not save the generated files: "app.js" was written twice. Nothing was changed.',
    )
  })

  /** AC-20. A prose-only reply is a legitimate turn, not malformed output (D17). */
  it('writes nothing and reports no error for __no_files', async () => {
    const res = await generate('none', '__no_files what can you build')

    expect(await storedFiles(aliceUid, 'none')).toEqual([])
    expect(donePayload(res).files).toEqual([])
    expect(donePayload(res).fileError).toBeNull()
    expect(await assistantContent(aliceUid, 'none')).toHaveLength(1)
  })
})

/** D10. A turn that did not complete writes no files, whichever way it ended. */
describe('a generation that did not complete', () => {
  /** AC-21. */
  it('writes no file when the stream fails after a block closed', async () => {
    const res = await generate('failmid', '__fail_midstream build a contact dashboard')

    expect(framesOf(res.frames, 'error')).toHaveLength(1)
    expect(framesOf(res.frames, 'done')).toHaveLength(0)
    expect(await storedFiles(aliceUid, 'failmid')).toEqual([])

    const snapshot = await adminDb()
      .collection(`users/${aliceUid}/projects/failmid/messages`)
      .where('role', '==', 'assistant')
      .get()
    expect(snapshot.docs).toHaveLength(1)
    expect(snapshot.docs[0]?.get('truncated')).toBe(true)
  })

  /** AC-22. `max_tokens` is a `done`, because it is a real but incomplete answer. */
  it('writes no file and says the reply was cut short for __max_tokens', async () => {
    const res = await generate('maxtok', '__max_tokens write me an epic')

    expect(framesOf(res.frames, 'done')).toHaveLength(1)
    expect(donePayload(res).message['truncated']).toBe(true)
    expect(await storedFiles(aliceUid, 'maxtok')).toEqual([])
    expect(donePayload(res).files).toEqual([])
    expect(donePayload(res).fileError).toBe(
      'The reply was cut short, so no files were saved. Try again.',
    )
  })

  /**
   * A truncated turn that contained no file block at all reports **no** error: a prose-only
   * reply is a legitimate turn, and a truncated prose-only reply is still one.
   */
  it('reports no fileError for a truncated turn that attempted no file', async () => {
    const res = await generate('longone', '__long write me everything')

    expect(donePayload(res).message['truncated']).toBe(true)
    expect(donePayload(res).fileError).toBeNull()
  })
})
