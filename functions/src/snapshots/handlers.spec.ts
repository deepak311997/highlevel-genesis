import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  WriteBatch,
} from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getDb = vi.hoisted(() => vi.fn())

// Hoisted above the imports below by Vitest, so `handlers` closes over the fake.
vi.mock('../lib/firebase', () => ({ getDb }))

import { parseSnapshotFile, planSnapshot, stageSnapshot, type SnapshotPlan } from './handlers'
import { SNAPSHOT_LIMIT } from './schema'
import type { FileWrite } from '../files/schema'

/**
 * AC-9 and AC-5's `id === path` half — the staging shape, the prune, and the one
 * read that plans them.
 *
 * `getDb` is mocked rather than an emulator started, because what is worth
 * asserting here is the *documents* — decided before any I/O happens — and the
 * prune's two deletes, which is the part R4 says is easy to get wrong: deleting
 * a snapshot leaves its `files` subcollection behind, unreachable and paid for.
 * The write reaching Firestore at all is T8's L4 case.
 */

/** A ref that knows its own path and can reach its subcollection, like a real one. */
function fakeRef(path: string): DocumentReference {
  return {
    id: path.slice(path.lastIndexOf('/') + 1),
    path,
    collection: (name: string) =>
      ({
        doc: (id: string) => fakeRef(`${path}/${name}/${id}`),
      }) as unknown as CollectionReference,
  } as unknown as DocumentReference
}

/** A batch that records what was staged and what was deleted, in order. */
function recordingBatch(): {
  batch: WriteBatch
  staged: { path: string; data: Record<string, unknown> }[]
  deleted: string[]
} {
  const staged: { path: string; data: Record<string, unknown> }[] = []
  const deleted: string[] = []
  const batch = {
    set(ref: { path: string }, data: Record<string, unknown>) {
      staged.push({ path: ref.path, data })
      return this
    },
    delete(ref: { path: string }) {
      deleted.push(ref.path)
      return this
    },
  }
  return { batch: batch as unknown as WriteBatch, staged, deleted }
}

const file = (path: string, content: string): FileWrite => ({
  path,
  content,
  size: Buffer.byteLength(content, 'utf8'),
})

/**
 * A Firestore whose snapshots collection answers the head read and mints ids,
 * and whose pruned snapshots list their file refs.
 *
 * `heads` is what the collection already holds. `fileIds` is what the *lowest*
 * of them holds in its `files` subcollection — the one a prune would take.
 */
function fakeDb(
  heads: { id: string; seq: number }[],
  fileIds: string[] = [],
): { calls: { orderBy: unknown[][]; select: unknown[][]; limited: boolean } } {
  const calls = { orderBy: [] as unknown[][], select: [] as unknown[][], limited: false }

  const snapshot = {
    docs: heads.map((head) => ({
      id: head.id,
      ref: fakeRef(`users/alice/projects/proj-1/snapshots/${head.id}`),
      data: () => ({ seq: head.seq }),
      get: (field: string) => (field === 'seq' ? head.seq : undefined),
    })),
  }

  getDb.mockReturnValue({
    collection: (path: string) => ({
      orderBy: (...args: unknown[]) => {
        calls.orderBy.push(args)
        return {
          select: (...fields: unknown[]) => {
            calls.select.push(fields)
            return { get: () => Promise.resolve(snapshot) }
          },
          limit: () => {
            calls.limited = true
            return { select: () => ({ get: () => Promise.resolve(snapshot) }) }
          },
        }
      },
      // No argument: an auto-id, minted locally.
      doc: (id?: string) => fakeRef(`${path}/${id ?? 'snap-new'}`),
    }),
  })

  // Every pruned snapshot's file refs come from `listDocuments()`, which returns
  // references without reading a byte of the documents behind them.
  for (const doc of snapshot.docs) {
    Object.assign(doc.ref, {
      collection: (name: string) =>
        ({
          doc: (id: string) => fakeRef(`${doc.ref.path}/${name}/${id}`),
          listDocuments: () =>
            Promise.resolve(fileIds.map((id) => fakeRef(`${doc.ref.path}/${name}/${id}`))),
        }) as unknown as CollectionReference,
    })
  }

  return { calls }
}

const heads = (count: number): { id: string; seq: number }[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `snap-${String(index + 1)}`,
    seq: index + 1,
  }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('planSnapshot', () => {
  /*
   * P3. The head read carries **no `limit()`**, deliberately: `planSnapshotPrune`
   * has to be able to see an already-broken invariant (22 heads prune three), and
   * a capped read would hide exactly the rows it needs. The collection is bounded
   * to ~20 by the prune itself, and `select('seq')` asks for refs and one number
   * rather than twenty documents.
   */
  it('reads the heads once, ordered by seq, projected to seq alone and uncapped', async () => {
    const { calls } = fakeDb(heads(3))

    await planSnapshot('alice', 'proj-1', [file('index.html', '<p>hi</p>')], 'generation')

    expect(calls.orderBy).toEqual([['seq', 'asc']])
    expect(calls.select).toEqual([['seq']])
    expect(calls.limited).toBe(false)
  })

  it('mints an auto-id under the project’s snapshots collection', async () => {
    fakeDb([])

    const plan = await planSnapshot('alice', 'proj-1', [file('a.js', 'x')], 'generation')

    expect(plan.ref.path).toBe('users/alice/projects/proj-1/snapshots/snap-new')
  })

  it('carries the next seq, the origin and the files it was handed', async () => {
    fakeDb(heads(3))
    const files = [file('a.js', 'x'), file('index.html', '<p>hi</p>')]

    const plan = await planSnapshot('alice', 'proj-1', files, 'restore')

    expect(plan.seq).toBe(4)
    expect(plan.origin).toBe('restore')
    expect(plan.files).toEqual(files)
  })

  it('prunes nothing while the collection is under the cap', async () => {
    fakeDb(heads(SNAPSHOT_LIMIT - 1))

    const plan = await planSnapshot('alice', 'proj-1', [file('a.js', 'x')], 'generation')

    expect(plan.prune).toEqual([])
  })

  /*
   * R4. The file refs are gathered here rather than derived at staging time,
   * because deleting a document in Firestore does **not** delete its
   * subcollections — a prune that removed only the parent would leave up to
   * twenty orphaned documents per pruned version.
   */
  it('carries the lowest snapshot’s ref and every one of its file refs at the cap', async () => {
    fakeDb(heads(SNAPSHOT_LIMIT), ['app.js', 'index.html'])

    const plan = await planSnapshot('alice', 'proj-1', [file('a.js', 'x')], 'generation')

    expect(plan.prune).toHaveLength(1)
    expect(plan.prune[0]?.ref.path).toBe('users/alice/projects/proj-1/snapshots/snap-1')
    expect(plan.prune[0]?.fileRefs.map((ref) => ref.path)).toEqual([
      'users/alice/projects/proj-1/snapshots/snap-1/files/app.js',
      'users/alice/projects/proj-1/snapshots/snap-1/files/index.html',
    ])
  })
})

describe('stageSnapshot', () => {
  const plan = (overrides: Partial<SnapshotPlan> = {}): SnapshotPlan => ({
    ref: fakeRef('users/alice/projects/proj-1/snapshots/snap-new'),
    seq: 2,
    origin: 'generation',
    files: [file('index.html', '<h1>x</h1>\n'), file('app.js', 'const a = 1\n')],
    prune: [],
    ...overrides,
  })

  it('stages the snapshot document with its five fields', () => {
    const { batch, staged } = recordingBatch()

    stageSnapshot(batch, plan())

    const document = staged[0]
    expect(document?.path).toBe('users/alice/projects/proj-1/snapshots/snap-new')
    expect(Object.keys(document?.data ?? {}).sort()).toEqual([
      'createdAt',
      'fileCount',
      'origin',
      'seq',
      'totalBytes',
    ])
    expect(document?.data['seq']).toBe(2)
    expect(document?.data['origin']).toBe('generation')
    expect(document?.data['fileCount']).toBe(2)
  })

  /* Summed from the files' own `size`, which is the number the validator measured. */
  it('sums totalBytes from the copied files', () => {
    const { batch, staged } = recordingBatch()

    stageSnapshot(batch, plan())

    expect(staged[0]?.data['totalBytes']).toBe(11 + 12)
  })

  it('stamps createdAt with a server sentinel', () => {
    const { batch, staged } = recordingBatch()

    stageSnapshot(batch, plan())

    expect(staged[0]?.data['createdAt']).toBeInstanceOf(FieldValue.serverTimestamp().constructor)
  })

  /** AC-5. The id *is* the path, exactly as the live collection's is (D13). */
  it('stages one file document per file, at an id equal to its path', () => {
    const { batch, staged } = recordingBatch()

    stageSnapshot(batch, plan())

    expect(staged.slice(1).map((entry) => entry.path)).toEqual([
      'users/alice/projects/proj-1/snapshots/snap-new/files/index.html',
      'users/alice/projects/proj-1/snapshots/snap-new/files/app.js',
    ])
  })

  /*
   * No timestamps: the snapshot's own `createdAt` is the one time that means
   * anything about a copy, so a per-file one would be twenty repetitions of one
   * fact.
   */
  it('writes a copied file as path, content and size, and nothing else', () => {
    const { batch, staged } = recordingBatch()

    stageSnapshot(batch, plan())

    expect(Object.keys(staged[1]?.data ?? {}).sort()).toEqual(['content', 'path', 'size'])
    expect(staged[1]?.data['content']).toBe('<h1>x</h1>\n')
    expect(staged[1]?.data['size']).toBe(11)
  })

  /** R4 — the parent **and** every file, because a delete does not cascade. */
  it('deletes every pruned snapshot’s file documents as well as the snapshot', () => {
    const { batch, deleted } = recordingBatch()
    const pruned = fakeRef('users/alice/projects/proj-1/snapshots/snap-1')

    stageSnapshot(
      batch,
      plan({
        prune: [
          {
            ref: pruned,
            fileRefs: [
              fakeRef(`${pruned.path}/files/app.js`),
              fakeRef(`${pruned.path}/files/index.html`),
            ],
          },
        ],
      }),
    )

    expect(deleted).toEqual([
      'users/alice/projects/proj-1/snapshots/snap-1/files/app.js',
      'users/alice/projects/proj-1/snapshots/snap-1/files/index.html',
      'users/alice/projects/proj-1/snapshots/snap-1',
    ])
  })

  it('deletes nothing when there is nothing to prune', () => {
    const { batch, deleted } = recordingBatch()

    stageSnapshot(batch, plan())

    expect(deleted).toEqual([])
  })

  /** Nothing is committed here: the batch belongs to whoever passed it in (D4). */
  it('does not commit the batch it was handed', () => {
    let commits = 0
    const batch = {
      set() {
        return this
      },
      delete() {
        return this
      },
      commit() {
        commits += 1
        return Promise.resolve([])
      },
    } as unknown as WriteBatch

    stageSnapshot(batch, plan())

    expect(commits).toBe(0)
  })
})

/** Only the three members `parseSnapshotFile` touches. */
const snapshot = (id: string, exists: boolean, data: unknown): DocumentSnapshot =>
  ({ exists, id, data: () => data }) as unknown as DocumentSnapshot

describe('parseSnapshotFile', () => {
  const STORED = { path: 'index.html', content: '<h1>x</h1>\n', size: 11 }

  it('returns the parsed document when it is usable', () => {
    expect(parseSnapshotFile(snapshot('index.html', true, STORED))?.content).toBe('<h1>x</h1>\n')
  })

  /**
   * AC-5's second half. `id === path` is what makes a copy addressable by the
   * name it is filed under; a document where they disagree cannot be written back
   * to the right file, so it is *known* to be unusable — and a restore that met
   * one refuses the whole version rather than restoring a file under the wrong
   * name.
   */
  it('refuses and logs a document whose path disagrees with its id', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseSnapshotFile(snapshot('app.js', true, STORED))).toBeNull()

    const logged = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(logged['event']).toBe('snapshot.unreadable')
    expect(logged['outcome']).toBe('invalid')
  })

  it.each([
    ['no content', { path: 'index.html', size: 11 }],
    ['no size', { path: 'index.html', content: 'x' }],
    ['a path that is not a storable filename', { path: '../secrets.js', content: 'x', size: 1 }],
  ])('refuses and logs a document with %s', (_label, data) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseSnapshotFile(snapshot('index.html', true, data))).toBeNull()

    expect(info).toHaveBeenCalledTimes(1)
  })

  /* A copied file is the user's own application, so no field of it reaches a log. */
  it('puts no field of the document in the log line', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    parseSnapshotFile(snapshot('app.js', true, { ...STORED, content: 'const key = "sk-secret"' }))

    expect(String(info.mock.calls[0]?.[0])).not.toContain('sk-secret')
  })

  it('returns null without logging for an absent document', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseSnapshotFile(snapshot('index.html', false, undefined))).toBeNull()

    expect(info).not.toHaveBeenCalled()
  })
})
