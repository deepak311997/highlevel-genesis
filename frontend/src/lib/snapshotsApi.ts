import { request } from './apiClient'
import type { FileMeta } from './filesApi'

/**
 * The snapshot routes — **the whole of the browser's access to the collection.**
 *
 * `users/{uid}/projects/{projectId}/snapshots` and its `files` subcollection are
 * denied to every client by `firestore.rules`, so there is no second path to the
 * data and no `onSnapshot` to fall back on. Liveness is a refetch: the list is
 * read again after a restore, and after a generation that wrote files.
 *
 * The owner's uid is never sent. It lives in the ID token the API client
 * attaches and the server composes every document path from it — which is why
 * these paths name a project and a version, and never a user.
 */

/** Mirrors the server's `SnapshotOrigin`. Two values, and the labels are exhaustive over them. */
export type SnapshotOrigin = 'generation' | 'restore'

/**
 * One version, as the list renders it — **metadata only**.
 *
 * There is deliberately no `files` and no `content`: a version is up to 20 files
 * of up to 100 KB each, and opening a history sheet must not ship a megabyte of
 * code nobody has asked to restore. The server's list route projects the same
 * six fields, so this type is the wire shape rather than a subset of it.
 */
export interface Snapshot {
  id: string
  seq: number
  createdAt: string
  origin: SnapshotOrigin
  fileCount: number
  totalBytes: number
}

/**
 * What a restore answers with: the project's file list **after** the restore,
 * and whether anything actually changed.
 *
 * `changed: false` is the no-op — the project already held exactly this version —
 * and it is a success rather than a refusal. The store uses it to decide whether
 * the tabs need reconciling at all.
 */
export interface RestoreResult {
  files: FileMeta[]
  changed: boolean
}

/**
 * Both segments are server-generated strings that reached us over the wire, so
 * neither is trusted to be path-safe. The server refuses anything outside
 * `[A-Za-z0-9_-]` for either id; this makes the two agree rather than relying on
 * the refusal.
 */
function listPathFor(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/snapshots`
}

export async function listSnapshots(projectId: string): Promise<Snapshot[]> {
  const { snapshots } = await request<{ snapshots: Snapshot[] }>(listPathFor(projectId))
  return snapshots
}

/**
 * Restore one version, and get back the project's file list.
 *
 * **No body and no `Content-Type`.** The server parses `z.object({}).strict()`,
 * so anything carrying a key is a 400 — the version to restore is named by the
 * URL, and there is nothing else for a caller to say. Sending `'{}'` with a
 * header would be a body that happens to be empty, which is one refactor away
 * from being a body that is not.
 */
export async function restoreSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<RestoreResult> {
  return request<RestoreResult>(
    `${listPathFor(projectId)}/${encodeURIComponent(snapshotId)}/restore`,
    { method: 'POST' },
  )
}
