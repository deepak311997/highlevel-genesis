import { z } from 'zod'

import { projectsPath } from '../projects/schema'
import { firestoreTimestamp } from '../users/schema'

/**
 * `users/{uid}/projects/{projectId}/messages/{messageId}` — a chat message, and
 * the boundaries around it.
 *
 * The documents are written only by the Admin SDK inside
 * `/api/projects/:projectId/messages`; `firestore.rules` denies the collection to
 * every client, owner included. This file is where the shape of it is stated,
 * from two directions: what a caller may send, and what the stored document must
 * look like to be usable.
 *
 * **`role` is not in the body schema, and that is the security decision of the
 * slice** (D5). The server assigns it, so a body carrying one is a 400 under
 * `.strict()` rather than a key we happened not to read. Slice 4 recorded that it
 * would matter from Slice 5 on, and it now does: the transcript *is* the LLM's
 * context, so a client that could author an assistant turn could write its own
 * future prompt into a context that will also carry HighLevel API knowledge and
 * the user's project files. Refused before anything depended on it being allowed.
 *
 * **The path is the ownership.** A message lives under its project, which lives
 * under its owner's uid — the one `withVerifiedUser` read off the ID token — so
 * there is no `ownerUid` field here and no equality check anywhere. Another
 * user's transcript is not addressable by a request rather than merely refused.
 */

export const MESSAGES = 'messages'

/**
 * The most messages one project may hold, and the most the list returns.
 *
 * The two are the same number on purpose, which is `PROJECT_LIMIT` /
 * `LIST_LIMIT`'s rule one level down: an unpaginated list is only honest if it
 * cannot truncate. 200 messages is 100 exchanges. It is a product limit the
 * composer states out loud (AC-32), not a hidden truncation.
 */
export const MESSAGE_LIMIT = 200

/** About a page of prose, which is what a considered prompt looks like. */
export const CONTENT_MAX = 4000

/**
 * One place composes the path, from `projectsPath` rather than a second `'users'`
 * literal, so the three segments cannot drift.
 */
export function messagesPath(uid: string, projectId: string): string {
  return `${projectsPath(uid)}/${projectId}/${MESSAGES}`
}

/**
 * The `POST` body — `content`, and nothing else.
 *
 * The trim happens before the limit, so padding cannot be smuggled past it, and
 * `.min(1)` after the trim is what makes a whitespace-only prompt a 400 rather
 * than an empty bubble. Enforced here and not in the composer, because the
 * composer is not the boundary.
 */
export const createMessageBodySchema = z
  .object({ content: z.string().trim().min(1).max(CONTENT_MAX) })
  .strict()

export type CreateMessageBody = z.infer<typeof createMessageBodySchema>

/**
 * The stored document, **parsed rather than asserted**.
 *
 * Nothing here carries a `.catch`, and that is the whole of D27: content is the
 * message, `createdAt` is how it is ordered and dated, `seq` is what breaks the
 * commit-timestamp tie, and a `role` outside the two has no side of the
 * transcript to sit on. A document missing or corrupting any of them cannot be
 * rendered in the right place, so it is *known* to be unusable and omitted —
 * there is no by-id read of a message, so omission is the whole behaviour.
 *
 * **`content` deliberately carries no maximum** (D11), where the body schema has
 * one. The echo of a 4,000-character prompt is longer than 4,000 characters, so a
 * maximum here would make the server's own write unreadable on the way back out.
 * A stored document is not a request body.
 */
export const storedMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    seq: z.number().int().min(0),
    createdAt: firestoreTimestamp,
    /**
     * Whether the reply stopped short of what the model had to say (D24).
     *
     * `true` for a client disconnect, a mid-stream failure, `stop_reason:
     * 'max_tokens'`, and the 800,000-byte accumulation cap. One flat boolean
     * rather than a discriminated union on `role`: the union is the right instinct
     * in general, and for a single flag it doubles the schema a reviewer reads and
     * buys nothing.
     *
     * **Defaulted, not `.catch`ed**, and the difference is D27's rule holding.
     * Slice 4's documents do not carry this field at all, so a required one would
     * make every message written before this slice unreadable — silently emptying
     * every existing transcript (R7). A default on an *absent* field is a
     * migration. A `.catch` on a *corrupt* one would be silently accepting a
     * document that is wrong about itself, which is the thing D27 forbids: a
     * `truncated: 'yes'` is a bug somewhere, not an old document.
     */
    truncated: z.boolean().default(false),

    /**
     * Why the turn failed, or `null` for one that did not.
     *
     * A failed generation used to persist nothing at all — the reply was written
     * only when it had prose, so an upstream error before the first token left a
     * transcript ending on a prompt, and the only trace was an in-memory flag
     * that a refresh cleared. The chat could not show what happened because
     * nothing had been written down.
     *
     * Defaulted rather than required, for `truncated`'s reason: every message
     * written before this field existed lacks it, and a required field would make
     * those documents unreadable and silently empty the transcript.
     */
    error: z.string().nullable().default(null),
  })
  /**
   * **A message says something: prose, or the reason there is none.**
   *
   * This is `min(1)` on `content`, narrowed rather than dropped. A generation
   * that fails before its first token now persists an assistant document with
   * no prose and an `error`, which is what lets a failure survive a refresh — and
   * a blanket minimum made the server's own write unreadable on the way back
   * out: the handler committed it, the read-back refused to parse it, and the
   * turn ended in an `internal` frame instead of the `upstream` one it had
   * already decided on.
   *
   * What the rule was protecting is still protected. A blank document with
   * nothing to explain it cannot be rendered as anything but an empty bubble, so
   * it is still *known* to be unusable and still omitted (D27).
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
