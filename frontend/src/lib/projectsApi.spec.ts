import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({ request }))

const { createProject, deleteProject, getProject, listProjects, patchProject } =
  await import('./projectsApi')

/**
 * The typed client for the five project routes.
 *
 * `request` is mocked here rather than `fetch`: header assembly has its own
 * suite in `apiClient.spec.ts`, and what is worth asserting at this level is the
 * contract — which path, which verb, which body, and that a `PATCH` sends only
 * the keys it was handed, since an empty one is a 400 by design.
 */

const PROJECT = {
  id: 'proj-1',
  name: 'Contact dashboard',
  description: null,
  locationId: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
}

function callOf(index = 0): [string, RequestInit] {
  return request.mock.calls[index] as [string, RequestInit]
}

/** The serialised body, parsed back — the client always sends a JSON string. */
function bodyOf(init: RequestInit): unknown {
  return JSON.parse(typeof init.body === 'string' ? init.body : '')
}

beforeEach(() => {
  vi.clearAllMocks()
  request.mockResolvedValue({ project: PROJECT })
})

describe('listProjects', () => {
  it('GETs /api/projects and unwraps the envelope', async () => {
    request.mockResolvedValue({ projects: [PROJECT] })

    await expect(listProjects()).resolves.toEqual([PROJECT])
    expect(request).toHaveBeenCalledWith('/api/projects')
  })
})

/*
 * The by-id read. The route has existed since Slice 3, but nothing in the browser
 * called it until the workspace did: it opens on a deep link, a reload or a
 * bookmark, so it fetches its own project rather than reading a store that is
 * populated only when you arrived from the dashboard (Slice 4, D26).
 */
describe('getProject', () => {
  it('GETs the project by id and unwraps the envelope', async () => {
    await expect(getProject('proj-1')).resolves.toEqual(PROJECT)

    expect(request).toHaveBeenCalledWith('/api/projects/proj-1')
  })

  /*
   * The status has to survive, not just the message: the workspace renders a
   * deleted project differently from a failure — a Back link rather than a Retry —
   * and it tells them apart by the 404.
   */
  it("surfaces the server's rejection", async () => {
    request.mockRejectedValue(new Error('That project no longer exists.'))

    await expect(getProject('proj-1')).rejects.toThrow('That project no longer exists.')
  })
})

describe('createProject', () => {
  it('POSTs /api/projects with a JSON body', async () => {
    await createProject({ name: 'Contact dashboard', description: 'Contacts' })
    const [path, init] = callOf()

    expect(path).toBe('/api/projects')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(bodyOf(init)).toEqual({ name: 'Contact dashboard', description: 'Contacts' })
  })

  it('returns the project the server stored', async () => {
    await expect(createProject({ name: 'Contact dashboard' })).resolves.toEqual(PROJECT)
  })

  it("surfaces the server's message on a refusal", async () => {
    request.mockRejectedValue(new Error('You have reached the limit of 100 projects.'))

    await expect(createProject({ name: 'A' })).rejects.toThrow(
      'You have reached the limit of 100 projects.',
    )
  })
})

describe('patchProject', () => {
  it('PATCHes the project by id', async () => {
    await patchProject('proj-1', { name: 'Contacts' })
    const [path, init] = callOf()

    expect(path).toBe('/api/projects/proj-1')
    expect(init.method).toBe('PATCH')
    expect(bodyOf(init)).toEqual({ name: 'Contacts' })
  })

  /*
   * Only the keys it was given. An empty `PATCH` is a 400 by design, and a
   * client that helpfully filled in the unchanged fields would turn every rename
   * into a full overwrite — including one that resends a description the user
   * never touched.
   */
  it('sends only the keys it was handed', async () => {
    await patchProject('proj-1', { description: null })

    expect(bodyOf(callOf()[1])).toEqual({ description: null })
  })
})

describe('deleteProject', () => {
  it('DELETEs the project by id', async () => {
    request.mockResolvedValue({ ok: true })

    await deleteProject('proj-1')
    const [path, init] = callOf()

    expect(path).toBe('/api/projects/proj-1')
    expect(init.method).toBe('DELETE')
  })
})

/*
 * An id is a server-generated string that reaches us over the wire, so it is
 * encoded rather than trusted to be path-safe — the server refuses anything
 * outside `[A-Za-z0-9_-]`, and this makes the two agree instead of relying on
 * the refusal.
 */
describe('path encoding', () => {
  it.each([
    ['getProject', () => getProject('a/b')],
    ['patchProject', () => patchProject('a/b', { name: 'A' })],
    ['deleteProject', () => deleteProject('a/b')],
  ])('percent-encodes the id for %s', async (_label, call) => {
    request.mockResolvedValue({ project: PROJECT, ok: true })

    await call()

    expect(callOf()[0]).toBe('/api/projects/a%2Fb')
  })
})
