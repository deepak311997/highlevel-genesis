import { ApiError } from './api'
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

/**
 * Send a prompt, and get back **the user's turn alone** (D3, D4).
 *
 * The reply is no longer part of this request: `POST /generate` streams it and
 * writes it at the stream's terminal event. Two requests rather than one is what
 * makes the prompt durable *before* the expensive half begins, so a generation
 * that dies before its first byte still leaves a transcript the user recognises
 * and a Retry that works.
 *
 * The server keeps the `{ messages: [...] }` envelope with one element in it, so
 * nothing above had to change shape; this unwraps it to the single message the
 * caller actually wants.
 *
 * The body is `{ content }` and nothing else: `role` is assigned server-side, and
 * a body carrying one is refused rather than stripped. That is the shape this
 * function exists to keep.
 */
export async function sendMessage(projectId: string, content: string): Promise<Message> {
  const { messages } = await request<{ messages: Message[] }>(pathFor(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })

  const message = messages[0]
  if (message === undefined) {
    // A 201 with nothing in it is a server that answered and said nothing. The
    // store would otherwise append `undefined` to the transcript; rejecting turns
    // it into the composer's error state, where a person can act on it.
    throw new ApiError('Something went wrong. Please try again.', 500)
  }
  return message
}
