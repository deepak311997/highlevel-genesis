import { ApiError, apiUrl, errorForResponse } from './api'
import { authHeaders, noteApiError, noteSessionAlive } from './apiClient'
import type { Message } from './messagesApi'
import { createSseParser } from './sse'

/**
 * `POST /generate` — the one call in the app that cannot go through `request`.
 *
 * ## Why not `request`, and why not `EventSource`
 *
 * `request` reads the whole body as JSON, which is exactly what must not happen
 * here. `EventSource` cannot set headers and cannot `POST` (D11), so it can
 * carry neither the ID token nor the App Check token — the workaround is a
 * credential in the query string, which puts a bearer token into browser
 * history, Hosting access logs and any intermediary's. Its built-in reconnect
 * would also silently start a *second* paid generation, which is not a feature
 * this endpoint wants.
 *
 * So: `fetch` with a `ReadableStream`, credentials from the shared
 * `authHeaders()` (D32), and the frames parsed by `sse.ts`.
 *
 * ## D9's two channels are one code path for the caller
 *
 * A refusal decided **before** the server flushed its headers is an ordinary
 * JSON error with a real status, so this **rejects, before yielding anything** —
 * which is what stops a placeholder bubble appearing for a request that never
 * opened. A failure that happened mid-stream arrives as an `error` event on a
 * 200, and is yielded like any other event. The store therefore has one `try`
 * and one loop.
 *
 * ## Narrowing is hand-written, not Zod
 *
 * `frontend/` has no Zod dependency and `messagesApi.ts` already establishes
 * that the typed clients assert the wire shape by hand. Adding a package for
 * three payloads is not the trade. Unrecognised events are skipped, and a
 * malformed one is skipped rather than thrown: a stream that died on one bad
 * frame would lose the whole reply, terminal event included.
 *
 * ## Every file frame repeats its path (D5)
 *
 * That is what lets the store route a chunk without tracking a mode — and what
 * stops a client that dropped a `file_start` from putting code in the chat
 * bubble. `token` keeps its meaning and carries chat text only.
 */

export type GenerateEvent =
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
 * A message off the wire, or `null`.
 *
 * Shallow on purpose: this checks the fields the panel actually renders. A
 * deeper check would be a schema, and a schema would be Zod.
 */
function asMessage(value: unknown): Message | null {
  if (!isRecord(value)) return null
  const { id, role, content, createdAt, truncated } = value
  if (typeof id !== 'string' || typeof content !== 'string' || typeof createdAt !== 'string') {
    return null
  }
  if (role !== 'user' && role !== 'assistant') return null
  return { id, role, content, createdAt, truncated: truncated === true }
}

/**
 * The paths a generation wrote, or an empty list.
 *
 * Tolerant by design: a `done` from a server that predates the file half, or one
 * whose new fields arrived malformed, must still replace the placeholder bubble.
 * Defaulting is the difference between "no files were written" and a broken
 * reply — and an empty list is exactly what "no files were written" means, so the
 * fallback is also the truthful answer.
 */
function asFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  /*
   * Built by narrowing rather than asserted with `as`: `Array.isArray` proves
   * only that this is an array, and one entry that is not a string makes the
   * whole list untrustworthy rather than partially usable — the paths are what
   * the store refetches by.
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
    // `message` is legitimately null when no text had been produced (D9).
    return { type: 'error', error, code, message: asMessage(data['message']) }
  }

  return null
}

export async function* streamGeneration(
  projectId: string,
  signal: AbortSignal,
): AsyncGenerator<GenerateEvent> {
  let res: Response
  try {
    res = await fetch(apiUrl('/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      // Exactly `{ projectId }` (D2). The prompt is the server's own record.
      body: JSON.stringify({ projectId }),
      signal,
    })
  } catch (err) {
    // An `ApiError` from `authHeaders` is already the right shape; a `TypeError`
    // from `fetch` is a network failure, and status 0 with advice is the only
    // thing that is ever right to say about one.
    if (err instanceof ApiError) throw err
    throw new ApiError('Something went wrong. Check your connection and try again.', 0)
  }

  // Before a single event is yielded (AC-31) — and through `noteApiError`, so
  // that a session which died while this tab sat open signs the user out from
  // here too (AC-16). This is the only call in the app that does not go through
  // `request`, so without these three lines it would be the one hole in the
  // hook, on the call a long-open tab is most likely to make.
  if (!res.ok) {
    const err = await errorForResponse(res)
    noteApiError(err)
    throw err
  }

  // The stream opened, which is proof the session is alive: the same latch
  // `request` clears, cleared from the same evidence.
  noteSessionAlive()

  const reader = res.body?.getReader()
  if (reader === undefined) {
    throw new ApiError('Something went wrong. Please try again.', res.status)
  }

  const parser = createSseParser()
  // `{ stream: true }` so a multi-byte character split across two chunks
  // survives — the byte-level counterpart of the frame-level problem `sse.ts`
  // solves.
  const decoder = new TextDecoder()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      const event = toEvent(frame.event, frame.data)
      if (event !== null) yield event
    }
  }
}
