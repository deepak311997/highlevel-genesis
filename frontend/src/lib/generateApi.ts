import { ApiError, apiUrl, connectionError, errorForResponse } from './api'
import { authHeaders, noteApiError, rearmSessionExpiry } from './apiClient'
import type { Message } from './messagesApi'
import { createSseParser } from './sse'

/**
 * `POST /generate` — the one call in the app that cannot go through `request`.
 *
 * `request` reads the whole body as JSON, which is exactly what must not happen
 * here. `EventSource` cannot set headers and cannot `POST`, so it can carry
 * neither the ID token nor the App Check token — the workaround puts a bearer
 * token into browser history and access logs — and its built-in reconnect would
 * silently start a *second* paid generation. So: `fetch` with a `ReadableStream`,
 * credentials from the shared `authHeaders()`, and the frames parsed by `sse.ts`.
 *
 * **The two failure channels are one code path for the caller.** A refusal decided
 * before the server flushed its headers is an ordinary JSON error, so this
 * *rejects before yielding anything* — which is what stops a placeholder bubble
 * appearing for a request that never opened. A mid-stream failure arrives as an
 * `error` event on a 200 and is yielded like any other.
 *
 * Narrowing is hand-written rather than Zod, matching the other typed clients.
 * Unrecognised and malformed events are skipped rather than thrown: a stream that
 * died on one bad frame would lose the whole reply, terminal event included.
 */

/** What a turn is: a new prompt, or a re-run of the one already stored. */
export type GenerateTurn = { content: string } | { retry: true }

export type GenerateEvent =
  | { type: 'user'; message: Message }
  | { type: 'token'; text: string }
  | { type: 'file_start'; path: string }
  | { type: 'file_chunk'; path: string; text: string }
  | { type: 'file_end'; path: string }
  | { type: 'done'; message: Message; files: string[]; fileError: string | null }
  | { type: 'error'; error: string; code: string; message: Message | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A message off the wire, or `null` — shallow on purpose: this checks the fields
 * the panel actually renders, and a deeper check would be a schema.
 */
function asMessage(value: unknown): Message | null {
  if (!isRecord(value)) return null
  const { id, role, content, createdAt, truncated, error } = value
  if (typeof id !== 'string' || typeof content !== 'string' || typeof createdAt !== 'string') {
    return null
  }
  if (role !== 'user' && role !== 'assistant') return null
  return {
    id,
    role,
    content,
    createdAt,
    truncated: truncated === true,
    // Tolerant like the fields above: anything that is not a string is "did not
    // fail", which is what a server predating this field means by omitting it.
    error: typeof error === 'string' ? error : null,
  }
}

/**
 * The paths a generation wrote, or an empty list.
 *
 * Tolerant by design: a `done` whose new fields arrived malformed must still
 * replace the placeholder bubble, and an empty list is exactly what "no files were
 * written" means — so the fallback is also the truthful answer.
 */
function asFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  /*
   * Built by narrowing rather than asserted: one entry that is not a string makes
   * the whole list untrustworthy rather than partially usable, since the paths are
   * what the store refetches by.
   */
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return []
    paths.push(entry)
  }
  return paths
}

function asFileError(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toEvent(name: string, data: unknown): GenerateEvent | null {
  if (!isRecord(data)) return null

  /*
   * The prompt, as the server stored it — emitted once, before any token, for a
   * turn that carried one. The store swaps its optimistic bubble for this, so the
   * id and the timestamp on screen are the document's rather than a guess.
   */
  if (name === 'user') {
    const message = asMessage(data['message'])
    return message === null ? null : { type: 'user', message }
  }

  if (name === 'token') {
    return typeof data['text'] === 'string' ? { type: 'token', text: data['text'] } : null
  }

  if (name === 'file_start' || name === 'file_end') {
    const path = data['path']
    if (typeof path !== 'string') return null
    return name === 'file_start' ? { type: 'file_start', path } : { type: 'file_end', path }
  }

  if (name === 'file_chunk') {
    const { path, text } = data
    if (typeof path !== 'string' || typeof text !== 'string') return null
    return { type: 'file_chunk', path, text }
  }

  if (name === 'done') {
    const message = asMessage(data['message'])
    if (message === null) return null
    return {
      type: 'done',
      message,
      files: asFiles(data['files']),
      fileError: asFileError(data['fileError']),
    }
  }

  if (name === 'error') {
    const { error, code } = data
    if (typeof error !== 'string' || typeof code !== 'string') return null
    // `message` is legitimately null when no text had been produced.
    return { type: 'error', error, code, message: asMessage(data['message']) }
  }

  return null
}

export async function* streamGeneration(
  projectId: string,
  turn: GenerateTurn,
  signal: AbortSignal,
): AsyncGenerator<GenerateEvent> {
  let res: Response
  try {
    res = await fetch(apiUrl('/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      /*
       * The prompt travels with the request that streams the reply, so a turn
       * cannot half-happen. A retry carries no prompt — the turn it re-runs is
       * already in the transcript.
       */
      body: JSON.stringify({ projectId, ...turn }),
      signal,
    })
  } catch (err) {
    // An `ApiError` from `authHeaders` is already the right shape; a `TypeError`
    // from `fetch` is a network failure, and status 0 with advice is the only thing
    // ever right to say about one.
    if (err instanceof ApiError) throw err
    throw connectionError()
  }

  // Before a single event is yielded, and through `noteApiError`, so a session that
  // died while this tab sat open signs the user out from here too. This is the only
  // call that does not go through `request`, so without these lines it would be the
  // one hole in the hook.
  if (!res.ok) {
    const err = await errorForResponse(res)
    noteApiError(err)
    throw err
  }

  // The stream opened, which is proof the session is alive.
  rearmSessionExpiry()

  const reader = res.body?.getReader()
  if (reader === undefined) {
    throw new ApiError('Something went wrong. Please try again.', res.status)
  }

  const parser = createSseParser()
  // `{ stream: true }` so a multi-byte character split across two chunks survives —
  // the byte-level counterpart of the frame-level problem `sse.ts` solves.
  const decoder = new TextDecoder()

  /*
   * The body is released on **every** exit, and that is what the `try` is for.
   *
   * A consumer that stops reading finalises this generator, and finalising a
   * generator does not close a `fetch` body: the socket stays open, the server's
   * `close` never fires, and the model goes on producing to `max_tokens` for a
   * reply nobody will read. Releasing it here rather than at the call site is the
   * choice the next caller cannot forget.
   */
  try {
    for (;;) {
      /*
       * Only the read is wrapped, deliberately. The opening `fetch`'s failure is
       * mapped above; this is the other half — a connection lost *after* the
       * headers flushed, which otherwise reached the screen as whatever the browser
       * called it: `Failed to fetch` in Chrome, something else in Firefox.
       *
       * An abort rethrows untouched: a user who left the project did not lose their
       * connection. The frame loop stays outside the `try`, so a bug in `sse.ts` is
       * reported as itself rather than laundered into a connection message.
       */
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (err) {
        if (signal.aborted) throw err
        throw connectionError()
      }

      const { done, value } = chunk
      if (done) break

      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        const event = toEvent(frame.event, frame.data)
        if (event !== null) yield event
      }
    }
  } finally {
    // `cancel()` rejects on a stream that already errored — the dropped connection
    // above is exactly that — so the rejection is swallowed rather than replacing
    // the mapped `ApiError` with the browser's own.
    await reader.cancel().catch(() => undefined)
  }
}
