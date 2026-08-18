import { z } from 'zod'

import { CONTENT_MAX, type Message } from '../messages/schema'
import { projectIdSchema } from '../projects/schema'

/**
 * `POST /generate`'s boundary — the body it accepts and the payloads it emits.
 *
 * **One turn, one request. `content` is the prompt; `retry: true` re-runs the turn
 * already stored.** Exactly one of them, enforced by the refine rather than left
 * to the handler: a body carrying both is a caller that has not decided what it
 * wants, and one carrying neither would silently generate a second reply to
 * whatever the transcript happens to end with.
 *
 * The prompt travels here rather than through a separate message route because a
 * turn that takes two requests can fail between them — the message lands, the
 * client dies, and the transcript keeps a prompt no reply is coming for. The
 * durability that split was protecting is preserved by ordering inside the
 * handler instead: the user turn is written before the stream opens.
 *
 * `projectId` and `content` reuse the schemas the CRUD routes use, so there is one
 * definition of what an id is and one of "too long".
 */
export const generateBodySchema = z
  .object({
    projectId: projectIdSchema,
    content: z.string().trim().min(1).max(CONTENT_MAX).optional(),
    retry: z.literal(true).optional(),
  })
  .strict()
  .refine((body) => (body.content === undefined) !== (body.retry === undefined), {
    message: 'Send either content or retry, and not both.',
  })

export type GenerateBody = z.infer<typeof generateBodySchema>

/**
 * Why a stream ended badly, as the client sees it: `upstream` (the API or the
 * connection failed mid-flight), `refused` (the model declined), `internal`
 * (anything else after the headers were flushed).
 */
export type GenerateErrorCode = 'upstream' | 'refused' | 'internal'

/** `event: token` — one per text delta. Thinking deltas never reach here. */
export interface TokenPayload {
  text: string
}

/**
 * `event: file_start` — a block opened, before any chunk for that path.
 *
 * The path is **syntax only** at this point: validation happens once, at the
 * terminal, over the whole op set. So an unstorable path does appear in the tree
 * while it streams and is gone at `done` — a transient entry that corrects itself
 * beats two validators that can disagree.
 */
export interface FileStartPayload {
  path: string
}

/**
 * `event: file_chunk` — content for one path, tags excluded, repairs applied.
 *
 * **The path is repeated on every chunk**, so a client that drops a `file_start`
 * cannot misroute code into the chat bubble. A mode flag would invite exactly that.
 */
export interface FileChunkPayload {
  path: string
  text: string
}

/** `event: file_end` — the block closed cleanly. An unterminated block gets none. */
export interface FileEndPayload {
  path: string
}

/**
 * `event: done` — the persisted assistant turn. Always the last frame.
 *
 * `files` is the paths actually written, sorted. The client keys its refetch off
 * it: a non-empty list means the server repaired content and computed sizes, so
 * the bytes the browser watched arrive are not necessarily the bytes stored.
 */
export interface DonePayload {
  message: Message
  files: string[]
  fileError: string | null
}

/**
 * `event: user` — the prompt, as it was stored. Emitted once, immediately after
 * the headers, and only for a turn that carried one.
 *
 * Without it the browser would have to invent an id and a timestamp for the bubble
 * it just drew, and be wrong about both until the next refetch.
 */
export interface UserPayload {
  message: Message
}

/**
 * `event: error` — the terminal frame when something went wrong mid-stream.
 *
 * `message` is the **persisted partial**, or `null` when no text had been
 * produced. Carrying it collapses success and interruption into one client path:
 * the placeholder is replaced by what the server stored, so there is no id-less
 * bubble that disagrees with the server on the next load.
 */
export interface ErrorPayload {
  error: string
  code: GenerateErrorCode
  message: Message | null
}
