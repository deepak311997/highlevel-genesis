import { request } from './apiClient'

/**
 * The file routes — **the whole of the browser's access to a project's code.**
 *
 * `users/{uid}/projects/{projectId}/files` is denied to every client by
 * `firestore.rules`, so there is no second path to the data and no `onSnapshot`
 * to fall back on. Liveness is a refetch: after a save, the server's answer; after
 * a generation, `listFiles` again, because the server *repairs* content and
 * computes `size` and the timestamps, so the bytes the browser watched arrive are
 * not necessarily the bytes that were stored (D20).
 *
 * The owner's uid is never sent. It lives in the ID token the API client attaches
 * and the server composes the document path from it — which is why these paths
 * name a project and a file, and never a user.
 */

/** Mirrors the server's wire shape. Timestamps are ISO-8601 strings. */
export interface FileMeta {
  /** The filename, which is also the document's id (D13). */
  path: string
  /** The UTF-8 byte length of the content, computed server-side. */
  size: number
  createdAt: string
  updatedAt: string
}

/** What a read and a save return: the metadata, plus the file itself. */
export interface FileContent extends FileMeta {
  content: string
}

/**
 * The server's byte cap, mirrored.
 *
 * Duplicated rather than imported: the functions package is not reachable from
 * `frontend/`, the same reason `messagesApi.ts` restates `MESSAGE_LIMIT` and
 * `projectsApi.ts` restates the wire shape. It exists on this side so the editor
 * can disable **Save** before issuing a request the server would refuse, and its
 * L1 test pins it to the server's number.
 *
 * The **file cap is deliberately not mirrored.** Nothing here could act on it:
 * the client cannot create a file — `PUT` refuses to (D19) and there is no
 * `POST` — so a browser has no path to the twentieth file and no button to
 * withhold. The one writer that can reach the cap is the generator, on the
 * server, where `FILE_LIMIT` lives.
 */
export const FILE_BYTES_MAX = 100_000

/**
 * Both segments are server-generated strings that reached us over the wire, so
 * neither is trusted to be path-safe. The server refuses anything outside
 * `[A-Za-z0-9_-]` for an id and outside the filename schema for a path; this makes
 * the two agree rather than relying on the refusal.
 */
function listPathFor(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/files`
}

function filePathFor(projectId: string, path: string): string {
  return `${listPathFor(projectId)}/${encodeURIComponent(path)}`
}

/** Metadata only — no entry carries `content`. */
export async function listFiles(projectId: string): Promise<FileMeta[]> {
  const { files } = await request<{ files: FileMeta[] }>(listPathFor(projectId))
  return files
}

export async function getFile(projectId: string, path: string): Promise<FileContent> {
  const { file } = await request<{ file: FileContent }>(filePathFor(projectId, path))
  return file
}

/**
 * Save an edit, and get back **the stored document**.
 *
 * The body is `{ content }` and nothing else: `path` comes from the URL, and
 * `size` and both timestamps are the server's to write. The server's schema is
 * `.strict()`, so a body carrying one of them is refused rather than stripped —
 * that is the shape this function exists to keep.
 *
 * `PUT` does not create (D19). A path the project does not hold is a 404, which
 * the store renders as "that file no longer exists" rather than as a new file.
 */
export async function saveFile(
  projectId: string,
  path: string,
  content: string,
): Promise<FileContent> {
  const { file } = await request<{ file: FileContent }>(filePathFor(projectId, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  return file
}
