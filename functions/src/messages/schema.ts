import { z } from 'zod'

import { projectsPath } from '../projects/schema'
import { firestoreTimestamp } from '../users/schema'

/**
 * `users/{uid}/projects/{projectId}/messages/{messageId}` — a chat message, and
 * the boundaries around it.
 *
 * Written only by the Admin SDK; `firestore.rules` denies the collection to every
 * client. **`role` is the server's to assign** — the transcript *is* the model's
 * context, so a client that could author an assistant turn could write its own
 * future prompt into a context carrying HighLevel knowledge and the user's files.
 * `/generate`'s `.strict()` body is where that is refused.
 *
 * **The path is the ownership**: a message lives under its project, which lives
 * under its owner's uid, so there is no `ownerUid` field and no equality check.
 */

export const MESSAGES = 'messages'

/**
 * The most messages one project may hold, and the most the list returns — the
 * same number, so the list cannot truncate. 200 messages is 100 exchanges, and it
 * is a product limit the composer states out loud rather than a hidden cut-off.
 */
export const MESSAGE_LIMIT = 200

/** About a page of prose, which is what a considered prompt looks like. */
export const CONTENT_MAX = 4000

/** One place composes the path, so the three segments cannot drift. */
export function messagesPath(uid: string, projectId: string): string {
  return `${projectsPath(uid)}/${projectId}/${MESSAGES}`
}

/**
 * The stored document, **parsed rather than asserted**.
 *
 * Nothing here carries a `.catch`: a document missing or corrupting any of these
 * cannot be rendered in the right place, so it is omitted — and there is no by-id
 * read of a message, so omission is the whole behaviour.
 *
 * **`content` carries no maximum**, where a request body would: the echo of a
 * 4,000-character prompt is longer than 4,000 characters, so a maximum here would
 * make the server's own write unreadable on the way back out.
 */
export const storedMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    seq: z.number().int().min(0),
    createdAt: firestoreTimestamp,
    /**
     * Whether the reply stopped short of what the model had to say — a client
     * disconnect, a mid-stream failure, `max_tokens`, or the accumulation cap.
     *
     * **Defaulted, not `.catch`ed.** Documents written before this field existed do
     * not carry it, and a required field would make every one of them unreadable;
     * a `.catch` would instead accept a document that is wrong about itself.
     */
    truncated: z.boolean().default(false),
    /**
     * Why the turn failed, or `null` for one that did not — which is what lets a
     * failure survive a refresh. Defaulted for `truncated`'s reason: documents
     * written before this field existed lack it.
     */
    error: z.string().nullable().default(null),
  })
  /**
   * **A message says something: prose, or the reason there is none.**
   *
   * `min(1)` on `content`, narrowed rather than dropped. A generation that fails
   * before its first token persists an assistant document with no prose and an
   * `error`, and a blanket minimum made that write unreadable on the way back out
   * — the turn then ended in an `internal` frame instead of the `upstream` one it
   * had already decided on. A blank document with nothing to explain it is still
   * omitted.
   */
  .refine((message) => message.content.length > 0 || message.error !== null)

export type StoredMessage = z.infer<typeof storedMessageSchema>

/**
 * The wire shape. Timestamps are ISO-8601 strings — the project's convention
 * since Slice 2.
 *
 * **`seq` is deliberately not here.** It is an ordering mechanism the server
 * owns, and the array it produces is already in order, so the field has no wire
 * representation at all — leaving it off the type is what stops it reaching one
 * by accident.
 */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  truncated: boolean
  /** Why the turn failed, or `null`. See the stored schema. */
  error: string | null
}

export function toMessage(id: string, stored: StoredMessage): Message {
  return {
    id,
    role: stored.role,
    content: stored.content,
    createdAt: stored.createdAt.toDate().toISOString(),
    truncated: stored.truncated,
    error: stored.error,
  }
}
