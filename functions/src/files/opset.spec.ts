import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import {
  byteLength,
  FILE_BYTES_MAX,
  fileErrorCopy,
  putFileBodySchema,
  storedFileMetaSchema,
  storedFileSchema,
  toFile,
  toFileMeta,
  validateFileOps,
  type FileOp,
  type FileRejection,
} from './schema'

/**
 * The op set, refused whole (AC-12 to AC-15, D8, D9, D15).
 *
 * A generated app is a *set* of files that reference each other — `index.html`
 * names `app.js` in a `<script src>` — so writing two of three produces an app
 * that is broken in a way the user cannot see until the preview fails, and cannot
 * fix without knowing which file is missing. Every case below therefore asserts
 * the whole set was refused, not that one op was dropped.
 *
 * The copy is asserted **verbatim** against the PRD's table, because `fileError`
 * is the only thing the user is told and a reworded sentence is a product change.
 *
 * A file of its own rather than more of `schema.spec.ts`: that file is about what
 * a *name* may be, this one is about what a *set* may be, and the two are the
 * slice's two separate refusal boundaries.
 */

const op = (path: string, content = 'x'): FileOp => ({ path, content })

/** `count` distinct, valid filenames — `f0.js`, `f1.js`, … */
function ops(count: number, offset = 0): FileOp[] {
  return Array.from({ length: count }, (_unused, index) => op(`f${String(index + offset)}.js`))
}

function rejection(result: ReturnType<typeof validateFileOps>): FileRejection {
  if (result.ok) throw new Error('expected the set to be refused')
  return result.error
}

describe('byteLength', () => {
  /* AC-12. The cap is bytes, because a Firestore document limit is bytes. */
  it('counts UTF-8 bytes and not characters', () => {
    expect(byteLength('abc')).toBe(3)
    // Four characters, twelve bytes: three bytes each.
    expect(byteLength('日本語だ')).toBe(12)
    expect(byteLength('')).toBe(0)
  })
})

describe('validateFileOps — the byte cap (AC-12)', () => {
  it('accepts content of exactly 100,000 bytes', () => {
    expect(validateFileOps([op('app.js', 'a'.repeat(FILE_BYTES_MAX))], []).ok).toBe(true)
  })

  it('refuses content one byte over, naming the file', () => {
    const result = validateFileOps([op('app.js', 'a'.repeat(FILE_BYTES_MAX + 1))], [])

    expect(fileErrorCopy(rejection(result))).toBe(
      'Genesis could not save the generated files: "app.js" is larger than 100 KB. Nothing was changed.',
    )
  })

  /* Bytes, not characters: 33,334 three-byte characters is 100,002 bytes. */
  it('counts a multi-byte file in bytes', () => {
    const content = '日'.repeat(33_334)
    expect(content.length).toBeLessThan(FILE_BYTES_MAX)

    expect(validateFileOps([op('app.js', content)], []).ok).toBe(false)
  })
})

describe('validateFileOps — the file cap (AC-13)', () => {
  it('refuses 21 ops in one turn, naming the cap rather than a file', () => {
    const result = validateFileOps(ops(21), [])

    expect(fileErrorCopy(rejection(result))).toBe(
      'Genesis could not save the generated files: a project can hold at most 20 files. Nothing was changed.',
    )
  })

  /*
   * The union, which is the clause a reader has to look for: 15 new files against
   * a project already holding 10 different ones is 25, and the cap is about what
   * the project ends up holding rather than what one turn wrote.
   */
  it('refuses 15 ops against a project already holding 10 other files', () => {
    const existing = ops(10, 100).map((entry) => entry.path)

    expect(rejection(validateFileOps(ops(15), existing)).reason).toBe('too-many')
  })

  /* And a rewrite is not a new file: 20 ops over 5 existing paths is still 20. */
  it('accepts 20 ops of which 5 rewrite existing files', () => {
    const existing = ops(5).map((entry) => entry.path)

    expect(validateFileOps(ops(20), existing).ok).toBe(true)
  })
})

describe('validateFileOps — the path and the duplicate (AC-11, AC-14)', () => {
  it('refuses a path we cannot store, naming it', () => {
    const result = validateFileOps([op('index.html'), op('../secrets.js')], [])

    expect(fileErrorCopy(rejection(result))).toBe(
      'Genesis could not save the generated files: "../secrets.js" is not a file name we can store. Nothing was changed.',
    )
  })

  it('refuses two ops sharing a path, naming it', () => {
    const result = validateFileOps([op('app.js', 'first'), op('app.js', 'second')], [])

    expect(fileErrorCopy(rejection(result))).toBe(
      'Genesis could not save the generated files: "app.js" was written twice. Nothing was changed.',
    )
  })

  /*
   * P5's order, and it is deterministic so `fileError` is reproducible from a
   * fixture. Path first, because a path we cannot name is the one whose *identity*
   * the other two messages depend on.
   */
  it('reports the path failure when an op is both unnameable and oversized', () => {
    const result = validateFileOps([op('../x.js', 'a'.repeat(FILE_BYTES_MAX + 1))], [])

    expect(rejection(result).reason).toBe('path')
  })

  it('reports the first failure in written order', () => {
    const result = validateFileOps([op('a.js'), op('B.js'), op('a.js')], [])

    expect(rejection(result)).toEqual({ reason: 'path', path: 'B.js' })
  })

  /* The refused path goes through `displayPath` before it reaches a person. */
  it('strips control characters out of the path it names', () => {
    const result = validateFileOps([op('badname\nxyz.js')], [])

    expect(fileErrorCopy(rejection(result))).not.toContain('\n')
  })
})

describe('validateFileOps — what a valid set becomes (AC-15)', () => {
  it('parses to writes whose path is the document id and whose size is the byte length', () => {
    const result = validateFileOps(
      [op('index.html', '<!doctype html>\n'), op('app.js', '日\n')],
      [],
    )

    expect(result).toEqual({
      ok: true,
      writes: [
        { path: 'index.html', content: '<!doctype html>\n', size: 16 },
        { path: 'app.js', content: '日\n', size: 4 },
      ],
    })
  })

  /* An empty set is valid and writes nothing — a prose-only reply (D17). */
  it('accepts an empty set', () => {
    expect(validateFileOps([], [])).toEqual({ ok: true, writes: [] })
  })

  /* Empty content is legal: a user may blank a file. */
  it('accepts an empty file', () => {
    expect(validateFileOps([op('app.js', '')], [])).toEqual({
      ok: true,
      writes: [{ path: 'app.js', content: '', size: 0 }],
    })
  })
})

describe('fileErrorCopy — the whole table (D9, D10)', () => {
  it.each([
    [
      { reason: 'path', path: 'assets/app.js' },
      'Genesis could not save the generated files: "assets/app.js" is not a file name we can store. Nothing was changed.',
    ],
    [
      { reason: 'duplicate', path: 'app.js' },
      'Genesis could not save the generated files: "app.js" was written twice. Nothing was changed.',
    ],
    [
      { reason: 'too-large', path: 'app.js' },
      'Genesis could not save the generated files: "app.js" is larger than 100 KB. Nothing was changed.',
    ],
    [
      { reason: 'too-many' },
      'Genesis could not save the generated files: a project can hold at most 20 files. Nothing was changed.',
    ],
    [
      { reason: 'unterminated', path: 'app.js' },
      'The reply ended in the middle of "app.js", so nothing was saved. Try again.',
    ],
    [{ reason: 'incomplete' }, 'The reply was cut short, so no files were saved. Try again.'],
    [{ reason: 'write-failed' }, 'The generated files could not be saved. Try again.'],
  ] as [FileRejection, string][])('renders the %o reason verbatim', (reason, copy) => {
    expect(fileErrorCopy(reason)).toBe(copy)
  })
})

describe('putFileBodySchema', () => {
  it('accepts exactly { content }', () => {
    expect(putFileBodySchema.safeParse({ content: 'hello' })).toMatchObject({ success: true })
  })

  /*
   * `.strict()` is the load-bearing call. `path`, `size` and both timestamps are
   * the server's to write, so a body carrying one is refused rather than quietly
   * stripped.
   */
  it.each([
    ['an extra key', { content: 'hello', path: 'other.js' }],
    ['a size the caller chose', { content: 'hello', size: 1 }],
    ['a non-string content', { content: 42 }],
    ['no content at all', {}],
    ['a null content', { content: null }],
  ])('refuses %s', (_label, body) => {
    expect(putFileBodySchema.safeParse(body).success).toBe(false)
  })

  it('accepts an empty string — a user may blank a file', () => {
    expect(putFileBodySchema.safeParse({ content: '' }).success).toBe(true)
  })

  it('refuses content over the cap, counted in bytes', () => {
    expect(putFileBodySchema.safeParse({ content: 'a'.repeat(FILE_BYTES_MAX) }).success).toBe(true)
    expect(putFileBodySchema.safeParse({ content: 'a'.repeat(FILE_BYTES_MAX + 1) }).success).toBe(
      false,
    )
    expect(putFileBodySchema.safeParse({ content: '日'.repeat(33_334) }).success).toBe(false)
  })
})

const STORED = {
  path: 'index.html',
  content: '<!doctype html>\n',
  size: 16,
  createdAt: Timestamp.fromMillis(1_700_000_000_000),
  updatedAt: Timestamp.fromMillis(1_700_000_100_000),
}

describe('storedFileSchema', () => {
  it('parses a complete document', () => {
    expect(storedFileSchema.safeParse(STORED).success).toBe(true)
  })

  /*
   * Nothing here carries a `.catch`. `path` is the file's identity, `content` is
   * the file, `size` is what the list renders and the timestamps are how it is
   * dated — a document missing or corrupting any of them cannot be shown, so it is
   * *known* to be unusable and is omitted from the list and 404 by id (D13).
   */
  it.each([
    ['no path', { ...STORED, path: undefined }],
    ['a path that is not a storable filename', { ...STORED, path: '../secrets.js' }],
    ['no content', { ...STORED, content: undefined }],
    ['a non-string content', { ...STORED, content: 42 }],
    ['no size', { ...STORED, size: undefined }],
    ['no createdAt', { ...STORED, createdAt: undefined }],
    ['no updatedAt', { ...STORED, updatedAt: undefined }],
  ])('refuses a document with %s', (_label, data) => {
    expect(storedFileSchema.safeParse(data).success).toBe(false)
  })

  /*
   * **No maximum on stored `content`**, where the body schema has one. Both
   * writers enforce the cap, so an oversized document cannot arrive — and if one
   * somehow did, refusing to read it would lose the user's file rather than
   * protect anything. A stored document is not a request body.
   */
  it('reads back a document over the cap rather than losing it', () => {
    expect(
      storedFileSchema.safeParse({ ...STORED, content: 'a'.repeat(FILE_BYTES_MAX + 1) }).success,
    ).toBe(true)
  })
})

/** The same document as `select()` returns it: every field but `content`. */
function metaOf(stored: typeof STORED): Omit<typeof STORED, 'content'> {
  return {
    path: stored.path,
    size: stored.size,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  }
}

describe('the wire shapes', () => {
  /*
   * The list is a projection that never reads `content`, so its own parse must
   * not require one.
   */
  it('parses a metadata-only projection', () => {
    expect(storedFileMetaSchema.safeParse(metaOf(STORED)).success).toBe(true)
  })

  it('renders a file with ISO-8601 timestamps', () => {
    expect(toFile(storedFileSchema.parse(STORED))).toEqual({
      path: 'index.html',
      content: '<!doctype html>\n',
      size: 16,
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:15:00.000Z',
    })
  })

  /** AC-26. **No `content` on a list entry**, which is why this is its own shape. */
  it('renders metadata carrying no content at all', () => {
    const rendered = toFileMeta(storedFileMetaSchema.parse(metaOf(STORED)))

    expect(Object.keys(rendered).sort()).toEqual(['createdAt', 'path', 'size', 'updatedAt'])
  })
})
