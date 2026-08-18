import { Timestamp } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminDb,
  getJson,
  idTokenFor,
  putJson,
  resetEmulators,
  seedUser,
  type JsonResponse,
} from './helpers'

/**
 * The three file routes, over the wire (AC-26 to AC-31, D19).
 *
 * F5.1 is exactly three verbs: list the tree, read a file, save an edit. Splitting the list from
 * the read is what keeps opening a workspace from shipping 20 × 100 KB of code nobody has
 * clicked on yet, so **"no `content` on a list entry"** is asserted rather than assumed.
 */

const PASSWORD = 'Correct-Horse-9'
const ALICE = 'files-alice@example.test'
const BOB = 'files-bob@example.test'
const UNVERIFIED = 'files-unverified@example.test'

let aliceUid: string
let bobUid: string
let aliceToken: string
let bobToken: string
let unverifiedToken: string

const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })

async function seedProject(
  uid: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await adminDb()
    .doc(`users/${uid}/projects/${id}`)
    .set({
      name: `Project ${id}`,
      description: null,
      locationId: null,
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      deletedAt: null,
      ...overrides,
    })
}

/** Write a file past the routes, so a read has something to find. */
async function seedFile(
  uid: string,
  projectId: string,
  path: string,
  content: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await adminDb()
    .doc(`users/${uid}/projects/${projectId}/files/${path}`)
    .set({
      path,
      content,
      size: Buffer.byteLength(content, 'utf8'),
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      ...overrides,
    })
}

async function storedFile(
  uid: string,
  projectId: string,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  const snapshot = await adminDb().doc(`users/${uid}/projects/${projectId}/files/${path}`).get()
  return snapshot.exists ? snapshot.data() : undefined
}

async function fileCount(uid: string, projectId: string): Promise<number> {
  return (await adminDb().collection(`users/${uid}/projects/${projectId}/files`).listDocuments())
    .length
}

async function clearProjects(uid: string): Promise<void> {
  const refs = await adminDb().collection(`users/${uid}/projects`).listDocuments()
  await Promise.all(refs.map((ref) => adminDb().recursiveDelete(ref)))
}

const listPath = (projectId: string): string => `/api/projects/${projectId}/files`
const filePath = (projectId: string, path: string): string =>
  `/api/projects/${projectId}/files/${encodeURIComponent(path)}`

const codeOf = (body: unknown): string | undefined => (body as { code?: string }).code
const filesOf = (res: JsonResponse): Record<string, unknown>[] =>
  (res.body as { files: Record<string, unknown>[] }).files
const fileOf = (res: JsonResponse): Record<string, unknown> =>
  (res.body as { file: Record<string, unknown> }).file

beforeAll(async () => {
  await resetEmulators()
  aliceUid = await seedUser(ALICE, PASSWORD, true)
  bobUid = await seedUser(BOB, PASSWORD, true)
  await seedUser(UNVERIFIED, PASSWORD, false)
  aliceToken = await idTokenFor(ALICE, PASSWORD)
  bobToken = await idTokenFor(BOB, PASSWORD)
  unverifiedToken = await idTokenFor(UNVERIFIED, PASSWORD)
})

beforeEach(async () => {
  await clearProjects(aliceUid)
  await clearProjects(bobUid)
  await seedProject(aliceUid, 'proj-1')
})

describe('GET /api/projects/:projectId/files (AC-26)', () => {
  it('lists the files ordered by path', async () => {
    await seedFile(aliceUid, 'proj-1', 'styles.css', 'body {}\n')
    await seedFile(aliceUid, 'proj-1', 'app.js', 'const a = 1\n')
    await seedFile(aliceUid, 'proj-1', 'index.html', '<h1>x</h1>\n')

    const res = await getJson(listPath('proj-1'), auth(aliceToken))

    expect(res.status).toBe(200)
    expect(filesOf(res).map((file) => file['path'])).toEqual(['app.js', 'index.html', 'styles.css'])
  })

  /** The projection, and it is the whole reason the list is a separate route. */
  it('carries path, size and both timestamps, and no content at all', async () => {
    await seedFile(aliceUid, 'proj-1', 'app.js', 'const a = 1\n')

    const [file] = filesOf(await getJson(listPath('proj-1'), auth(aliceToken)))

    expect(Object.keys(file ?? {}).sort()).toEqual(['createdAt', 'path', 'size', 'updatedAt'])
    expect(file?.['size']).toBe(12)
    expect(file?.['createdAt']).toBe('2023-11-14T22:13:20.000Z')
  })

  it('answers an empty list for a project that has never generated', async () => {
    const res = await getJson(listPath('proj-1'), auth(aliceToken))

    expect(res.status).toBe(200)
    expect(filesOf(res)).toEqual([])
  })

  /**
   * A document whose stored `path` disagrees with its id cannot be shown in the right row or
   * answered for the right `GET`, so it is omitted — the fail-closed rule `parseStored` set,
   * applied to the invariant this collection adds.
   */
  it('omits a document whose path disagrees with its id', async () => {
    await seedFile(aliceUid, 'proj-1', 'app.js', 'const a = 1\n')
    await adminDb()
      .doc(`users/${aliceUid}/projects/proj-1/files/index.html`)
      .set({
        path: 'somewhere-else.html',
        content: '<h1>x</h1>\n',
        size: 11,
        createdAt: Timestamp.fromMillis(1_700_000_000_000),
        updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      })

    const res = await getJson(listPath('proj-1'), auth(aliceToken))

    expect(filesOf(res).map((file) => file['path'])).toEqual(['app.js'])
  })

  it('answers 400 invalid_id for a malformed project id', async () => {
    const res = await getJson(listPath('bad!id'), auth(aliceToken))

    expect(res.status).toBe(400)
    expect(codeOf(res.body)).toBe('invalid_id')
  })
})

describe('GET /api/projects/:projectId/files/:path (AC-27)', () => {
  it('answers with the file, its content and its size', async () => {
    await seedFile(aliceUid, 'proj-1', 'index.html', '<h1>Contacts</h1>\n')

    const res = await getJson(filePath('proj-1', 'index.html'), auth(aliceToken))

    expect(res.status).toBe(200)
    expect(fileOf(res)).toEqual({
      path: 'index.html',
      content: '<h1>Contacts</h1>\n',
      size: 18,
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:13:20.000Z',
    })
  })

  it('answers 404 for a path the project does not hold', async () => {
    const res = await getJson(filePath('proj-1', 'missing.js'), auth(aliceToken))

    expect(res.status).toBe(404)
    expect(codeOf(res.body)).toBe('not_found')
  })

  /**
   * AC-27's refusals, and the one that matters is `../x`: traversal is refused
   * because it fails to be a filename, not because a sanitiser caught it (D12).
   */
  it.each(['../secrets.js', 'A.html', 'a.ts', 'assets/app.js', '.env', 'app'])(
    'answers 400 invalid_path for %s',
    async (path) => {
      const res = await getJson(filePath('proj-1', path), auth(aliceToken))

      expect(res.status).toBe(400)
      expect(codeOf(res.body)).toBe('invalid_path')
    },
  )

  /** The percent-encoded traversal forms, which are the ones that actually arrive. */
  it.each(['%2e%2e%2fsecrets.js', '%2fetc%2fpasswd', '%2e%2e%5csecrets.js'])(
    'answers 400 invalid_path for the encoded path %s',
    async (encoded) => {
      const res = await getJson(`/api/projects/proj-1/files/${encoded}`, auth(aliceToken))

      expect(res.status).toBe(400)
      expect(codeOf(res.body)).toBe('invalid_path')
    },
  )

  /** A whole segment of `..`, encoded or not, never reaches this handler at all. */
  it.each(['..', '%2E%2E'])(
    'never reaches a file through the traversal segment %s',
    async (segment) => {
      await seedFile(aliceUid, 'proj-1', 'app.js', 'const a = 1\n')

      const res = await getJson(`/api/projects/proj-1/files/${segment}`, auth(aliceToken))

      expect(res.body).not.toHaveProperty('file')
      expect(res.body).not.toHaveProperty('files')
      expect(res.raw).not.toContain('const a = 1')
    },
  )

  /** The "no Firestore read" half of AC-27, made observable. */
  it('refuses the path before it looks the project up', async () => {
    const res = await getJson(filePath('neverExisted', '../secrets.js'), auth(aliceToken))

    expect(res.status).toBe(400)
    expect(codeOf(res.body)).toBe('invalid_path')
  })
})

describe('PUT /api/projects/:projectId/files/:path (AC-28, AC-29)', () => {
  it('saves an edit, recomputing size and advancing updatedAt', async () => {
    await seedFile(aliceUid, 'proj-1', 'index.html', '<h1>Contacts</h1>\n')

    const res = await putJson(
      filePath('proj-1', 'index.html'),
      { content: '<h1>People</h1>\n' },
      auth(aliceToken),
    )

    expect(res.status).toBe(200)
    expect(fileOf(res)['content']).toBe('<h1>People</h1>\n')
    expect(fileOf(res)['size']).toBe(16)
    // `createdAt` is the date the file was first generated, and a save is not that.
    expect(fileOf(res)['createdAt']).toBe('2023-11-14T22:13:20.000Z')
    expect(String(fileOf(res)['updatedAt']) > '2023-11-14T22:13:20.000Z').toBe(true)
  })

  it('is what a fresh GET returns afterwards', async () => {
    await seedFile(aliceUid, 'proj-1', 'index.html', '<h1>Contacts</h1>\n')

    await putJson(filePath('proj-1', 'index.html'), { content: 'saved\n' }, auth(aliceToken))
    const res = await getJson(filePath('proj-1', 'index.html'), auth(aliceToken))

    expect(fileOf(res)['content']).toBe('saved\n')
  })

  /** Empty is legal: a user may blank a file. */
  it('accepts an empty file', async () => {
    await seedFile(aliceUid, 'proj-1', 'app.js', 'const a = 1\n')

    const res = await putJson(filePath('proj-1', 'app.js'), { content: '' }, auth(aliceToken))

    expect(res.status).toBe(200)
    expect(fileOf(res)).toMatchObject({ content: '', size: 0 })
  })

  /** D19. Creating a file by hand is not in F5.1, so `PUT` refuses to create. */
  it('answers 404 for an unknown path and creates nothing', async () => {
    const res = await putJson(filePath('proj-1', 'new.js'), { content: 'x\n' }, auth(aliceToken))

    expect(res.status).toBe(404)
    expect(codeOf(res.body)).toBe('not_found')
    expect(await fileCount(aliceUid, 'proj-1')).toBe(0)
  })

  /*
   * `.strict()`, and the stored document asserted byte-identical afterwards —
   * a status alone would not notice a handler that wrote and then refused.
   */
  it.each([
    ['an extra key', { content: 'x\n', path: 'other.js' }],
    ['a caller-chosen size', { content: 'x\n', size: 1 }],
    ['a non-string content', { content: 42 }],
    ['no content at all', {}],
    ['content over the cap', { content: 'a'.repeat(100_001) }],
  ])('answers 400 invalid_body for %s, writing nothing', async (_label, body) => {
    await seedFile(aliceUid, 'proj-1', 'app.js', 'const a = 1\n')
    const before = await storedFile(aliceUid, 'proj-1', 'app.js')

    const res = await putJson(filePath('proj-1', 'app.js'), body, auth(aliceToken))

    expect(res.status).toBe(400)
    expect(codeOf(res.body)).toBe('invalid_body')
    expect(await storedFile(aliceUid, 'proj-1', 'app.js')).toEqual(before)
  })

  /* Exactly at the cap is accepted, so the boundary is a fact in both directions. */
  it('accepts content of exactly 100,000 bytes', async () => {
    await seedFile(aliceUid, 'proj-1', 'app.js', 'const a = 1\n')

    const res = await putJson(
      filePath('proj-1', 'app.js'),
      { content: 'a'.repeat(100_000) },
      auth(aliceToken),
    )

    expect(res.status).toBe(200)
    expect(fileOf(res)['size']).toBe(100_000)
  })

  it('answers 400 invalid_path before it looks the project up', async () => {
    const res = await putJson(
      filePath('neverExisted', '../secrets.js'),
      { content: 'x' },
      auth(aliceToken),
    )

    expect(res.status).toBe(400)
    expect(codeOf(res.body)).toBe('invalid_path')
  })
})

describe('another user’s project (AC-30)', () => {
  beforeEach(async () => {
    await seedProject(bobUid, 'bob-1')
    await seedFile(bobUid, 'bob-1', 'index.html', "<h1>Bob's</h1>\n")
  })

  it('answers 404 to all three routes and leaves the file untouched', async () => {
    const before = await storedFile(bobUid, 'bob-1', 'index.html')

    const list = await getJson(listPath('bob-1'), auth(aliceToken))
    const read = await getJson(filePath('bob-1', 'index.html'), auth(aliceToken))
    const save = await putJson(
      filePath('bob-1', 'index.html'),
      { content: 'stolen\n' },
      auth(aliceToken),
    )

    for (const res of [list, read, save]) {
      expect(res.status).toBe(404)
      expect(codeOf(res.body)).toBe('not_found')
    }
    expect(await storedFile(bobUid, 'bob-1', 'index.html')).toEqual(before)
  })

  /* And bob still reaches his own, so the 404 is about ownership and nothing else. */
  it('lets bob read his own file', async () => {
    const res = await getJson(filePath('bob-1', 'index.html'), auth(bobToken))

    expect(res.status).toBe(200)
    expect(fileOf(res)['content']).toBe("<h1>Bob's</h1>\n")
  })

  it.each([
    ['a soft-deleted project', 'gone'],
    ['a project that never existed', 'neverExisted'],
  ])('answers 404 on all three routes for %s', async (_label, projectId) => {
    if (projectId === 'gone') {
      await seedProject(aliceUid, 'gone', { deletedAt: Timestamp.fromMillis(1_700_000_900_000) })
      await seedFile(aliceUid, 'gone', 'index.html', '<h1>x</h1>\n')
    }

    const list = await getJson(listPath(projectId), auth(aliceToken))
    const read = await getJson(filePath(projectId, 'index.html'), auth(aliceToken))
    const save = await putJson(
      filePath(projectId, 'index.html'),
      { content: 'x\n' },
      auth(aliceToken),
    )

    for (const res of [list, read, save]) {
      expect(res.status).toBe(404)
      expect(codeOf(res.body)).toBe('not_found')
    }
  })
})

describe('the guards on every file route (AC-31)', () => {
  const calls: [string, (headers: Record<string, string>) => Promise<JsonResponse>][] = [
    ['GET the list', (headers) => getJson(listPath('proj-1'), headers)],
    ['GET one file', (headers) => getJson(filePath('proj-1', 'index.html'), headers)],
    [
      'PUT one file',
      (headers) => putJson(filePath('proj-1', 'index.html'), { content: 'x' }, headers),
    ],
  ]

  it.each(calls)(
    'refuses %s with 401 when there is no Authorization header',
    async (_label, call) => {
      const res = await call({})

      expect(res.status).toBe(401)
      expect(codeOf(res.body)).toBe('unauthenticated')
    },
  )

  it.each(calls)('refuses %s with 401 for a malformed token', async (_label, call) => {
    const res = await call({ Authorization: 'Bearer not-a-token' })

    expect(res.status).toBe(401)
    expect(codeOf(res.body)).toBe('unauthenticated')
  })

  /* A router guard stops a browser; it does not stop a direct call. */
  it.each(calls)('refuses %s with 403 for an unverified caller', async (_label, call) => {
    const res = await call(auth(unverifiedToken))

    expect(res.status).toBe(403)
    expect(codeOf(res.body)).toBe('email_unverified')
  })
})
