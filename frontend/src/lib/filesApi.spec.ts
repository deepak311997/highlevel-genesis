import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({ request }))

const { FILE_BYTES_MAX, FILE_LIMIT, getFile, listFiles, saveFile } = await import('./filesApi')

/**
 * The typed client for the three file routes (AC-35).
 *
 * `request` is mocked rather than `fetch`: header assembly has its own suite in
 * `apiClient.spec.ts`, and what is worth asserting at this level is the contract
 * — which path, which verb, which body. `saveFile` sending **exactly**
 * `{ content }` is the one that matters, because `path`, `size` and both
 * timestamps are the server's to write and the body schema is `.strict()`.
 */

const META = {
  path: 'index.html',
  size: 18,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

const FILE = { ...META, content: '<h1>Contacts</h1>\n' }

function callOf(index = 0): [string, RequestInit | undefined] {
  return request.mock.calls[index] as [string, RequestInit | undefined]
}

const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '')

beforeEach(() => {
  vi.clearAllMocks()
  request.mockResolvedValue({ file: FILE })
})

describe('listFiles', () => {
  it('GETs the project’s file list and unwraps the envelope', async () => {
    request.mockResolvedValue({ files: [META] })

    await expect(listFiles('proj-1')).resolves.toEqual([META])
    expect(request).toHaveBeenCalledWith('/api/projects/proj-1/files')
  })
})

describe('getFile', () => {
  it('GETs one file by path and unwraps the envelope', async () => {
    await expect(getFile('proj-1', 'index.html')).resolves.toEqual(FILE)
    expect(request).toHaveBeenCalledWith('/api/projects/proj-1/files/index.html')
  })
})

describe('saveFile', () => {
  it('PUTs the file with a JSON body', async () => {
    await saveFile('proj-1', 'index.html', 'saved\n')
    const [path, init] = callOf()

    expect(path).toBe('/api/projects/proj-1/files/index.html')
    expect(init?.method).toBe('PUT')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  /*
   * **Exactly `{ content }`.** `path` comes from the URL and `size` and both
   * timestamps are the server's; the body schema is `.strict()`, so anything else
   * is a 400 rather than a field quietly ignored. This is the shape the function
   * exists to keep.
   */
  it('sends exactly { content }', async () => {
    await saveFile('proj-1', 'index.html', 'saved\n')

    expect(bodyOf(callOf()[1])).toEqual({ content: 'saved\n' })
  })

  it('returns the file the server stored', async () => {
    await expect(saveFile('proj-1', 'index.html', 'saved\n')).resolves.toEqual(FILE)
  })

  it("surfaces the server's message on a refusal", async () => {
    request.mockRejectedValue(new Error('That file no longer exists.'))

    await expect(saveFile('proj-1', 'gone.js', 'x')).rejects.toThrow('That file no longer exists.')
  })
})

/**
 * Both segments are percent-encoded.
 *
 * The project id and the filename are both server-generated strings that reached
 * us over the wire, so neither is trusted to be path-safe. The server refuses
 * anything outside its own two schemas; this makes the two agree rather than
 * relying on the refusal.
 */
describe('path encoding', () => {
  it.each([
    ['getFile', () => getFile('a/b', 'x/y.js')],
    ['saveFile', () => saveFile('a/b', 'x/y.js', 'z')],
  ])('percent-encodes both segments for %s', async (_label, call) => {
    await call()

    expect(callOf()[0]).toBe('/api/projects/a%2Fb/files/x%2Fy.js')
  })

  it('percent-encodes the project id for listFiles', async () => {
    request.mockResolvedValue({ files: [] })

    await listFiles('a/b')

    expect(callOf()[0]).toBe('/api/projects/a%2Fb/files')
  })
})

describe('the mirrored caps', () => {
  /*
   * Duplicated rather than imported — the functions package is not reachable from
   * `frontend/`, which is `MESSAGE_LIMIT`'s precedent. They exist on this side so
   * the editor can disable **Save** before a request the server would refuse, and
   * this pins them to the server's numbers.
   */
  it('matches the server', () => {
    expect(FILE_BYTES_MAX).toBe(100_000)
    expect(FILE_LIMIT).toBe(20)
  })
})
