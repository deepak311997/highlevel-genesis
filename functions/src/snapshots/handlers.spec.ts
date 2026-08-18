import type { Request, Response } from 'express'
import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  WriteBatch,
} from 'firebase-admin/firestore'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getDb = vi.hoisted(() => vi.fn())

// Hoisted above the imports below by Vitest, so `handlers` closes over the fake.
vi.mock('../lib/firebase', () => ({ getDb }))

import {
  handleRestoreSnapshot,
  parseSnapshotFile,
  planSnapshot,
  stageSnapshot,
  type SnapshotPlan,
} from './handlers'
import { RESTORE_FAILED, SNAPSHOT_LIMIT } from './schema'
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
  heads: { id: string; seq?: number }[],
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

  const select = (...fields: unknown[]) => {
    calls.select.push(fields)
    return { get: () => Promise.resolve(snapshot) }
  }

  getDb.mockReturnValue({
    collection: (path: string) => ({
      // Reachable straight off the collection, because the head read carries no
      // `orderBy` — an `orderBy('seq')` would drop the seq-less head this fake
      // can now model.
      select,
      orderBy: (...args: unknown[]) => {
        calls.orderBy.push(args)
        return {
          select,
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
  it('reads the heads once, projected to seq alone, unordered and uncapped', async () => {
    const { calls } = fakeDb(heads(3))

    await planSnapshot('alice', 'proj-1', [file('index.html', '<p>hi</p>')], 'generation')

    /*
     * **No `orderBy`.** Firestore omits a document that does not carry the
     * ordered field, so ordering by `seq` here would hide the one head the
     * prune most needs to see — a snapshot whose `seq` is gone, which would
     * otherwise be invisible to this read and to the list, never counted toward
     * the excess and never pruned. Neither consumer needs the order:
     * `planSnapshotSeq` takes a maximum, `planSnapshotPrune` sorts its input.
     */
    expect(calls.orderBy).toEqual([])
    expect(calls.select).toEqual([['seq']])
    expect(calls.limited).toBe(false)
  })

  /*
   * The other half of the same rule, and the reason the `orderBy` had to go: a
   * head with no `seq` at all is read as `0`, so it sorts to the front of the
   * prune and is the first version taken. A version nothing can name is a
   * version nothing can restore; leaving it in place would leak it and its file
   * documents forever (R4).
   */
  it('reads a head with no seq as 0, and prunes it first', async () => {
    fakeDb([{ id: 'orphan' }, ...heads(SNAPSHOT_LIMIT - 1)], ['app.js'])

    const plan = await planSnapshot('alice', 'proj-1', [file('a.js', 'x')], 'generation')

    expect(plan.prune.map((pruned) => pruned.ref.path)).toEqual([
      'users/alice/projects/proj-1/snapshots/orphan',
    ])
    expect(plan.prune[0]?.fileRefs.map((ref) => ref.path)).toEqual([
      'users/alice/projects/proj-1/snapshots/orphan/files/app.js',
    ])
    // And it does not take the numbering with it: `seq` is still max + 1.
    expect(plan.seq).toBe(SNAPSHOT_LIMIT)
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

/**
 * The restore's batch — AC-18's unasserted clause, and R5 one collection over.
 *
 * `handleRestoreSnapshot` stages the safety snapshot, the version's file writes
 * and the deletes of everything the version does not hold, then commits **once**.
 * Nothing tested that. AC-9's recording batch covers the *generation* path only,
 * and the L4 case for AC-18 sees the end state alone — so splitting the restore
 * into a write commit and a delete commit, which is exactly the shortcut R5 names,
 * would leave the whole suite green while a full project passed transiently
 * through 40 files and a crash between the two commits left it there.
 *
 * A fake rather than the emulator, for AC-9's reason: what is worth asserting is
 * that there is **one** batch and **one** commit, and a recording batch is the
 * only thing that can say so.
 */
describe('handleRestoreSnapshot', () => {
  const TS = Timestamp.fromMillis(1_700_000_000_000)

  const storedFileDoc = (path: string, content: string) => ({
    id: path,
    exists: true,
    data: () => ({
      path,
      content,
      size: Buffer.byteLength(content, 'utf8'),
      createdAt: TS,
      updatedAt: TS,
    }),
  })

  const copyDoc = (path: string, content: string) => ({
    id: path,
    exists: true,
    data: () => ({ path, content, size: Buffer.byteLength(content, 'utf8') }),
  })

  /**
   * A Firestore that answers every read the restore makes, routed by path, and
   * hands out one recording batch.
   *
   * `batches` counts `getDb().batch()` calls and `commits` counts `commit()`s —
   * the two numbers the test is actually about. Everything else exists only so
   * the handler reaches the batch at all.
   */
  function restoreDb(options: {
    live: [string, string][]
    copies: [string, string][]
    commitFails?: boolean
  }) {
    const staged: { path: string; data: Record<string, unknown> }[] = []
    const deleted: string[] = []
    const record = { batches: 0, commits: 0, staged, deleted }

    const batch = {
      set(ref: { path: string }, data: Record<string, unknown>) {
        staged.push({ path: ref.path, data })
        return this
      },
      delete(ref: { path: string }) {
        deleted.push(ref.path)
        return this
      },
      commit() {
        record.commits += 1
        return options.commitFails === true
          ? Promise.reject(new Error('DEADLINE_EXCEEDED'))
          : Promise.resolve([])
      },
    }

    const liveDocs = options.live.map(([path, content]) => storedFileDoc(path, content))
    const copyDocs = options.copies.map(([path, content]) => copyDoc(path, content))

    const project = {
      exists: true,
      id: 'proj-1',
      data: () => ({
        name: 'Project',
        description: null,
        locationId: null,
        createdAt: TS,
        updatedAt: TS,
        deletedAt: null,
      }),
    }
    const version = {
      exists: true,
      id: 'snap-1',
      data: () => ({
        seq: 1,
        createdAt: TS,
        origin: 'generation',
        fileCount: options.copies.length,
        totalBytes: 0,
      }),
    }

    const get = (docs: unknown[]) => () => Promise.resolve({ docs })

    getDb.mockReturnValue({
      batch: () => {
        record.batches += 1
        return batch
      },
      doc: (path: string) => {
        if (path.endsWith('/snapshots/snap-1')) return { get: () => Promise.resolve(version) }
        if (path.includes('/files/')) return fakeRef(path)
        return { get: () => Promise.resolve(project) }
      },
      collection: (path: string) => {
        // The version's copies, read unordered.
        if (path.endsWith('/snapshots/snap-1/files')) {
          return { get: get(copyDocs), doc: (id: string) => fakeRef(`${path}/${id}`) }
        }
        // The heads read, and the auto-id for the safety snapshot.
        if (path.endsWith('/snapshots')) {
          return {
            select: () => ({ get: get([]) }),
            doc: (id?: string) => fakeRef(`${path}/${id ?? 'safety'}`),
          }
        }
        // The project's live files: `readStoredFiles`, then `readFileList`.
        return {
          doc: (id: string) => fakeRef(`${path}/${id}`),
          orderBy: () => ({
            limit: () => ({ get: get(liveDocs), select: () => ({ get: get(liveDocs) }) }),
          }),
        }
      },
    })

    return record
  }

  const req = {
    params: { projectId: 'proj-1', snapshotId: 'snap-1' },
    body: {},
  } as unknown as Request
  const res = { json: () => undefined } as unknown as Response

  it('stages the safety snapshot, the writes and the deletes on one batch, committed once', async () => {
    const db = restoreDb({
      // The project holds version 2: `index.html` rewritten, `about.html` added.
      live: [
        ['about.html', '<p>about</p>'],
        ['index.html', '<p>two</p>'],
      ],
      // The version being restored holds `index.html` alone, at version 1's bytes.
      copies: [['index.html', '<p>one</p>']],
    })

    await handleRestoreSnapshot(req, res, 'alice')

    expect(db.batches).toBe(1)
    expect(db.commits).toBe(1)

    /*
     * D9 first, then D7's two halves. The safety copy of the pre-restore set,
     * the version's file written back, and the file the version does not hold
     * deleted — all on the one batch above, so the union of the two file sets
     * never exists and `FILE_LIMIT` is never transiently exceeded (AC-18).
     */
    expect(db.staged.map((entry) => entry.path)).toEqual([
      'users/alice/projects/proj-1/snapshots/safety',
      'users/alice/projects/proj-1/snapshots/safety/files/about.html',
      'users/alice/projects/proj-1/snapshots/safety/files/index.html',
      'users/alice/projects/proj-1/files/index.html',
    ])
    expect(db.deleted).toEqual(['users/alice/projects/proj-1/files/about.html'])
  })

  /*
   * The PRD's copy table names a sentence for "the batch failed" — *That version
   * could not be restored. Try again.* — and `RESTORE_FAILED` was written to hold
   * it, then never wired to anything. An uncaught rejection reaches
   * `errorHandler` as a generic `Internal error`, which tells a user nothing
   * about what to do next and does not say the thing that matters most about an
   * all-or-nothing batch: nothing was written, so trying again is safe.
   */
  it('answers the restore’s own copy when the batch fails, rather than a generic 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    restoreDb({
      live: [['index.html', '<p>two</p>']],
      copies: [['index.html', '<p>one</p>']],
      commitFails: true,
    })

    await expect(handleRestoreSnapshot(req, res, 'alice')).rejects.toMatchObject({
      status: 500,
      message: RESTORE_FAILED,
    })
  })

  /* D10 — the project already *is* the version, so no batch is opened at all. */
  it('opens no batch at all when nothing would change', async () => {
    const db = restoreDb({
      live: [['index.html', '<p>one</p>']],
      copies: [['index.html', '<p>one</p>']],
    })

    await handleRestoreSnapshot(req, res, 'alice')

    expect(db.batches).toBe(0)
    expect(db.commits).toBe(0)
  })

  /*
   * D15's rule for ids, asserted where it is cheapest: a malformed id costs no
   * Firestore call at all. AC-17 says so in words and its L4 case is even named
   * for it, but asserts only the status — so `getDb` is left throwing here, and a
   * read of any kind is a red test.
   */
  it.each([
    ['project', { projectId: 'not an id', snapshotId: 'snap-1' }],
    ['version', { projectId: 'proj-1', snapshotId: 'a/b' }],
  ])('refuses a malformed %s id before any read', async (_which, params) => {
    getDb.mockImplementation(() => {
      throw new Error('read')
    })

    await expect(
      handleRestoreSnapshot({ params, body: {} } as unknown as Request, res, 'alice'),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_id' })
  })

  /* And a body, which is refused before anything reads for the same reason. */
  it('refuses a request carrying a body before any read', async () => {
    getDb.mockImplementation(() => {
      throw new Error('read')
    })

    await expect(
      handleRestoreSnapshot(
        {
          params: { projectId: 'proj-1', snapshotId: 'snap-1' },
          body: { seq: 1 },
        } as unknown as Request,
        res,
        'alice',
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_body' })
  })
})
