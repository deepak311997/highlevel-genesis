import { request } from './apiClient'

/**
 * The message routes — **the whole of the browser's access to a transcript.**
 *
 * `users/{uid}/projects/{projectId}/messages` is denied to every client by
 * `firestore.rules`, so there is no second path to the data and no `onSnapshot` to
 * fall back on. Liveness after a send is the message the server returned (D12),
 * which is not a splice guessing at server order: a transcript only ever appends,
 * so the document the server just wrote is by construction its newest member. The
 * reply's liveness is the SSE stream — see `generateApi.ts`.
 *
 * The owner's uid is never sent. It lives in the ID token the API client attaches,
 * and the server composes the document path from it — which is why these paths
 * name a project and never a user.
 */

/** Mirrors the server's wire shape. Timestamps are ISO-8601 strings. */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /**
   * Whether the reply stopped short (D24). `true` for a client disconnect, a
   * mid-stream failure, `stop_reason: 'max_tokens'` and the server's byte cap —
   * one flag for all four, so the panel has one thing to render.
   */
  truncated: boolean
  /**
   * Why the turn failed, or `null` for one that did not (D2 of this change).
   *
   * A failed generation used to persist nothing, so the transcript could not
   * show what had happened and a refresh cleared the only trace. The reply is
   * now written even when it has no prose, carrying the reason.
   */
  error: string | null
}

/**
 * The server's cap, mirrored.
 *
 * Duplicated rather than imported: the functions package is not reachable from
 * `frontend/`, the same reason `projectsApi.ts` restates the wire shape. It is a
 * product limit the composer states out loud, so the number has to exist on this
 * side too — and its L1 test pins the copy.
 */
export const MESSAGE_LIMIT = 200

/**
 * An id is a server-generated string that reached us over the wire, so it is
 * encoded rather than trusted to be path-safe. The server refuses anything outside
 * `[A-Za-z0-9_-]`; this makes the two agree rather than relying on the refusal.
 */
function pathFor(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/messages`
}

export async function listMessages(projectId: string): Promise<Message[]> {
  const { messages } = await request<{ messages: Message[] }>(pathFor(projectId))
  return messages
}

