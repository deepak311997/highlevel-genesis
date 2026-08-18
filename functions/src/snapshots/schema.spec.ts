import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import {
  SNAPSHOT_LIMIT,
  snapshotFilesPath,
  snapshotIdSchema,
  snapshotsPath,
  storedSnapshotFileSchema,
  storedSnapshotSchema,
  toSnapshotMeta,
} from './schema'

/**
 * AC-5 — what a snapshot and one of its copied files are made of.
 *
 * The `id === path` half of AC-5 is asserted in `handlers.spec.ts`, where
 * `parseSnapshotFile` — the function that enforces it — lives. Noted here so
 * neither spec assumes the other covered it.
 */

const AT = Timestamp.fromDate(new Date('2026-08-18T09:12:04.113Z'))

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 2,
    createdAt: AT,
    origin: 'generation',
    fileCount: 4,
    totalBytes: 14_022,
    ...overrides,
  }
}

/** A complete snapshot with one field taken away — the shape a half-write leaves. */
function without(key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(snapshot()).filter(([name]) => name !== key))
}

describe('storedSnapshotSchema', () => {
  it('parses a complete snapshot document', () => {
    const parsed = storedSnapshotSchema.safeParse(snapshot())

    expect(parsed.success).toBe(true)
  })

  /*
   * The origin allowlist is what makes `originLabel` exhaustive on the client: a third value
   * would render as nothing at all, so the document is unreadable instead.
   */
  it('refuses an origin outside the allowlist', () => {
    expect(storedSnapshotSchema.safeParse(snapshot({ origin: 'manual' })).success).toBe(false)
  })

  // D5 — versions are numbered from 1, so a 0 is a document nothing can name.
  it('refuses a seq below 1', () => {
    expect(storedSnapshotSchema.safeParse(snapshot({ seq: 0 })).success).toBe(false)
  })

  // D27 — a snapshot of nothing is not reachable, so one claiming to be is corrupt.
  it('refuses a fileCount of 0', () => {
    expect(storedSnapshotSchema.safeParse(snapshot({ fileCount: 0 })).success).toBe(false)
  })

  it('refuses a missing totalBytes', () => {
    expect(storedSnapshotSchema.safeParse(without('totalBytes')).success).toBe(false)
  })

  it('refuses a missing createdAt', () => {
    expect(storedSnapshotSchema.safeParse(without('createdAt')).success).toBe(false)
  })
})

describe('storedSnapshotFileSchema', () => {
  it('parses a copied file', () => {
    const parsed = storedSnapshotFileSchema.safeParse({
      path: 'index.html',
      content: '<!doctype html>',
      size: 15,
    })

    expect(parsed.success).toBe(true)
  })

  // The same `filePathSchema` the live collection uses, so a copy cannot hold a
  // name the project itself could never have stored.
  it('refuses a path the live collection would refuse', () => {
    expect(
      storedSnapshotFileSchema.safeParse({ path: '../secrets.js', content: '', size: 0 }).success,
    ).toBe(false)
  })

  // No timestamps here: the snapshot document carries the one time that means
  // anything about a copy, so a file document must not require its own.
  it('needs no timestamps', () => {
    const parsed = storedSnapshotFileSchema.safeParse({ path: 'app.js', content: 'x', size: 1 })

    expect(parsed.success).toBe(true)
  })
})

describe('the collection paths', () => {
  it('composes the snapshots collection under its project', () => {
    expect(snapshotsPath('alice', 'proj-1')).toBe('users/alice/projects/proj-1/snapshots')
  })

  it('composes a snapshot files collection from the snapshots path', () => {
    expect(snapshotFilesPath('alice', 'proj-1', 'snap-1')).toBe(
      'users/alice/projects/proj-1/snapshots/snap-1/files',
    )
  })
})

describe('snapshotIdSchema', () => {
  it('accepts a Firestore auto-id', () => {
    expect(snapshotIdSchema.safeParse('aB3xYz_-09').success).toBe(true)
  })

  /*
   * P1 — its own copy of `projectIdSchema`'s pattern with its own message, so a
   * malformed snapshot id and a malformed project id do not share one sentence.
   */
  it('refuses an id that could change the depth of a document path', () => {
    expect(snapshotIdSchema.safeParse('../../projects').success).toBe(false)
    expect(snapshotIdSchema.safeParse('').success).toBe(false)
  })

  it('describes the outcome rather than the rule', () => {
    const parsed = snapshotIdSchema.safeParse('a/b')

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('That version could not be found.')
  })
})

describe('toSnapshotMeta', () => {
  it('renders the timestamp as ISO-8601 and carries the id', () => {
    const meta = toSnapshotMeta('snap-1', {
      seq: 2,
      createdAt: AT,
      origin: 'restore',
      fileCount: 4,
      totalBytes: 14_022,
    })

    expect(meta).toEqual({
      id: 'snap-1',
      seq: 2,
      createdAt: '2026-08-18T09:12:04.113Z',
      origin: 'restore',
      fileCount: 4,
      totalBytes: 14_022,
    })
  })

  // AC-11 — no entry carries content, and the type is what makes that true.
  it('carries no content', () => {
    const meta = toSnapshotMeta('snap-1', {
      seq: 1,
      createdAt: AT,
      origin: 'generation',
      fileCount: 1,
      totalBytes: 1,
    })

    expect(Object.keys(meta).sort()).toEqual([
      'createdAt',
      'fileCount',
      'id',
      'origin',
      'seq',
      'totalBytes',
    ])
  })
})

describe('SNAPSHOT_LIMIT', () => {
  // D6 — the same number as FILE_LIMIT, and the same as the list's cap, so
  // "you are seeing every version" is a guarantee rather than a hope.
  it('is 20', () => {
    expect(SNAPSHOT_LIMIT).toBe(20)
  })
})
