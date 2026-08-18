import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminDb,
  API_BASE,
  framesOf,
  getJson,
  idTokenFor,
  postGenerate,
  postJson,
  resetEmulators,
  seedUser,
  type JsonResponse,
} from './helpers'

/**
 * Snapshots and restore, over the wire — AC-6 to AC-8 and AC-10 to AC-19.
 *
 * The whole slice's claim is about **documents that exist and documents that do not**, so every
 * case here reads Firestore back rather than reading a return value. That is Slice 6's rule
 * applied to a collection whose failure mode is quieter: a snapshot nobody wrote is invisible
 * until someone tries to restore a version that is not in the list, and a snapshot written for a
 * refused turn is a version that restores an app which never existed.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'gensnap-alice@example.test'
const BOB = 'gensnap-bob@example.test'

let aliceUid: string
let aliceToken: string
let bobUid: string
let bobToken: string

const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })

async function seedProject(
  uid: string,
  id: string,
  deletedAt: Timestamp | null = null,
): Promise<void> {
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

/**
 * One turn against an already-seeded project.
 *
 * The prompt goes in the body. A turn is one request now — the handler writes
 * the user message itself, and it mints the `seq` — so seeding a transcript
 * first is both unnecessary and, across several turns in one project, wrong: the
 * documents this file used to write all claimed `seq: 0`.
 */
async function turn(projectId: string, prompt: string, token = aliceToken) {
  return postGenerate({ projectId, content: prompt }, auth(token))
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

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<StoredSnapshotDoc, 'id'>),
  }))
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
  bobToken = await idTokenFor(BOB, PASSWORD)
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
   * The copy is byte-identical to the live document, because a restore writes these bytes
   * straight back.
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
 * `__alt_files` rewrites `index.html` and adds `about.html`, leaving `app.js` and `styles.css`
 * alone. The untouched files being in version 2 is the whole difference between a snapshot and a
 * changelog — without them, restoring version 2 would produce an app of two files.
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
 * AC-8 — six ways for a turn not to store files, and none of them writes a version.
 *
 * A snapshot of a refused turn would be a version of an app that never existed, restorable into
 * a project that never held it. The assertion is the count before and after, so a snapshot
 * written and then deleted would still fail.
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

  /**
   * R4 reached from the direction `PrunedSnapshot` does not cover, and the one case only the
   * emulator can prove.
   */
  it('prunes a version whose seq is gone, which no ordered read can see', async () => {
    await seedProject(aliceUid, 'orphaned')
    const collection = adminDb().collection(`users/${aliceUid}/projects/orphaned/snapshots`)

    for (let seq = 1; seq <= LIMIT; seq += 1) {
      await collection.doc(`seed-${String(seq).padStart(2, '0')}`).set({
        seq,
        createdAt: Timestamp.fromMillis(1_700_000_000_000 + seq * 1000),
        origin: 'generation',
        fileCount: 1,
        totalBytes: 3,
      })
    }
    // The head with nothing to name it, and one file document hanging off it.
    await collection.doc('no-seq').set({
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      origin: 'generation',
      fileCount: 1,
      totalBytes: 3,
    })
    await collection
      .doc('no-seq')
      .collection('files')
      .doc('index.html')
      .set({ path: 'index.html', content: 'old', size: 3 })

    await turn('orphaned', 'build a contact dashboard')

    const ids = (await collection.listDocuments()).map((ref) => ref.id)
    // 21 heads + the new one, capped back to 20: the seq-less head goes first,
    // and `seed-01` with it.
    expect(ids).toHaveLength(LIMIT)
    expect(ids).not.toContain('no-seq')
    expect(ids).not.toContain('seed-01')
    // And its copies go with it, rather than outliving the version they belong to.
    expect(await snapshotFiles(aliceUid, 'orphaned', 'no-seq')).toEqual([])
  })
})

/** One version, as the list route answers it. */
interface SnapshotMetaBody {
  id: string
  seq: number
  createdAt: string
  origin: string
  fileCount: number
  totalBytes: number
}

const listPath = (projectId: string): string => `/projects/${projectId}/snapshots`

async function listSnapshots(projectId: string, token = aliceToken) {
  return getJson(listPath(projectId), auth(token))
}

/** Seed a version straight past the routes — the list has no writer of its own. */
async function seedSnapshot(
  uid: string,
  projectId: string,
  id: string,
  seq: number,
  origin: 'generation' | 'restore' = 'generation',
): Promise<void> {
  await adminDb()
    .doc(`users/${uid}/projects/${projectId}/snapshots/${id}`)
    .set({
      seq,
      createdAt: Timestamp.fromMillis(1_700_000_000_000 + seq * 1000),
      origin,
      fileCount: 2,
      totalBytes: 42,
    })
}

/**
 * AC-11 — the list.
 *
 * Newest first, because a version list is read from the top: the version you
 * want to go back to is nearly always the one you just left. And **no content**,
 * because a project at both caps is twenty versions of twenty files of 100 KB,
 * and opening a history sheet must not ship any of it.
 */
describe('GET /api/projects/:projectId/snapshots (AC-11)', () => {
  it('answers newest first, by seq', async () => {
    await seedProject(aliceUid, 'list')
    await seedSnapshot(aliceUid, 'list', 'a', 1)
    await seedSnapshot(aliceUid, 'list', 'b', 3, 'restore')
    await seedSnapshot(aliceUid, 'list', 'c', 2)

    const res = await listSnapshots('list')

    expect(res.status).toBe(200)
    const { snapshots } = res.body as { snapshots: SnapshotMetaBody[] }
    expect(snapshots.map((snapshot) => snapshot.seq)).toEqual([3, 2, 1])
    expect(snapshots.map((snapshot) => snapshot.id)).toEqual(['b', 'c', 'a'])
  })

  it('carries the six fields and no content', async () => {
    await seedProject(aliceUid, 'fields')
    await seedSnapshot(aliceUid, 'fields', 'a', 1, 'restore')

    const { snapshots } = (await listSnapshots('fields')).body as {
      snapshots: SnapshotMetaBody[]
    }

    expect(Object.keys(snapshots[0] ?? {}).sort()).toEqual([
      'createdAt',
      'fileCount',
      'id',
      'origin',
      'seq',
      'totalBytes',
    ])
    expect(snapshots[0]?.origin).toBe('restore')
    // ISO-8601, the project's convention since Slice 2 — not a Firestore shape.
    expect(snapshots[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('answers an empty list for a project with no versions', async () => {
    await seedProject(aliceUid, 'empty')

    const res = await listSnapshots('empty')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ snapshots: [] })
  })

  /*
   * The cap matches `SNAPSHOT_LIMIT`, so "you are seeing every version" is a guarantee rather
   * than a hope — an unpaginated list is only honest if it cannot truncate.
   */
  it('returns at most the cap, even when the collection holds more', async () => {
    await seedProject(aliceUid, 'over')
    for (let seq = 1; seq <= 25; seq += 1) {
      await seedSnapshot(aliceUid, 'over', `s-${String(seq).padStart(2, '0')}`, seq)
    }

    const { snapshots } = (await listSnapshots('over')).body as { snapshots: SnapshotMetaBody[] }

    expect(snapshots).toHaveLength(20)
    expect(snapshots[0]?.seq).toBe(25)
  })

  /* A version nothing can read is omitted, exactly as a corrupt file is (D13). */
  it('omits a version whose document cannot be read', async () => {
    await seedProject(aliceUid, 'corrupt')
    await seedSnapshot(aliceUid, 'corrupt', 'good', 2)
    await adminDb()
      .doc(`users/${aliceUid}/projects/corrupt/snapshots/bad`)
      .set({ seq: 1, origin: 'sideways' })

    const { snapshots } = (await listSnapshots('corrupt')).body as { snapshots: SnapshotMetaBody[] }

    expect(snapshots.map((snapshot) => snapshot.id)).toEqual(['good'])
  })

  it('answers 401 without an Authorization header', async () => {
    await seedProject(aliceUid, 'list')

    const res = await getJson(listPath('list'))

    expect(res.status).toBe(401)
    expect((res.body as { code: string }).code).toBe('unauthenticated')
  })

  it('answers 403 for an unverified address', async () => {
    const unverified = 'gensnap-unverified@example.test'
    await seedUser(unverified, PASSWORD, false)
    await seedProject(aliceUid, 'list')

    const res = await listSnapshots('list', await idTokenFor(unverified, PASSWORD))

    expect(res.status).toBe(403)
    expect((res.body as { code: string }).code).toBe('email_unverified')
  })

  it('answers 400 invalid_id for a malformed project id', async () => {
    const res = await getJson('/projects/not%20an%20id/snapshots', auth(aliceToken))

    expect(res.status).toBe(400)
    expect((res.body as { code: string }).code).toBe('invalid_id')
  })

  /*
   * AC-17's list half. Another user's project is not *addressable* by a request
   * — the path is composed from the token's uid — so this is a 404 rather than a
   * refusal, and bob's own history is untouched by the attempt.
   */
  it('answers 404 for another user’s project, and leaves it alone', async () => {
    await seedProject(bobUid, 'bobs')
    await seedSnapshot(bobUid, 'bobs', 'b1', 1)

    const res = await listSnapshots('bobs')

    expect(res.status).toBe(404)
    expect((res.body as { code: string }).code).toBe('not_found')
    expect(await storedSnapshots(bobUid, 'bobs')).toHaveLength(1)
    expect(
      ((await listSnapshots('bobs', bobToken)).body as { snapshots: unknown[] }).snapshots,
    ).toHaveLength(1)
  })

  it('answers 404 for a soft-deleted project', async () => {
    await seedProject(aliceUid, 'gone', Timestamp.fromMillis(1_700_000_900_000))
    await seedSnapshot(aliceUid, 'gone', 'a', 1)

    expect((await listSnapshots('gone')).status).toBe(404)
  })
})

/**
 * The restore route, with **no body at all**.
 *
 * `postJson` always sends a `Content-Type` and a serialised body, which is exactly the shape the
 * route refuses — so the ordinary call needs a bare `fetch`. The refusal itself is asserted with
 * `postJson`, which is the closest thing to a real caller getting it wrong.
 */
async function restore(
  projectId: string,
  snapshotId: string,
  token: string | null = aliceToken,
): Promise<JsonResponse> {
  const res = await fetch(`${API_BASE}${listPath(projectId)}/${snapshotId}/restore`, {
    method: 'POST',
    headers: token === null ? {} : auth(token),
  })
  const raw = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = raw
  }
  return { status: res.status, body: parsed, raw, headers: res.headers }
}

interface RestoreBody {
  files: { path: string; size: number; createdAt: string; updatedAt: string }[]
  changed: boolean
}

const codeOf = (res: JsonResponse): string => (res.body as { code?: string }).code ?? ''

/** Generate twice, so the project has version 1 (3 files) and version 2 (4). */
async function twoVersions(projectId: string): Promise<StoredSnapshotDoc[]> {
  await seedProject(aliceUid, projectId)
  await turn(projectId, 'build a contact dashboard')
  await turn(projectId, '__alt_files add an about page')
  return storedSnapshots(aliceUid, projectId)
}

/**
 * AC-12 — a restore makes the file set **equal** to the version's.
 *
 * The negative is the case R3 is about: a restore that writes but does not delete leaves version
 * 1's `index.html` beside version 2's `about.html` — a hybrid of two versions that looks fine in
 * the tree and breaks in the preview. `about.html` being gone is therefore asserted directly,
 * not inferred from a count.
 */
describe('restoring an earlier version (AC-12)', () => {
  it('writes back every file byte for byte and deletes what the version does not hold', async () => {
    const versions = await twoVersions('back')
    const copies = await snapshotFiles(aliceUid, 'back', versions[0]?.id ?? '')

    const res = await restore('back', versions[0]?.id ?? '')

    expect(res.status).toBe(200)
    const live = await storedFiles(aliceUid, 'back')
    expect(live.map((file) => file.path)).toEqual(copies.map((file) => file.path))
    expect(live.map((file) => file.content)).toEqual(copies.map((file) => file.content))
    expect(live.map((file) => file.path)).not.toContain('about.html')
  })

  it('answers changed: true and a files list equal to a fresh GET', async () => {
    const versions = await twoVersions('equal')

    const res = await restore('equal', versions[0]?.id ?? '')

    const body = res.body as RestoreBody
    expect(body.changed).toBe(true)
    expect((await getJson('/projects/equal/files', auth(aliceToken))).body).toEqual({
      files: body.files,
    })
  })

  /* A rewrite merges, so the date the file was first generated survives a restore. */
  it('keeps createdAt on a file the version and the project both hold', async () => {
    const versions = await twoVersions('created')
    const before = await storedFiles(aliceUid, 'created')

    await restore('created', versions[0]?.id ?? '')

    const after = await storedFiles(aliceUid, 'created')
    const original = before.find((file) => file.path === 'index.html')
    expect(after.find((file) => file.path === 'index.html')?.createdAt.toMillis()).toBe(
      original?.createdAt.toMillis(),
    )
  })
})

/**
 * AC-13 — the safety snapshot, which is D9's whole argument.
 *
 * A confirmation modal asks the user to be certain; a snapshot of what was there makes being
 * wrong survivable. The test that matters is the second half: restoring the safety snapshot
 * returns the project to where it started, so the undo has an undo.
 */
describe('the safety snapshot (AC-13)', () => {
  it('records what was there, marked a restore, at the highest seq', async () => {
    const versions = await twoVersions('safety')
    const before = await storedFiles(aliceUid, 'safety')

    await restore('safety', versions[0]?.id ?? '')

    const after = await storedSnapshots(aliceUid, 'safety')
    const newest = after[after.length - 1]
    expect(newest?.origin).toBe('restore')
    expect(newest?.seq).toBe(3)
    expect(newest?.fileCount).toBe(4)
    const copies = await snapshotFiles(aliceUid, 'safety', newest?.id ?? '')
    expect(copies.map((file) => [file.path, file.content])).toEqual(
      before.map((file) => [file.path, file.content]),
    )
  })

  it('restores back to the later version when the safety snapshot is restored', async () => {
    const versions = await twoVersions('undo')
    const before = await storedFiles(aliceUid, 'undo')
    await restore('undo', versions[0]?.id ?? '')
    const safety = (await storedSnapshots(aliceUid, 'undo')).slice(-1)[0]

    await restore('undo', safety?.id ?? '')

    const live = await storedFiles(aliceUid, 'undo')
    expect(live.map((file) => file.path)).toEqual([
      'about.html',
      'app.js',
      'index.html',
      'styles.css',
    ])
    /*
     * The paths alone are the weaker half: a round trip that put the files back under the right
     * names with the wrong bytes would satisfy them.
     */
    expect(live.map((file) => [file.path, file.content])).toEqual(
      before.map((file) => [file.path, file.content]),
    )
  })
})

/**
 * AC-14 — restoring the version a project already is writes **nothing**.
 *
 * Not an optimisation. Writing would advance every file's `updatedAt` and mint a safety snapshot
 * of a state nothing changed — so the history would fill with versions recording that nothing
 * happened, and the prune would push real ones out to make room for them.
 */
describe('restoring the version the project already is (AC-14)', () => {
  it('writes no snapshot, touches no file, and answers changed: false', async () => {
    const versions = await twoVersions('noop')
    const before = await storedFiles(aliceUid, 'noop')
    const snapshotsBefore = await storedSnapshots(aliceUid, 'noop')

    const res = await restore('noop', versions[1]?.id ?? '')

    expect((res.body as RestoreBody).changed).toBe(false)
    expect(await storedSnapshots(aliceUid, 'noop')).toHaveLength(snapshotsBefore.length)
    const after = await storedFiles(aliceUid, 'noop')
    expect(after.map((file) => file.updatedAt.toMillis())).toEqual(
      before.map((file) => file.updatedAt.toMillis()),
    )
  })

  it('still answers the project’s files, so a caller has one shape to read', async () => {
    const versions = await twoVersions('noop-body')

    const res = await restore('noop-body', versions[1]?.id ?? '')

    expect((res.body as RestoreBody).files.map((file) => file.path)).toEqual([
      'about.html',
      'app.js',
      'index.html',
      'styles.css',
    ])
  })
})

/** AC-15 — a project with nothing to lose gets no safety snapshot (D9). */
describe('restoring into a project with no files (AC-15)', () => {
  it('writes the version’s files and takes no safety snapshot', async () => {
    const versions = await twoVersions('emptied')
    for (const file of await storedFiles(aliceUid, 'emptied')) {
      await adminDb().doc(`users/${aliceUid}/projects/emptied/files/${file.id}`).delete()
    }
    const before = await storedSnapshots(aliceUid, 'emptied')

    const res = await restore('emptied', versions[0]?.id ?? '')

    expect(res.status).toBe(200)
    expect((await storedFiles(aliceUid, 'emptied')).map((file) => file.path)).toEqual([
      'app.js',
      'index.html',
      'styles.css',
    ])
    expect(await storedSnapshots(aliceUid, 'emptied')).toHaveLength(before.length)
  })
})

/**
 * AC-16 — a version that is there and cannot be trusted.
 *
 * All-or-nothing on the **read** side as well as the write side: a version one document short
 * would restore an app missing a file, and a version with one corrupt document would restore an
 * app with a hole in it. Both are worse than refusing, because both look like they worked.
 */
describe('a version that cannot be read whole (AC-16)', () => {
  it('answers 409 and writes nothing when a copied file is missing', async () => {
    const versions = await twoVersions('short')
    const target = versions[0]?.id ?? ''
    await adminDb()
      .doc(`users/${aliceUid}/projects/short/snapshots/${target}/files/app.js`)
      .delete()
    const before = await storedFiles(aliceUid, 'short')
    const snapshotsBefore = await storedSnapshots(aliceUid, 'short')

    const res = await restore('short', target)

    expect(res.status).toBe(409)
    expect(codeOf(res)).toBe('snapshot_unreadable')
    expect(await storedFiles(aliceUid, 'short')).toEqual(before)
    expect(await storedSnapshots(aliceUid, 'short')).toHaveLength(snapshotsBefore.length)
  })

  it('answers 409 and writes nothing when a copied file will not parse', async () => {
    const versions = await twoVersions('corrupted')
    const target = versions[0]?.id ?? ''
    await adminDb()
      .doc(`users/${aliceUid}/projects/corrupted/snapshots/${target}/files/app.js`)
      .set({ path: 'app.js', size: 3 })
    const before = await storedFiles(aliceUid, 'corrupted')
    const snapshotsBefore = await storedSnapshots(aliceUid, 'corrupted')

    const res = await restore('corrupted', target)

    expect(res.status).toBe(409)
    expect(codeOf(res)).toBe('snapshot_unreadable')
    expect(await storedFiles(aliceUid, 'corrupted')).toEqual(before)
    // The safety snapshot is not minted either — "nothing was written" is the
    // whole of the refusal, and a parse failure must reach it by the same road a
    // missing document does.
    expect(await storedSnapshots(aliceUid, 'corrupted')).toHaveLength(snapshotsBefore.length)
  })

  it('says nothing was changed, in so many words', async () => {
    const versions = await twoVersions('wording')
    const target = versions[0]?.id ?? ''
    await adminDb()
      .doc(`users/${aliceUid}/projects/wording/snapshots/${target}/files/app.js`)
      .delete()

    const res = await restore('wording', target)

    expect((res.body as { error: string }).error).toContain('Nothing was changed.')
  })
})

/** AC-17 — every way a version can fail to be this caller's, and one answer. */
describe('a version that is not this caller’s to restore (AC-17)', () => {
  it('answers 404 for another user’s version and leaves their project alone', async () => {
    await seedProject(bobUid, 'bobs-project')
    await postGenerate(
      { projectId: 'bobs-project', content: 'build a contact dashboard' },
      auth(bobToken),
    )
    const bobs = await storedSnapshots(bobUid, 'bobs-project')
    const before = await storedFiles(bobUid, 'bobs-project')

    const res = await restore('bobs-project', bobs[0]?.id ?? '')

    expect(res.status).toBe(404)
    expect(await storedFiles(bobUid, 'bobs-project')).toEqual(before)
    expect(await storedSnapshots(bobUid, 'bobs-project')).toHaveLength(bobs.length)
  })

  it('answers 404 for a soft-deleted project', async () => {
    const versions = await twoVersions('deleted')
    await adminDb()
      .doc(`users/${aliceUid}/projects/deleted`)
      .update({ deletedAt: Timestamp.fromMillis(1_700_000_900_000) })

    expect((await restore('deleted', versions[0]?.id ?? '')).status).toBe(404)
  })

  /* A version id is scoped to its project, so one of alice's own is still a 404. */
  it('answers 404 for a version id belonging to another of the caller’s projects', async () => {
    const versions = await twoVersions('source')
    await seedProject(aliceUid, 'target')

    const res = await restore('target', versions[0]?.id ?? '')

    expect(res.status).toBe(404)
    expect(codeOf(res)).toBe('not_found')
  })

  it('answers 404 for a version that never existed', async () => {
    await seedProject(aliceUid, 'nothing')

    expect((await restore('nothing', 'nosuchversion')).status).toBe(404)
  })

  it('answers 400 invalid_id for a malformed project id, before any read', async () => {
    const res = await restore('not%20an%20id', 'whatever')

    expect(res.status).toBe(400)
    expect(codeOf(res)).toBe('invalid_id')
  })

  /*
   * P1. A malformed version id and a malformed project id are two failures one
   * segment apart; they share a status and a code and **not** a sentence, so a
   * caller who mistyped the version is not told they mistyped the project.
   */
  it('answers 400 invalid_id for a malformed version id, in its own words', async () => {
    await seedProject(aliceUid, 'malformed')

    const res = await restore('malformed', 'a%2Fb')

    expect(res.status).toBe(400)
    expect(codeOf(res)).toBe('invalid_id')
    expect((res.body as { error: string }).error).toBe('That version could not be found.')
  })
})

/**
 * AC-18 — `FILE_LIMIT` is never exceeded at any point.
 *
 * Because the writes and the deletes are in one batch, the union state — 20 old
 * plus 20 new — never exists. A restore that deleted in a second commit would
 * pass through 40 files, and a crash between the two would leave it there.
 */
describe('a full restore over a full project (AC-18)', () => {
  it('ends with exactly the version’s twenty files', async () => {
    await seedProject(aliceUid, 'twenty')
    const snapshotRef = adminDb().collection(`users/${aliceUid}/projects/twenty/snapshots`).doc()
    await snapshotRef.set({
      seq: 1,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      origin: 'generation',
      fileCount: 20,
      totalBytes: 20,
    })
    for (let index = 0; index < 20; index += 1) {
      const path = `old-${String(index).padStart(2, '0')}.js`
      await adminDb()
        .doc(`users/${aliceUid}/projects/twenty/files/${path}`)
        .set({
          path,
          content: 'x',
          size: 1,
          createdAt: Timestamp.fromMillis(1_700_000_000_000),
          updatedAt: Timestamp.fromMillis(1_700_000_000_000),
        })
      const copied = `new-${String(index).padStart(2, '0')}.js`
      await snapshotRef.collection('files').doc(copied).set({ path: copied, content: 'y', size: 1 })
    }

    const res = await restore('twenty', snapshotRef.id)

    expect(res.status).toBe(200)
    const live = await storedFiles(aliceUid, 'twenty')
    expect(live).toHaveLength(20)
    expect(live.every((file) => file.path.startsWith('new-'))).toBe(true)
  })
})

/** AC-19's behavioural half — the guards, and the body that must not be there. */
describe('the restore route’s guards (AC-19)', () => {
  it('answers 401 without an Authorization header', async () => {
    await seedProject(aliceUid, 'guarded')

    const res = await restore('guarded', 'someversion', null)

    expect(res.status).toBe(401)
    expect(codeOf(res)).toBe('unauthenticated')
  })

  it('answers 403 for an unverified address', async () => {
    const unverified = 'gensnap-unverified-restore@example.test'
    await seedUser(unverified, PASSWORD, false)
    await seedProject(aliceUid, 'guarded')

    const res = await restore('guarded', 'someversion', await idTokenFor(unverified, PASSWORD))

    expect(res.status).toBe(403)
    expect(codeOf(res)).toBe('email_unverified')
  })

  /*
   * The version to restore is named by the URL, so there is nothing for a caller
   * to say in a body — and a route that ignored one would be a route where a
   * later field could be smuggled past review.
   */
  it('answers 400 invalid_body for a request carrying anything at all', async () => {
    const versions = await twoVersions('bodied')
    const before = await storedFiles(aliceUid, 'bodied')

    const res = await postJson(
      `${listPath('bodied')}/${versions[0]?.id ?? ''}/restore`,
      { snapshotId: versions[1]?.id },
      auth(aliceToken),
    )

    expect(res.status).toBe(400)
    expect(codeOf(res)).toBe('invalid_body')
    expect(await storedFiles(aliceUid, 'bodied')).toEqual(before)
  })

  it('accepts an empty JSON object, which is what a bodyless request parses as', async () => {
    const versions = await twoVersions('emptybody')

    const res = await postJson(
      `${listPath('emptybody')}/${versions[0]?.id ?? ''}/restore`,
      {},
      auth(aliceToken),
    )

    expect(res.status).toBe(200)
  })
})
