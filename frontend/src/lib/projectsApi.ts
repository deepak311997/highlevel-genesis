import { request } from './apiClient'

/**
 * The project routes — **the whole of the browser's access to the collection.**
 *
 * `users/{uid}/projects/{projectId}` is denied to every client by
 * `firestore.rules`, so there is no second path to the data and no `onSnapshot`
 * to fall back on. Liveness comes from calling `listProjects()` again after a
 * mutation.
 *
 * The owner's uid is never sent. It lives in the ID token the API client
 * attaches, and the server composes the document path from it — which is why
 * these paths name a project and never a user.
 */

/** Mirrors the server's wire shape. Timestamps are ISO-8601 strings. */
export interface Project {
  id: string
  name: string
  description: string | null
  locationId: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateProjectInput {
  name: string
  description?: string | null
}

/**
 * Both fields optional, and at least one required by the server. Sending `{}`
 * is a 400 by design — an accepted no-op would still advance `updatedAt` and
 * reorder the list — so callers send only what changed.
 */
export interface PatchProjectInput {
  name?: string
  description?: string | null
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/**
 * An id is a server-generated string that reached us over the wire, so it is
 * encoded rather than trusted to be path-safe. The server refuses anything
 * outside `[A-Za-z0-9_-]`; this makes the two agree rather than relying on the
 * refusal.
 */
function pathFor(id: string): string {
  return `/api/projects/${encodeURIComponent(id)}`
}

export async function listProjects(): Promise<Project[]> {
  const { projects } = await request<{ projects: Project[] }>('/api/projects')
  return projects
}

/**
 * One project by id.
 *
 * The route has existed since Slice 3; the workspace is the first thing to call
 * it. It opens on a deep link, a reload or a bookmark, so it fetches its own
 * project rather than reading a store that is populated only when you arrived
 * from the dashboard (Slice 4, D26). The rejection keeps its status, because the
 * workspace renders a 404 as "no longer exists" with a Back link and anything
 * else as a failure with a Retry.
 */
export async function getProject(id: string): Promise<Project> {
  const { project } = await request<{ project: Project }>(pathFor(id))
  return project
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const { project } = await request<{ project: Project }>('/api/projects', json('POST', input))
  return project
}

export async function patchProject(id: string, input: PatchProjectInput): Promise<Project> {
  const { project } = await request<{ project: Project }>(pathFor(id), json('PATCH', input))
  return project
}

export async function deleteProject(id: string): Promise<void> {
  await request<{ ok: boolean }>(pathFor(id), { method: 'DELETE' })
}
