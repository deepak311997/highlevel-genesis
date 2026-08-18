import type { CollectionReference, DocumentSnapshot, WriteBatch } from 'firebase-admin/firestore'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getDb = vi.hoisted(() => vi.fn())

// Hoisted above the imports below by Vitest, so `handlers` closes over the fake.
vi.mock('../lib/firebase', () => ({ getDb }))

import {
  parseStoredFile,
  planFileWrites,
  readProjectFiles,
  readStoredFiles,
  requireFilePath,
  stageFileWrites,
  type FileWritePlan,
} from './handlers'
import { mergeSnapshotFiles } from '../snapshots/plan'
import { FILE_LIMIT, type StoredFile } from './schema'
import type { CollectResult } from '../llm/fileops'

/**
 * The write path's document shape, and the two fail-closed reads around it.
 *
 * `getDb` is mocked rather than an emulator started, because what is worth
 * asserting here is the *document* — decided before any I/O happens — and the
 * create-versus-update split, which is what preserves `createdAt` when a second
 * generation rewrites a file. The write reaching Firestore at all is T11's L4
 * case, and so is the batch being atomic.
 */

/** A batch that records what was staged on it, and the refs it was handed. */
function recordingBatch(): {
  batch: WriteBatch
  staged: { path: string; data: Record<string, unknown>; options: unknown }[]
  commits: number
} {
  const staged: { path: string; data: Record<string, unknown>; options: unknown }[] = []
  const record = { staged, commits: 0 }
  const batch = {
    set(ref: { path: string }, data: Record<string, unknown>, options?: unknown) {
      staged.push({ path: ref.path, data, options })
      return this
    },
    commit() {
      record.commits += 1
      return Promise.resolve([])
    },
  }
  return { batch: batch as unknown as WriteBatch, ...record }
}

/** A Firestore whose `collection().doc()` yields refs that know their own path. */
function fakeDb(): { paths: string[] } {
  const paths: string[] = []
  getDb.mockReturnValue({
    collection: (path: string) => {
      paths.push(path)
      return {
        doc: (id: string) => ({ id, path: `${path}/${id}` }),
      } as unknown as CollectionReference
    },
  })
  return { paths }
}

const write = (path: string, content: string, exists: boolean): FileWritePlan => ({
  path,
  content,
  size: Buffer.byteLength(content, 'utf8'),
  exists,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stageFileWrites', () => {
  /** D13. The document id *is* the path, so a rewrite is a `set` with no query. */
  it('stages each file at a document id equal to its path, under the project', () => {
    const db = fakeDb()
    const { batch, staged } = recordingBatch()

    stageFileWrites(batch, 'alice', 'proj-1', [
      write('index.html', '<h1>x</h1>\n', false),
      write('app.js', 'const a = 1\n', false),
    ])

    expect(db.paths).toEqual(['users/alice/projects/proj-1/files'])
    expect(staged.map((entry) => entry.path)).toEqual([
      'users/alice/projects/proj-1/files/index.html',
      'users/alice/projects/proj-1/files/app.js',
    ])
  })

  it('writes the five fields of a new file', () => {
    fakeDb()
    const { batch, staged } = recordingBatch()

    stageFileWrites(batch, 'alice', 'proj-1', [write('index.html', '<h1>x</h1>\n', false)])

    const document = staged[0]?.data ?? {}
    expect(Object.keys(document).sort()).toEqual([
      'content',
      'createdAt',
      'path',
      'size',
      'updatedAt',
    ])
    expect(document['path']).toBe('index.html')
    expect(document['content']).toBe('<h1>x</h1>\n')
    expect(document['size']).toBe(11)
  })

  /*
   * AC-19. A rewrite carries **no `createdAt`** and merges, which is the whole of
   * "the same documents are updated": a plain `set` would replace the document
   * and reset the date the file was first generated.
   */
  it('omits createdAt and merges when the project already holds the path', () => {
    fakeDb()
    const { batch, staged } = recordingBatch()

    stageFileWrites(batch, 'alice', 'proj-1', [write('index.html', 'new\n', true)])

    expect(Object.keys(staged[0]?.data ?? {}).sort()).toEqual([
      'content',
      'path',
      'size',
      'updatedAt',
    ])
    expect(staged[0]?.options).toEqual({ merge: true })
  })

  /* A new file is written whole, so nothing from a previous shape can survive. */
  it('does not merge a file the project does not hold', () => {
    fakeDb()
    const { batch, staged } = recordingBatch()

    stageFileWrites(batch, 'alice', 'proj-1', [write('app.js', 'x\n', false)])

    expect(staged[0]?.options).toBeUndefined()
  })

  it('stamps both timestamps with server sentinels', () => {
    fakeDb()
    const { batch, staged } = recordingBatch()

    stageFileWrites(batch, 'alice', 'proj-1', [write('app.js', 'x\n', false)])

    const sentinel = FieldValue.serverTimestamp().constructor
    expect(staged[0]?.data['createdAt']).toBeInstanceOf(sentinel)
    expect(staged[0]?.data['updatedAt']).toBeInstanceOf(sentinel)
  })

  /* A prose-only turn stages nothing at all, and touches no collection. */
  it('stages nothing for an empty write list', () => {
    const db = fakeDb()
    const { batch, staged } = recordingBatch()

    stageFileWrites(batch, 'alice', 'proj-1', [])

    expect(staged).toEqual([])
    expect(db.paths).toEqual([])
  })
})

/** Only the three members `parseStoredFile` touches. */
function snapshot(id: string, exists: boolean, data: unknown): DocumentSnapshot {
  return { exists, id, data: () => data } as unknown as DocumentSnapshot
}

const STORED = {
  path: 'index.html',
  content: '<h1>x</h1>\n',
  size: 11,
  createdAt: Timestamp.fromMillis(1_700_000_000_000),
  updatedAt: Timestamp.fromMillis(1_700_000_100_000),
}

describe('parseStoredFile', () => {
  it('returns the parsed document when it is usable', () => {
    expect(parseStoredFile(snapshot('index.html', true, STORED))?.content).toBe('<h1>x</h1>\n')
  })

  /**
   * D13's invariant, asserted on parse rather than assumed.
   *
   * `id === path` is what makes the by-id read and the list agree about which
   * file is which. A document where they disagree is unreadable — omitted from
   * the list, 404 by id — and logged, which is the only warning anybody gets,
   * because from outside it is indistinguishable from a file that was never
   * generated.
   */
  it('refuses and logs a document whose path disagrees with its id', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseStoredFile(snapshot('app.js', true, STORED))).toBeNull()

    expect(info).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(logged['event']).toBe('file.unreadable')
    expect(logged['outcome']).toBe('invalid')
  })

  it.each([
    ['no content', { ...STORED, content: undefined }],
    ['no size', { ...STORED, size: undefined }],
    ['no createdAt', { ...STORED, createdAt: undefined }],
    ['a path that is not a storable filename', { ...STORED, path: '../secrets.js' }],
  ])('refuses and logs a document with %s', (_label, data) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseStoredFile(snapshot('index.html', true, data))).toBeNull()

    expect(info).toHaveBeenCalledTimes(1)
  })

  /*
   * No field of the document reaches the log line. A file is the user's own
   * application, and a log sink is a disclosure channel like any other —
   * `parseStored`'s rule, unchanged.
   */
  it('puts no field of the document in the log line', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    parseStoredFile(snapshot('app.js', true, { ...STORED, content: 'const apiKey = "sk-secret"' }))

    expect(String(info.mock.calls[0]?.[0])).not.toContain('sk-secret')
  })

  /* An absent document is not corruption, so it is not logged as such. */
  it('returns null without logging for an absent document', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseStoredFile(snapshot('index.html', false, undefined))).toBeNull()

    expect(info).not.toHaveBeenCalled()
  })
})

describe('requireFilePath', () => {
  const req = (path: unknown): Parameters<typeof requireFilePath>[0] =>
    ({ params: { path } }) as unknown as Parameters<typeof requireFilePath>[0]

  it('returns a storable filename', () => {
    expect(requireFilePath(req('index.html'))).toBe('index.html')
  })

  /*
   * Called as the **first statement** of every handler that takes one, so a
   * refused path costs no Firestore call at all — `requireProjectId`'s rule.
   * Express percent-decodes `:path`, so `%2e%2e%2fsecrets.js` arrives here as
   * `../secrets.js` and is refused as the filename it is not.
   */
  it.each(['../secrets.js', 'a/b.js', 'A.html', 'app.ts', '..', '', undefined, 42])(
    'refuses %s with 400 invalid_path',
    (path) => {
      expect(() => requireFilePath(req(path))).toThrow(
        expect.objectContaining({ status: 400, code: 'invalid_path' }),
      )
    },
  )

  /* A malformed path and a stranger's file read the same to the caller. */
  it('describes the outcome rather than the rule', () => {
    expect(() => requireFilePath(req('A.html'))).toThrow('That file could not be found.')
  })
})

/**
 * A Firestore whose one collection answers a `orderBy → limit → get` chain,
 * recording the links so the query's shape is asserted rather than assumed.
 *
 * The chain is what changed in Slice 11 (D14): the read used to be `limit →
 * select()`, which returns ≤20 refs and no field data. It now returns the
 * documents, because one read has to answer three questions — is the union
 * within `FILE_LIMIT`, which of the turn's writes are rewrites, and what is the
 * project's file set for the snapshot to copy.
 */
function fakeQuery(docs: { id: string; data: unknown }[]): {
  calls: { collection: string; orderBy: unknown[]; limit: number | null }
} {
  const calls: { collection: string; orderBy: unknown[]; limit: number | null } = {
    collection: '',
    orderBy: [],
    limit: null,
  }

  const snapshot = { docs: docs.map((doc) => ({ exists: true, id: doc.id, data: () => doc.data })) }

  getDb.mockReturnValue({
    collection: (path: string) => {
      calls.collection = path
      return {
        orderBy: (field: string) => {
          calls.orderBy.push(field)
          return {
            limit: (count: number) => {
              calls.limit = count
              return { get: () => Promise.resolve(snapshot) }
            },
          }
        },
      }
    },
  })

  return { calls }
}

const stored = (path: string, content: string): { id: string; data: StoredFile } => ({
  id: path,
  data: {
    path,
    content,
    size: Buffer.byteLength(content, 'utf8'),
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    updatedAt: Timestamp.fromMillis(1_700_000_100_000),
  },
})

/** A finished collection, with only the members `planFileWrites` reads. */
const collected = (
  ops: { path: string; content: string }[],
  unterminated: string | null = null,
): CollectResult => ({ messageText: 'prose', ops, unterminated, frames: [] })

describe('readStoredFiles', () => {
  /*
   * D30's rule, restated for a query that is no longer a projection: a single
   * `orderBy` is served by Firestore's automatic index, so this needs no entry in
   * `firestore.indexes.json` — stated because Slices 3 and 4 both paid for a
   * missing composite index and the emulator does not enforce them.
   */
  it('reads the project’s files ordered by path, capped at the file limit', async () => {
    const { calls } = fakeQuery([stored('index.html', '<p>hi</p>'), stored('app.js', 'let x')])

    await readStoredFiles('alice', 'proj-1')

    expect(calls.collection).toBe('users/alice/projects/proj-1/files')
    expect(calls.orderBy).toEqual(['path'])
    expect(calls.limit).toBe(FILE_LIMIT)
  })

  it('returns the parsed documents, content included', async () => {
    fakeQuery([stored('app.js', 'let x')])

    const files = await readStoredFiles('alice', 'proj-1')

    expect(files.map((file) => [file.path, file.content, file.size])).toEqual([
      ['app.js', 'let x', 5],
    ])
  })

  /*
   * P2. `readFilePaths` counted an unreadable document, because it counted refs
   * and never looked inside one. This reads the document, so a corrupt one is
   * *known* to be corrupt and is omitted — which the PRD argues for directly: a
   * copy of a document nothing can read would be a copy of nothing.
   *
   * Two consequences, both improvements and both deliberate: the `FILE_LIMIT`
   * union check counts one fewer, and a rewrite of a corrupt path is staged with
   * `exists: false`, so it is written whole and **repaired**.
   */
  it('omits a document that cannot be read, and logs it once', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    fakeQuery([stored('app.js', 'let x'), { id: 'index.html', data: { path: 'index.html' } }])

    const files = await readStoredFiles('alice', 'proj-1')

    expect(files.map((file) => file.path)).toEqual(['app.js'])
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('omits a document filed under an id that is not its path', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    fakeQuery([{ ...stored('app.js', 'let x'), id: 'other.js' }])

    expect(await readStoredFiles('alice', 'proj-1')).toEqual([])
  })
})

describe('planFileWrites', () => {
  /** AC-1's caller half — `resulting` is the project's set *after* this turn. */
  it('returns the merge of what is stored with what the turn wrote', async () => {
    const files = [stored('index.html', '<p>one</p>'), stored('app.js', 'let x')]
    fakeQuery(files)

    const outcome = await planFileWrites(
      'alice',
      'proj-1',
      collected([
        { path: 'index.html', content: '<p>two</p>' },
        { path: 'about.html', content: '<p>new</p>' },
      ]),
      true,
    )

    expect(outcome.resulting).toEqual(
      mergeSnapshotFiles(
        files.map((file) => file.data),
        outcome.writes.map(({ path, content, size }) => ({ path, content, size })),
      ),
    )
    // Spelled out as well as compared, so the test says what the merge is *for*:
    // the file the turn never mentioned is in the turn's resulting set.
    expect(outcome.resulting.map((file) => file.path)).toEqual([
      'about.html',
      'app.js',
      'index.html',
    ])
    expect(outcome.resulting.find((file) => file.path === 'app.js')?.content).toBe('let x')
  })

  it('marks a rewrite as existing and a new file as not', async () => {
    fakeQuery([stored('index.html', '<p>one</p>')])

    const outcome = await planFileWrites(
      'alice',
      'proj-1',
      collected([
        { path: 'index.html', content: '<p>two</p>' },
        { path: 'about.html', content: '<p>new</p>' },
      ]),
      true,
    )

    expect(outcome.writes.map((write) => [write.path, write.exists])).toEqual([
      ['index.html', true],
      ['about.html', false],
    ])
  })

  /*
   * D2, AC-1's third clause. A prose-only turn reads nothing at all — no cap to
   * check, nothing to write, and therefore no snapshot to plan. The read never
   * happening is the assertion: `getDb` is left un-stubbed, so a call would
   * throw rather than quietly return a fake.
   */
  it('issues no read and resolves to an empty resulting set for a prose-only turn', async () => {
    getDb.mockImplementation(() => {
      throw new Error('planFileWrites read Firestore for a turn that wrote no files')
    })

    const outcome = await planFileWrites('alice', 'proj-1', collected([]), true)

    expect(outcome).toEqual({ writes: [], resulting: [], error: null })
  })

  it.each([
    ['an unterminated block', collected([{ path: 'a.js', content: 'x' }], 'a.js'), true],
    ['a turn that did not complete', collected([{ path: 'a.js', content: 'x' }]), false],
  ])('resolves to an empty resulting set for %s', async (_label, result, completed) => {
    getDb.mockImplementation(() => {
      throw new Error('planFileWrites read Firestore for a turn that stores nothing')
    })

    const outcome = await planFileWrites('alice', 'proj-1', result, completed)

    expect(outcome.resulting).toEqual([])
    expect(outcome.error).not.toBeNull()
  })

  /*
   * A refusal decided *after* the read — the set is validated against what the
   * project already holds — so this one cannot assert the absence of a call. What
   * it asserts is the thing a caller acts on: nothing is written, so there is no
   * resulting set to snapshot.
   */
  it('resolves to an empty resulting set for a refused op set', async () => {
    fakeQuery([stored('index.html', '<p>one</p>')])

    const outcome = await planFileWrites(
      'alice',
      'proj-1',
      collected([{ path: '../secrets.js', content: 'x' }]),
      true,
    )

    expect(outcome).toEqual({
      writes: [],
      resulting: [],
      error: { reason: 'path', path: '../secrets.js' },
    })
  })
})

/** What one query asked Firestore for, so the shape of the read is assertable. */
interface RecordedQuery {
  collection: string | null
  orderBy: string | null
  limit: number | null
}

/**
 * A Firestore whose one collection answers `orderBy(...).limit(n).get()` with the
 * documents it was handed, recording the query it was asked for.
 *
 * It deliberately carries **no `select`** (D26). `readProjectFiles` is the reader
 * that must *not* project — the content is the whole point of it — so a
 * `select(...)` creeping in fails here as a missing method rather than as a
 * silently thinner document that would only show up as a Zod failure.
 */
function fakeFileQuery(docs: readonly DocumentSnapshot[]): RecordedQuery {
  const recorded: RecordedQuery = { collection: null, orderBy: null, limit: null }

  getDb.mockReturnValue({
    collection: (path: string) => {
      recorded.collection = path
      return {
        orderBy: (field: string) => {
          recorded.orderBy = field
          return {
            limit: (count: number) => {
              recorded.limit = count
              return { get: () => Promise.resolve({ docs }) }
            },
          }
        },
      } as unknown as CollectionReference
    },
  })

  return recorded
}

/** A storable document, sized the way the writer would have sized it. */
function storedFile(path: string, content: string): Record<string, unknown> {
  return {
    path,
    content,
    size: Buffer.byteLength(content, 'utf8'),
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    updatedAt: Timestamp.fromMillis(1_700_000_100_000),
  }
}

/**
 * The second reader — the one that carries `content` (D26, AC-14, AC-27).
 *
 * `readFileList` is a projection on purpose, so widening it would ship 20 × 100 KB
 * of code to every workspace that merely opens a file tree. This is a separate
 * read answering a separate question: what the model is shown as the project's
 * current state. What it must share with the list is the ordering, the cap and
 * the fail-closed handling of a document that cannot describe a file — asserted
 * here, because the two drifting apart would mean the tree and the prompt
 * disagreeing about which files a project holds.
 */
describe('readProjectFiles', () => {
  it('returns each file with its content, ordered by path under the project', async () => {
    const recorded = fakeFileQuery([
      snapshot('app.js', true, storedFile('app.js', 'const a = 1\n')),
      snapshot('index.html', true, storedFile('index.html', '<h1>x</h1>\n')),
      snapshot('styles.css', true, storedFile('styles.css', 'body{}\n')),
    ])

    const files = await readProjectFiles('alice', 'proj-1')

    expect(files.map((file) => file.path)).toEqual(['app.js', 'index.html', 'styles.css'])
    expect(files.map((file) => file.content)).toEqual(['const a = 1\n', '<h1>x</h1>\n', 'body{}\n'])
    expect(recorded.collection).toBe('users/alice/projects/proj-1/files')
    expect(recorded.orderBy).toBe('path')
  })

  /*
   * The same cap as the list, and for the same reason: `FILE_LIMIT` is the most
   * a project may hold, so "you are seeing every file" is a guarantee rather than
   * a hope — and the prompt cannot be handed a page of a project.
   */
  it('asks for at most FILE_LIMIT documents', async () => {
    const recorded = fakeFileQuery([snapshot('app.js', true, storedFile('app.js', 'x\n'))])

    await readProjectFiles('alice', 'proj-1')

    expect(recorded.limit).toBe(FILE_LIMIT)
  })

  /*
   * D13, fail closed. Two ways a document stops describing a file: it does not
   * parse, or its id and its `path` disagree — the second is this collection's
   * own invariant, since the id *is* the path. Either way the document is known
   * to be unusable, so it is omitted and logged once, and the rest of the project
   * still reaches the model. The alternative — refusing the whole read — would
   * let one corrupt document take a project's generations down with it.
   */
  it('skips and logs an unparseable document and an id/path mismatch, returning the rest', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    fakeFileQuery([
      snapshot('app.js', true, storedFile('app.js', 'const a = 1\n')),
      // Missing `size`, so `storedFileSchema` refuses it outright.
      snapshot('broken.js', true, { ...storedFile('broken.js', 'x\n'), size: undefined }),
      // Parses, but is filed under a name it does not claim.
      snapshot('elsewhere.js', true, storedFile('styles.css', 'body{}\n')),
      snapshot('index.html', true, storedFile('index.html', '<h1>x</h1>\n')),
    ])

    const files = await readProjectFiles('alice', 'proj-1')

    expect(files.map((file) => file.path)).toEqual(['app.js', 'index.html'])
    expect(info).toHaveBeenCalledTimes(2)
    const events = info.mock.calls.map(
      (call) => (JSON.parse(String(call[0])) as Record<string, unknown>)['event'],
    )
    expect(events).toEqual(['file.unreadable', 'file.unreadable'])
  })

  /* A file is the user's own application, so no field of it reaches a log sink —
   * `parseStoredFile`'s rule, restated on the reader that carries content. */
  it('puts no field of an unreadable document in the log line', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    fakeFileQuery([snapshot('elsewhere.js', true, storedFile('app.js', 'const key = "sk-secret"'))])

    await readProjectFiles('alice', 'proj-1')

    expect(String(info.mock.calls[0]?.[0])).not.toContain('sk-secret')
  })

  /* An empty project is not an error: it is the first prompt in a new project,
   * and it is what makes `buildProjectState` return no block at all (AC-13). */
  it('returns an empty list for a project holding no files', async () => {
    fakeFileQuery([])

    expect(await readProjectFiles('alice', 'proj-1')).toEqual([])
  })
})
