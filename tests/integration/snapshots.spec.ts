import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { adminDb, framesOf, idTokenFor, postGenerate, resetEmulators, seedUser } from './helpers'

/**
 * Snapshots and restore, over the wire — AC-6 to AC-8 and AC-10 to AC-19.
 *
 * The whole slice's claim is about **documents that exist and documents that do
 * not**, so every case here reads Firestore back rather than reading a return
 * value. That is Slice 6's rule (F8.1) applied to a collection whose failure mode
 * is quieter: a snapshot nobody wrote is invisible until someone tries to restore
 * a version that is not in the list, and a snapshot written for a refused turn is
 * a version that restores an app which never existed.
 *
 * The LLM is the emulator-only fake, driven by markers in the prompt. No
 * automated test in this project ever calls Anthropic.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'gensnap-alice@example.test'
const BOB = 'gensnap-bob@example.test'

let aliceUid: string
let aliceToken: string
let bobUid: string

const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })

async function seedProject(uid: string, id: string, deletedAt: Timestamp | null = null): Promise<void> {
  await adminDb()
    .doc(`users/${uid}/projects/${id}`)
    .set({
      name: `Project ${id}`,
      description: null,
      locationId: null,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      deletedAt,
    })
}

/** A prompt written past the routes, so a generation has a transcript to read. */
let promptSeq = 0
async function seedPrompt(uid: string, projectId: string, content: string): Promise<void> {
  promptSeq += 1
  await adminDb()
    .doc(`users/${uid}/projects/${projectId}/messages/msg-${String(promptSeq)}`)
    .set({
      role: 'user',
      content,
      seq: 0,
      createdAt: Timestamp.fromMillis(1_700_000_000_000 + promptSeq * 1000),
      truncated: false,
    })
}

/** One turn against an already-seeded project. */
async function turn(projectId: string, prompt: string, uid = aliceUid, token = aliceToken) {
  await seedPrompt(uid, projectId, prompt)
  return postGenerate({ projectId }, auth(token))
}

interface StoredSnapshotDoc {
  id: string
  seq: number
  origin: string
  fileCount: number
  totalBytes: number
  createdAt: Timestamp
}

/** Every version a project holds, oldest first — read straight, not through the route. */
async function storedSnapshots(uid: string, projectId: string): Promise<StoredSnapshotDoc[]> {
  const snapshot = await adminDb()
    .collection(`users/${uid}/projects/${projectId}/snapshots`)
    .orderBy('seq', 'asc')
    .get()

  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<StoredSnapshotDoc, 'id'>) }))
}

interface CopiedFile {
  id: string
  path: string
  content: string
  size: number
}

/** One version's copied files, by path. */
async function snapshotFiles(
  uid: string,
  projectId: string,
  snapshotId: string,
): Promise<CopiedFile[]> {
  const snapshot = await adminDb()
    .collection(`users/${uid}/projects/${projectId}/snapshots/${snapshotId}/files`)
    .orderBy('path')
    .get()

  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<CopiedFile, 'id'>) }))
}

interface LiveFile {
  id: string
  path: string
  content: string
  size: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

async function storedFiles(uid: string, projectId: string): Promise<LiveFile[]> {
  const snapshot = await adminDb()
    .collection(`users/${uid}/projects/${projectId}/files`)
    .orderBy('path')
    .get()

  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<LiveFile, 'id'>) }))
}

async function clearProjects(uid: string): Promise<void> {
  const refs = await adminDb().collection(`users/${uid}/projects`).listDocuments()
  await Promise.all(refs.map((ref) => adminDb().recursiveDelete(ref)))
}

beforeAll(async () => {
  await resetEmulators()
  aliceUid = await seedUser(ALICE, PASSWORD, true)
  aliceToken = await idTokenFor(ALICE, PASSWORD)
  bobUid = await seedUser(BOB, PASSWORD, true)
}, 60_000)

beforeEach(async () => {
  await clearProjects(aliceUid)
  await clearProjects(bobUid)
})

describe('a generation that stores files (AC-6)', () => {
  it('writes exactly one snapshot, numbered 1 and marked a generation', async () => {
    await seedProject(aliceUid, 'first')
    await turn('first', 'build a contact dashboard')

    const snapshots = await storedSnapshots(aliceUid, 'first')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.seq).toBe(1)
    expect(snapshots[0]?.origin).toBe('generation')
    expect(snapshots[0]?.fileCount).toBe(3)
  })

  it('sums totalBytes from the files it copied', async () => {
    await seedProject(aliceUid, 'first')
    await turn('first', 'build a contact dashboard')

    const [snapshot] = await storedSnapshots(aliceUid, 'first')
    const copies = await snapshotFiles(aliceUid, 'first', snapshot?.id ?? '')
    expect(snapshot?.totalBytes).toBe(copies.reduce((total, file) => total + file.size, 0))
  })

  /*
   * The copy is byte-identical to the live document, because a restore writes
   * these bytes straight back. A copy that differed by so much as a trailing
   * newline would be a restore that silently rewrote the user's app.
   */
  it('copies every file byte for byte, at an id equal to its path', async () => {
    await seedProject(aliceUid, 'first')
    await turn('first', 'build a contact dashboard')

    const [snapshot] = await storedSnapshots(aliceUid, 'first')
    const copies = await snapshotFiles(aliceUid, 'first', snapshot?.id ?? '')
    const live = await storedFiles(aliceUid, 'first')

    expect(copies.map((file) => file.id)).toEqual(['app.js', 'index.html', 'styles.css'])
    expect(copies.map((file) => file.id)).toEqual(copies.map((file) => file.path))
    expect(copies.map((file) => [file.path, file.content, file.size])).toEqual(
      live.map((file) => [file.path, file.content, file.size]),
    )
  })

  /* No timestamps on a copy: the snapshot's own createdAt is the copy's date. */
  it('gives a copied file no timestamps of its own', async () => {
    await seedProject(aliceUid, 'first')
    await turn('first', 'build a contact dashboard')

    const [snapshot] = await storedSnapshots(aliceUid, 'first')
    const [copy] = await snapshotFiles(aliceUid, 'first', snapshot?.id ?? '')
    expect(Object.keys(copy ?? {}).sort()).toEqual(['content', 'id', 'path', 'size'])
    expect(snapshot?.createdAt).toBeInstanceOf(Timestamp)
  })
})

/**
 * AC-7, and R1 stated over the wire.
 *
 * `__alt_files` rewrites `index.html` and adds `about.html`, leaving `app.js`
 * and `styles.css` alone. The untouched files being in version 2 is the whole
 * difference between a snapshot and a changelog — without them, restoring
 * version 2 would produce an app of two files.
 */
describe('a second generation that rewrites one file and adds another (AC-7)', () => {
  it('numbers the new version 2 and counts four files in it', async () => {
    await seedProject(aliceUid, 'second')
    await turn('second', 'build a contact dashboard')
    await turn('second', '__alt_files add an about page')

    const snapshots = await storedSnapshots(aliceUid, 'second')
    expect(snapshots.map((snapshot) => snapshot.seq)).toEqual([1, 2])
    expect(snapshots[1]?.fileCount).toBe(4)
  })

  it('copies the file the turn never touched, equal to the stored one', async () => {
    await seedProject(aliceUid, 'second')
    await turn('second', 'build a contact dashboard')
    await turn('second', '__alt_files add an about page')

    const snapshots = await storedSnapshots(aliceUid, 'second')
    const copies = await snapshotFiles(aliceUid, 'second', snapshots[1]?.id ?? '')
    const live = await storedFiles(aliceUid, 'second')

    const untouched = copies.find((file) => file.path === 'styles.css')
    expect(untouched?.content).toBe(live.find((file) => file.path === 'styles.css')?.content)
    expect(copies.map((file) => file.path)).toEqual([
      'about.html',
      'app.js',
      'index.html',
      'styles.css',
    ])
  })

  /* Version 1 is not rewritten by version 2 — that is what makes it restorable. */
  it('leaves version 1 holding the three files it was taken of', async () => {
    await seedProject(aliceUid, 'second')
    await turn('second', 'build a contact dashboard')
    const before = await snapshotFiles(
      aliceUid,
      'second',
      (await storedSnapshots(aliceUid, 'second'))[0]?.id ?? '',
    )
    await turn('second', '__alt_files add an about page')

    const snapshots = await storedSnapshots(aliceUid, 'second')
    expect(await snapshotFiles(aliceUid, 'second', snapshots[0]?.id ?? '')).toEqual(before)
  })
})

/**
 * AC-8 — six ways for a turn not to store files, and none of them writes a
 * version.
 *
 * A snapshot of a refused turn would be a version of an app that never existed,
 * restorable into a project that never held it. The assertion is the count
 * before and after, so a snapshot written and then deleted would still fail.
 */
describe('a turn that stores no files (AC-8)', () => {
  it.each([
    ['__no_files', 'prose only'],
    ['__bad_path', 'a path that cannot be stored'],
    ['__unterminated', 'a block that never closes'],
    ['__dup_files', 'one path written twice'],
    ['__max_tokens', 'a reply cut short by the token cap'],
    ['__fail_midstream', 'a stream that died mid-reply'],
  ])('writes no snapshot for %s (%s)', async (marker) => {
    const projectId = `none-${marker.slice(2)}`
    await seedProject(aliceUid, projectId)
    await turn(projectId, 'build a contact dashboard')
    const before = await storedSnapshots(aliceUid, projectId)

    await turn(projectId, `${marker} try again`)

    expect(await storedSnapshots(aliceUid, projectId)).toHaveLength(before.length)
  })

  /* A project whose very first turn stores nothing has no history at all. */
  it('writes no snapshot at all when the first turn stores nothing', async () => {
    await seedProject(aliceUid, 'never')

    const res = await turn('never', '__no_files just say hello')

    expect(framesOf(res.frames, 'done')).toHaveLength(1)
    expect(await storedSnapshots(aliceUid, 'never')).toEqual([])
  })
})

/**
 * AC-10 — the prune, and R4 with it.
 *
 * The pruned version's **file documents** are the assertion that matters:
 * deleting a document in Firestore does not delete its subcollections, so a
 * prune that removed only the parent would leave twenty orphaned documents per
 * pruned version, unreachable from every query this codebase makes.
 */
describe('a project already holding the cap (AC-10)', () => {
  const LIMIT = 20

  it('keeps exactly the cap, drops the lowest, and takes its files with it', async () => {
    await seedProject(aliceUid, 'full')
    const collection = adminDb().collection(`users/${aliceUid}/projects/full/snapshots`)

    for (let seq = 1; seq <= LIMIT; seq += 1) {
      const ref = collection.doc(`seed-${String(seq).padStart(2, '0')}`)
      await ref.set({
        seq,
        createdAt: Timestamp.fromMillis(1_700_000_000_000 + seq * 1000),
        origin: 'generation',
        fileCount: 1,
        totalBytes: 3,
      })
      // Only the oldest gets files, because it is the only one the prune takes —
      // and its files are what R4 says would otherwise be orphaned.
      if (seq === 1) {
        await ref.collection('files').doc('index.html').set({
          path: 'index.html',
          content: 'old',
          size: 3,
        })
      }
    }

    await turn('full', 'build a contact dashboard')

    const snapshots = await storedSnapshots(aliceUid, 'full')
    expect(snapshots).toHaveLength(LIMIT)
    expect(snapshots.map((snapshot) => snapshot.id)).not.toContain('seed-01')
    expect(await snapshotFiles(aliceUid, 'full', 'seed-01')).toEqual([])
    expect(snapshots[snapshots.length - 1]?.seq).toBe(LIMIT + 1)
  })

  /* D5. The prune leaves a gap, and the next number does not close it. */
  it('numbers the new version above the highest, gap or no gap', async () => {
    await seedProject(aliceUid, 'gap')
    const collection = adminDb().collection(`users/${aliceUid}/projects/gap/snapshots`)
    for (const seq of [2, 5, 9]) {
      await collection.doc(`seed-${String(seq)}`).set({
        seq,
        createdAt: Timestamp.fromMillis(1_700_000_000_000 + seq * 1000),
        origin: 'generation',
        fileCount: 1,
        totalBytes: 3,
      })
    }

    await turn('gap', 'build a contact dashboard')

    const snapshots = await storedSnapshots(aliceUid, 'gap')
    expect(snapshots.map((snapshot) => snapshot.seq)).toEqual([2, 5, 9, 10])
  })
})
