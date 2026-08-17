import type { CollectionReference, DocumentSnapshot, WriteBatch } from 'firebase-admin/firestore'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getDb = vi.hoisted(() => vi.fn())

// Hoisted above the imports below by Vitest, so `handlers` closes over the fake.
vi.mock('../lib/firebase', () => ({ getDb }))

import { parseStoredFile, requireFilePath, stageFileWrites, type FileWritePlan } from './handlers'

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
