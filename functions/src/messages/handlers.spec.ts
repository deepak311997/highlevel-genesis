import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Query,
  WriteBatch,
} from 'firebase-admin/firestore'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getDb = vi.hoisted(() => vi.fn())

// Hoisted above the imports below by Vitest, so `handlers` closes over the fake.
// The functions package is CommonJS, so a dynamic `await import` is not available
// here — which is fine: `vi.mock` is what does the work either way.
vi.mock('../lib/firebase', () => ({ getDb }))

import {
  appendAssistantMessage,
  parseStoredMessage,
  transcriptQuery,
  type AssistantTurn,
} from './handlers'
import type { SnapshotPlan } from '../snapshots/handlers'
import { MESSAGE_LIMIT } from './schema'

/**
 * The pure halves of the transcript read, plus the assistant write.
 *
 * `transcriptQuery` has a test of its own because of R1, which is the slice's one
 * real hazard and is invisible in production about half the time. A `WriteBatch`
 * resolves every `serverTimestamp()` in it to the *same* commit timestamp, so the
 * two messages of a turn are not nearly tied — they are exactly tied, on every
 * single turn. Firestore then falls through to its implicit `__name__` tiebreak,
 * and a document name here is a random auto-id, so the echo renders above the
 * prompt roughly half the time. The second `orderBy` is what stops that, and
 * deleting it would break nothing that any emulator-backed test could see
 * reliably. Asserting the call order here means it fails *here* instead.
 *
 * `parseStoredMessage` is the fail-closed step, and the log line is the part
 * worth an assertion: a corrupt message is otherwise **silent** by design — there
 * is no by-id read of a message, so omission is the whole behaviour, and the log
 * line is the only thing that says a document is broken rather than absent.
 */

const complete = {
  role: 'user',
  content: 'build a contact dashboard',
  seq: 0,
  createdAt: Timestamp.fromMillis(1_700_000_000_000),
}

/** Only the three members `parseStoredMessage` touches. */
function snapshot(exists: boolean, data: unknown): DocumentSnapshot {
  return { exists, id: 'msg-1', data: () => data } as unknown as DocumentSnapshot
}

/**
 * A query that records what was asked of it and hands itself back.
 *
 * The recording is what makes the *order* of the two `orderBy` calls assertable,
 * which is the whole point: a query with the fields the other way round compiles,
 * runs, and sorts the transcript by `seq` first — every user message above every
 * assistant one, across the entire history.
 */
function recordingQuery(): { query: Query; calls: string[] } {
  const calls: string[] = []
  const query = {
    orderBy(field: string, direction: string) {
      calls.push(`orderBy(${field},${direction})`)
      return this
    },
    limit(count: number) {
      calls.push(`limit(${String(count)})`)
      return this
    },
  }
  return { query: query as unknown as Query, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('transcriptQuery', () => {
  /** R1's regression guard, and AC-2's ordering in isolation. */
  it('orders by createdAt then seq, both ascending, and caps the read', () => {
    const { query, calls } = recordingQuery()

    transcriptQuery(query)

    expect(calls).toEqual([
      'orderBy(createdAt,asc)',
      'orderBy(seq,asc)',
      `limit(${String(MESSAGE_LIMIT)})`,
    ])
  })

  /*
   * The cap matches the collection's own limit, so "you are seeing the whole
   * conversation" is a guarantee rather than a hope — the same rule
   * `LIST_LIMIT` / `PROJECT_LIMIT` follow.
   */
  it('caps at exactly the number of messages a project may hold', () => {
    expect(MESSAGE_LIMIT).toBe(200)
  })

  it('returns the query so the call reads as a chain', () => {
    const { query } = recordingQuery()

    expect(transcriptQuery(query)).toBe(query)
  })
})

/**
 * A Firestore stand-in with exactly the four members the write path touches.
 *
 * `getDb` is mocked rather than an emulator started, because what is worth
 * asserting here is the *document* — and the document is decided before any I/O
 * happens. The write reaching Firestore at all is T10's L4 case.
 */
interface FakeDb {
  /** The assistant message's own document, as staged on the batch. */
  written: unknown
  path: string
  /** Every document staged, in order, with the collection it was staged into. */
  staged: { path: string; data: Record<string, unknown>; options: unknown }[]
  /** Every ref deleted, in order — the prune's two halves (R4). */
  deleted: string[]
  /** How many batches were created, and how many were committed. */
  batches: number
  commits: number
}

function fakeDb(stored: Record<string, unknown> | null): FakeDb {
  const record: FakeDb = {
    written: undefined,
    path: '',
    staged: [],
    deleted: [],
    batches: 0,
    commits: 0,
  }

  const message = {
    id: 'assistant-1',
    path: 'users/alice/projects/proj-1/messages/assistant-1',
    get: () =>
      Promise.resolve({
        exists: stored !== null,
        id: 'assistant-1',
        data: () => stored,
      } as unknown as DocumentSnapshot),
  }

  /*
   * One recorder per `batch()` call, so "the message and the files went into
   * **one** batch" is assertable rather than assumed — two batches would commit
   * separately and D11's atomicity would be gone with no test to notice.
   */
  const batch = {
    set(ref: { path: string }, data: Record<string, unknown>, options?: unknown) {
      record.staged.push({ path: ref.path, data, options })
      if (ref.path === message.path) record.written = data
      return this
    },
    // Recorded from Slice 11: the prune deletes, and AC-9 is the claim that it
    // does so on *this* batch rather than in a commit of its own.
    delete(ref: { path: string }) {
      record.deleted.push(ref.path)
      return this
    },
    commit() {
      record.commits += 1
      return Promise.resolve([])
    },
  }

  getDb.mockReturnValue({
    batch: () => {
      record.batches += 1
      return batch as unknown as WriteBatch
    },
    collection: (path: string) => {
      // The messages collection is the one this module composes; the files
      // collection is composed by `stageFileWrites`, which shares this fake.
      if (path.endsWith('/messages')) record.path = path
      return {
        doc: (id?: string) => (id === undefined ? message : { id, path: `${path}/${id}` }),
      } as unknown as CollectionReference
    },
  })

  return record
}

/** What the re-read hands back for a document that was written whole. */
function storedAssistant(truncated: boolean): Record<string, unknown> {
  return {
    role: 'assistant',
    content: 'Here is a contact dashboard',
    seq: 1,
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    truncated,
  }
}

/**
 * One assistant turn, with the three parts that vary defaulted (R10).
 *
 * The regrouping this helper exists for is the point of the task: the function
 * took four positional parameters and was about to take a fifth, at which point
 * `('alice', 'proj-1', text, false, [], null)` is a call nobody can read and a
 * `null` in the wrong slot is a type error only if two adjacent parameters
 * happen to have different types. An object says which is which.
 */
function turn(content: string, overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return { content, truncated: false, error: null, fileWrites: [], snapshot: null, ...overrides }
}

/** A ref that knows its own path and can reach its subcollection, like a real one. */
function fakeRef(path: string): DocumentReference {
  return {
    id: path.slice(path.lastIndexOf('/') + 1),
    path,
    collection: (name: string) =>
      ({ doc: (id: string) => fakeRef(`${path}/${name}/${id}`) }) as unknown as CollectionReference,
  } as unknown as DocumentReference
}

/**
 * A snapshot already planned — every ref minted, nothing left to read.
 *
 * That `stageSnapshot` needs no `getDb()` is what makes this a plain object
 * rather than a second Firestore fake (P4): the plan carries the new snapshot's
 * reference, and `DocumentReference.collection()` reaches its copied files.
 */
function snapshotPlan(overrides: Partial<SnapshotPlan> = {}): SnapshotPlan {
  return {
    ref: fakeRef('users/alice/projects/proj-1/snapshots/snap-new'),
    seq: 1,
    origin: 'generation',
    files: [{ path: 'index.html', content: '<h1>x</h1>\n', size: 11 }],
    prune: [],
    ...overrides,
  }
}

describe('appendAssistantMessage', () => {
  /*
   * AC-2, D35. `seq` is 1 and it is assigned here rather than derived: the
   * assistant turn is now written in a request of its own, so its `createdAt`
   * genuinely differs from the user message's — which is exactly what Slice 4's
   * D8 predicted. `seq` is belt and braces rather than the tiebreak it was, and
   * the transcript query still reads it, so it still has to be right.
   */
  it('writes the assistant document under the project, with seq 1', async () => {
    const db = fakeDb(storedAssistant(false))

    await appendAssistantMessage('alice', 'proj-1', turn('Here is a contact dashboard'))

    expect(db.path).toBe('users/alice/projects/proj-1/messages')
    const written = db.written as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual([
      'content',
      'createdAt',
      // Why the turn failed, or null — the field that lets the chat show a
      // failure instead of swallowing it.
      'error',
      'role',
      'seq',
      'truncated',
    ])
    expect(written['role']).toBe('assistant')
    expect(written['content']).toBe('Here is a contact dashboard')
    expect(written['seq']).toBe(1)
    expect(written['truncated']).toBe(false)
  })

  /* The commit timestamp is Firestore's, not ours — a sentinel, resolved on write. */
  it('stamps the document with a server timestamp sentinel', async () => {
    const db = fakeDb(storedAssistant(false))

    await appendAssistantMessage('alice', 'proj-1', turn('Here is a contact dashboard'))

    expect((db.written as Record<string, unknown>)['createdAt']).toBeInstanceOf(
      FieldValue.serverTimestamp().constructor,
    )
  })

  /** D21, D22, D23 all set the one flag, so the UI has one thing to render. */
  it('carries the truncated flag it was given into the document', async () => {
    const db = fakeDb(storedAssistant(true))

    await appendAssistantMessage(
      'alice',
      'proj-1',
      turn('Here is a contact dash', { truncated: true }),
    )

    expect((db.written as Record<string, unknown>)['truncated']).toBe(true)
  })

  /*
   * The wire shape, re-read rather than echoed back from what we wrote:
   * `serverTimestamp()` is a sentinel until it commits, so the committed
   * document is the only place the real timestamp exists — and the `done` frame
   * carries this object, so the client's id and date have to be the server's.
   */
  it('returns the committed document in wire shape, carrying no seq', async () => {
    fakeDb(storedAssistant(true))

    const message = await appendAssistantMessage(
      'alice',
      'proj-1',
      turn('Here is a contact dash', { truncated: true }),
    )

    expect(message).toEqual({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Here is a contact dashboard',
      createdAt: '2023-11-14T22:13:20.000Z',
      truncated: true,
      error: null,
    })
  })

  /*
   * Unreachable in practice — we have just written a complete document — but it
   * fails closed rather than answering a `done` frame describing a message that
   * cannot be read back.
   */
  it('fails closed when the document it just wrote will not parse', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    fakeDb({ role: 'assistant' })

    await expect(appendAssistantMessage('alice', 'proj-1', turn('hi'))).rejects.toThrow()
  })

  /**
   * D11, and the reason the batch exists at all.
   *
   * The message contains `[file: index.html]`; if that commits and the file does
   * not, the transcript is lying about the project's contents. One batch makes
   * the turn atomic — 21 writes at the cap, far inside Firestore's 500.
   */
  it('stages the message and every file into one batch, committed once', async () => {
    const db = fakeDb(storedAssistant(false))

    await appendAssistantMessage(
      'alice',
      'proj-1',
      turn('Here is a contact dashboard', {
        fileWrites: [
          { path: 'index.html', content: '<h1>x</h1>\n', size: 11, exists: false },
          { path: 'app.js', content: 'const a = 1\n', size: 12, exists: true },
        ],
      }),
    )

    expect(db.batches).toBe(1)
    expect(db.commits).toBe(1)
    expect(db.staged.map((entry) => entry.path)).toEqual([
      'users/alice/projects/proj-1/messages/assistant-1',
      'users/alice/projects/proj-1/files/index.html',
      'users/alice/projects/proj-1/files/app.js',
    ])
  })

  /* A prose-only turn still goes through the batch, carrying one document. */
  it('commits exactly one batch of one document when there are no files', async () => {
    const db = fakeDb(storedAssistant(false))

    await appendAssistantMessage('alice', 'proj-1', turn('Here is a contact dashboard'))

    expect(db.batches).toBe(1)
    expect(db.commits).toBe(1)
    expect(db.staged).toHaveLength(1)
  })

  /**
   * AC-9, and the whole of R5.
   *
   * Writing the snapshot in its own commit after the turn's is one line shorter
   * and leaves a crash window in which the project's files moved and its history
   * did not. The assertion is against a **recording batch**, so a second
   * `commit()` or a write that reached Firestore some other way is a red test
   * rather than something a reviewer has to notice.
   *
   * The worst case staged here is 63 writes — one message, twenty files, one
   * snapshot, twenty copied files, one pruned snapshot and its twenty — which is
   * comfortably inside Firestore's limit of 500.
   */
  it('stages the message, the files, the snapshot and its copies on one batch', async () => {
    const db = fakeDb(storedAssistant(false))

    await appendAssistantMessage(
      'alice',
      'proj-1',
      turn('Here is a contact dashboard', {
        fileWrites: [{ path: 'index.html', content: '<h1>x</h1>\n', size: 11, exists: false }],
        snapshot: snapshotPlan(),
      }),
    )

    expect(db.batches).toBe(1)
    expect(db.commits).toBe(1)
    expect(db.staged.map((entry) => entry.path)).toEqual([
      'users/alice/projects/proj-1/messages/assistant-1',
      'users/alice/projects/proj-1/files/index.html',
      'users/alice/projects/proj-1/snapshots/snap-new',
      'users/alice/projects/proj-1/snapshots/snap-new/files/index.html',
    ])
  })

  /** The prune's deletes are on the same batch as the writes they make room for. */
  it('stages the prune on that same batch, files first and the snapshot after', async () => {
    const db = fakeDb(storedAssistant(false))
    const pruned = fakeRef('users/alice/projects/proj-1/snapshots/snap-1')

    await appendAssistantMessage(
      'alice',
      'proj-1',
      turn('Here is a contact dashboard', {
        snapshot: snapshotPlan({
          prune: [{ ref: pruned, fileRefs: [fakeRef(`${pruned.path}/files/index.html`)] }],
        }),
      }),
    )

    expect(db.batches).toBe(1)
    expect(db.commits).toBe(1)
    expect(db.deleted).toEqual([
      'users/alice/projects/proj-1/snapshots/snap-1/files/index.html',
      'users/alice/projects/proj-1/snapshots/snap-1',
    ])
  })

  /* A turn that stored no files plans no snapshot, so nothing extra is staged. */
  it('stages nothing for the history when the turn carries no snapshot', async () => {
    const db = fakeDb(storedAssistant(false))

    await appendAssistantMessage('alice', 'proj-1', turn('Just prose.'))

    expect(db.staged).toHaveLength(1)
    expect(db.deleted).toEqual([])
  })

  /*
   * The re-read still happens, and still happens **after** the commit:
   * `serverTimestamp()` is a sentinel until then, so the committed document is
   * the only place the real timestamp exists.
   */
  it('answers with the committed message even when files were written', async () => {
    fakeDb(storedAssistant(false))

    const message = await appendAssistantMessage(
      'alice',
      'proj-1',
      turn('x', { fileWrites: [{ path: 'app.js', content: 'a\n', size: 2, exists: false }] }),
    )

    expect(message.id).toBe('assistant-1')
    expect(message.createdAt).toBe('2023-11-14T22:13:20.000Z')
  })
})

describe('parseStoredMessage', () => {
  it('returns the parsed document when it is usable', () => {
    expect(parseStoredMessage(snapshot(true, complete))?.content).toBe('build a contact dashboard')
  })

  /*
   * AC-15's log half. Each of the three corrupt shapes is a document that cannot
   * be rendered in the right place: no content is no message, no timestamp is no
   * date and no position, and a role outside the two has no side of the
   * transcript to sit on.
   */
  it.each([
    ['no content', { role: 'user', seq: 0, createdAt: complete.createdAt }],
    ['no createdAt', { role: 'user', content: 'hi', seq: 0 }],
    ['a role outside user/assistant', { ...complete, role: 'system' }],
  ])('logs message.unreadable and returns null for a document with %s', (_label, data) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseStoredMessage(snapshot(true, data))).toBeNull()

    expect(info).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(logged['event']).toBe('message.unreadable')
    expect(logged['outcome']).toBe('invalid')
  })

  /*
   * No field of the document reaches the log line. A message is the user's own
   * prose — from Slice 5 on it is also the model's — and a log sink is a
   * disclosure channel like any other. `parseStored`'s rule, unchanged.
   */
  it('puts no field of the document in the log line', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    parseStoredMessage(snapshot(true, { role: 'system', content: 'a secret the user typed' }))

    expect(String(info.mock.calls[0]?.[0])).not.toContain('a secret the user typed')
  })

  /* An absent document is not corruption, so it is not logged as such. */
  it('returns null without logging for an absent document', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseStoredMessage(snapshot(false, undefined))).toBeNull()

    expect(info).not.toHaveBeenCalled()
  })
})
