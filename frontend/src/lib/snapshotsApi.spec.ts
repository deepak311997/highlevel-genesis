import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({ request }))

const { listSnapshots, restoreSnapshot } = await import('./snapshotsApi')

/**
 * AC-22 — the typed client for the two snapshot routes.
 *
 * `request` is mocked rather than `fetch`, as `projectsApi.spec.ts` does: header
 * assembly has its own suite in `apiClient.spec.ts`, and what is worth asserting
 * here is the contract — which path, which verb, and, for the restore, that it
 * sends **no body at all**. The server parses `z.object({}).strict()`, so a
 * `{}` body with a `Content-Type` would be a 400 rather than a harmless extra.
 */

const SNAPSHOT = {
  id: 'snap-1',
  seq: 2,
  createdAt: '2026-08-18T09:12:04.113Z',
  origin: 'generation' as const,
  fileCount: 4,
  totalBytes: 14_022,
}

const FILE = {
  path: 'index.html',
  size: 15,
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:12:04.113Z',
}

function callOf(index = 0): [string, RequestInit | undefined] {
  return request.mock.calls[index] as [string, RequestInit | undefined]
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listSnapshots', () => {
  it('GETs the project’s snapshots and unwraps the envelope', async () => {
    request.mockResolvedValue({ snapshots: [SNAPSHOT] })

    await expect(listSnapshots('proj-1')).resolves.toEqual([SNAPSHOT])
    expect(request).toHaveBeenCalledWith('/api/projects/proj-1/snapshots')
  })

  it('percent-encodes the project id', async () => {
    request.mockResolvedValue({ snapshots: [] })

    await listSnapshots('a/b?c')

    expect(callOf()[0]).toBe('/api/projects/a%2Fb%3Fc/snapshots')
  })
})

describe('restoreSnapshot', () => {
  it('POSTs to the snapshot’s restore path and unwraps the envelope', async () => {
    request.mockResolvedValue({ files: [FILE], changed: true })

    await expect(restoreSnapshot('proj-1', 'snap-1')).resolves.toEqual({
      files: [FILE],
      changed: true,
    })
    expect(callOf()[0]).toBe('/api/projects/proj-1/snapshots/snap-1/restore')
    expect(callOf()[1]?.method).toBe('POST')
  })

  /*
   * The body is the assertion, not an aside. `restoreSnapshotBodySchema` is
   * `z.object({}).strict()` and Express's `json()` only parses when a
   * `Content-Type` says to — so sending `'{}'` with a header would still be a
   * body, and sending one with a header and any key would be a 400. Absent is
   * the only shape that cannot drift into one.
   */
  it('sends no body and no Content-Type', async () => {
    request.mockResolvedValue({ files: [], changed: false })

    await restoreSnapshot('proj-1', 'snap-1')

    const init = callOf()[1]
    expect(init?.body).toBeUndefined()
    expect(init?.headers).toBeUndefined()
  })

  it('percent-encodes both ids', async () => {
    request.mockResolvedValue({ files: [], changed: false })

    await restoreSnapshot('a/b', 'c/d')

    expect(callOf()[0]).toBe('/api/projects/a%2Fb/snapshots/c%2Fd/restore')
  })

  it('carries changed: false through unchanged', async () => {
    request.mockResolvedValue({ files: [FILE], changed: false })

    await expect(restoreSnapshot('proj-1', 'snap-1')).resolves.toEqual({
      files: [FILE],
      changed: false,
    })
  })
})
