import { z } from 'zod'

import type { Message } from '../messages/schema'
import { projectIdSchema } from '../projects/schema'

/**
 * `POST /generate`'s boundary — the body it accepts and the payloads it emits.
 *
 * **The prompt is not in the body** (D2). The model's input is the project's
 * stored transcript, and the transcript is the server's own record: a body
 * carrying the prompt would let the client's copy disagree with what is stored,
 * so a caller could stream a reply to a prompt that is not in the history the
 * reply gets appended to. That is Slice 4's D5 one level up. It would also
 * duplicate the 4,000-character validation and the 200-message cap in a second
 * place, and it would make Retry a special case instead of the same request
 * again.
 *
 * `projectId` reuses `projectIdSchema` rather than restating the regex, so
 * `/generate` and `/api/projects/:projectId/*` cannot disagree about what an id
 * is. Its message is the *project* copy, deliberately: under this path shape a
 * malformed id and a stranger's id genuinely are the same answer, and `parseBody`
 * surfaces `issues[0].message` as the 400's body.
 */
export const generateBodySchema = z.object({ projectId: projectIdSchema }).strict()

export type GenerateBody = z.infer<typeof generateBodySchema>

/**
 * Why a stream ended badly, as the client sees it.
 *
 * `upstream` — the API failed mid-flight, or the connection did.
 * `refused` — the model declined, `stop_reason: 'refusal'` (D18).
 * `internal` — anything else after the headers were flushed.
 */
export type GenerateErrorCode = 'upstream' | 'refused' | 'internal'

/** `event: token` — one per text delta. Thinking deltas never reach here (D14). */
export interface TokenPayload {
  text: string
}

/**
 * `event: file_start` — a block opened, emitted before any chunk for that path.
 *
 * The path is **syntax only** at this point (D8): validation happens once, at the
 * terminal, over the whole op set. So an unstorable path does get a `file_start`
 * and does appear in the tree while it streams, and is gone the moment the tree
 * refetches at `done`. A transient entry that corrects itself is a better trade
 * than two validators that can disagree.
 */
export interface FileStartPayload {
  path: string
}

/**
 * `event: file_chunk` — content for one path, tags excluded, repairs applied.
 *
 * **The path is repeated on every chunk**, which is D5's whole point: a client
 * that drops or fails to understand a `file_start` cannot then misroute code into
 * the chat bubble. A mode flag would invite exactly that failure.
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
 * `files` is the paths actually **written**, sorted (P8), and empty when none
 * were. `fileError` is one user-facing sentence or `null`. The client keys its
 * refetch off `files`: a non-empty list means the server has repaired content and
 * computed `size` and the timestamps, so the bytes the browser watched arrive are
 * not necessarily the bytes that were stored (D20).
 */
export interface DonePayload {
  message: Message
  files: string[]
  fileError: string | null
}

/**
 * `event: error` — the terminal frame when something went wrong mid-stream.
 *
 * `message` is the **persisted partial**, or `null` when no text had been
 * produced (D9). Carrying it here is what collapses success and interruption into
 * one client code path: whatever arrives, the placeholder bubble is replaced by
 * what the server actually stored, so there is no second rendering path with its
 * own bugs and no id-less bubble that disagrees with the server on the next load.
 */
export interface ErrorPayload {
  error: string
  code: GenerateErrorCode
  message: Message | null
}
