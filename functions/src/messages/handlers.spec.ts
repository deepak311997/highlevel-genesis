import type { DocumentSnapshot, FieldValue, Query } from 'firebase-admin/firestore'
import { Timestamp } from 'firebase-admin/firestore'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { echoFor, messagePair, parseStoredMessage, transcriptQuery } from './handlers'
import { MESSAGE_LIMIT } from './schema'

/**
 * The two pure halves of the transcript read.
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

describe('echoFor', () => {
  /*
   * AC-5, D7. Deterministic, no LLM and no randomness — it has to be assertable
   * byte-for-byte and obviously not intelligence when a human looks at it. The
   * chat panel says so out loud with an `Echo mode` badge, and both disappear
   * together in Slice 5.
   */
  it('is exactly "You said: <content>"', () => {
    expect(echoFor('build a contact dashboard')).toBe('You said: build a contact dashboard')
  })

  /* Trimming is the body schema's job, done before this is ever called, so the
   * echo quotes whatever it was handed rather than trimming a second time. */
  it('quotes the content it was given without touching it', () => {
    expect(echoFor('a  b')).toBe('You said: a  b')
  })
})

describe('messagePair', () => {
  /** A sentinel stands in for `FieldValue.serverTimestamp()`; purity is the point. */
  const now = { sentinel: true } as unknown as FieldValue

  /*
   * AC-1, D8. `seq` 0 then 1 is the ordering the transcript is read back by, and
   * it is assigned here rather than derived from anything — the two documents
   * commit at the same instant, so their *position* cannot come from their
   * timestamps.
   */
  it('returns the user turn then the assistant turn, seq 0 then 1', () => {
    const [user, assistant] = messagePair('build a contact dashboard', now)

    expect(user).toEqual({
      role: 'user',
      content: 'build a contact dashboard',
      seq: 0,
      createdAt: now,
    })
    expect(assistant).toEqual({
      role: 'assistant',
      content: 'You said: build a contact dashboard',
      seq: 1,
      createdAt: now,
    })
  })

  /*
   * Both documents carry the *same* timestamp value. Not a shortcut — it is what
   * a `WriteBatch` produces whatever we pass, so writing it this way makes the
   * tie visible in the code that creates it rather than a surprise in the read.
   */
  it('stamps both documents with the one timestamp it was handed', () => {
    const [user, assistant] = messagePair('hi', now)

    expect(user['createdAt']).toBe(now)
    expect(assistant['createdAt']).toBe(now)
  })

  /** `role` appears in the document and never in a request body (D5). */
  it('assigns role server-side, one of each', () => {
    // Annotated because `DocumentData` indexes to `any`, and an unannotated
    // callback would launder that into the assertion.
    expect(messagePair('hi', now).map((doc): unknown => doc['role'])).toEqual([
      'user',
      'assistant',
    ])
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
