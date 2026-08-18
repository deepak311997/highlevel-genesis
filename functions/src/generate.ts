import cors from 'cors'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { onRequest } from 'firebase-functions/v2/https'

import { ALLOWED_ORIGINS, originAllowlist } from './api'
import { requireAppCheck } from './auth/appCheck'
import { withVerifiedUser } from './auth/requireUser'
import { emulatorNumber } from './lib/env'
import { asyncHandler, errorHandler, HttpError } from './lib/errors'
import { logGenerationEvent, type GenerationLogContext } from './lib/log'
import { parseBody } from './lib/parse'
import { encodeSse, encodeSseComment } from './lib/sse'
import {
  ANTHROPIC_API_KEY,
  buildContext,
  buildParams,
  countHlCalls,
  createFileCollector,
  writtenText,
  extractHlCalls,
  generateBodySchema,
  mapStream,
  openStream,
  type CollectorFrame,
  type FileCollector,
  type GenerateErrorCode,
  type LlmEvent,
} from './llm'
import { planFileWrites, readProjectFiles } from './files/handlers'
import { fileErrorCopy } from './files/schema'
import { appendAssistantMessage, appendUserMessage, readTranscript } from './messages/handlers'
import { MESSAGE_LIMIT } from './messages/schema'
import { notFound, readProject } from './projects/handlers'
import { planSnapshot } from './snapshots/handlers'

/**
 * `POST /generate` — the streaming generation endpoint.
 *
 * Its own function, because it needs `timeoutSeconds: 540` and 512 MiB and the
 * CRUD endpoints must not pay for either. Its own Express app, because
 * `onRequest` types its response from a different `@types/express` major than
 * this package depends on, and an `Express` application is the shape it already
 * accepts — one app rather than one cast at every helper.
 *
 * **Two failure channels, and the boundary is `flushHeaders()`.** Once the
 * headers are gone the status line is spent, so everything decidable cheaply is
 * decided first and answered as ordinary JSON; only mid-flight failures become an
 * `error` frame on a 200. `handleGenerate`'s order is that rule executed, and
 * `terminalErrorHandler` is the same rule from the catch side.
 */

/** Milliseconds between keep-alive comments while nothing else is written. */
const KEEP_ALIVE_MS = 15_000

/**
 * The interval, with a test override that no `.env` file can overrule.
 *
 * Honoured only under `FUNCTIONS_EMULATOR`; the suites set 250 ms so the
 * keep-alive is a two-second test rather than a twenty-second one.
 */
export function keepAliveMs(): number {
  return emulatorNumber('GENERATE_TEST_KEEPALIVE_MS', KEEP_ALIVE_MS)
}

/**
 * One collector frame as one SSE frame — a `switch` rather than a lookup, so a
 * new frame kind is a type error rather than a silently dropped frame.
 */
function encodeFrame(frame: CollectorFrame): string {
  switch (frame.kind) {
    case 'token':
      return encodeSse('token', { text: frame.text })
    case 'file_start':
      return encodeSse('file_start', { path: frame.path, mode: frame.mode })
    case 'file_chunk':
      return encodeSse('file_chunk', { path: frame.path, text: frame.text })
    case 'file_end':
      return encodeSse('file_end', { path: frame.path })
    case 'edit_start':
      return encodeSse('edit_start', { path: frame.path, from: frame.from, to: frame.to })
    case 'edit_chunk':
      return encodeSse('edit_chunk', { path: frame.path, text: frame.text })
    case 'edit_end':
      return encodeSse('edit_end', { path: frame.path })
  }
}

/** Write and end, unless the socket has already gone — Slice 0's check. */
function writeTerminalFrame(res: Response, frame: string): void {
  if (res.destroyed || res.writableEnded) return
  res.write(frame)
  res.end()
}

/**
 * One line per turn, on every path — completion, refusal, failure, disconnect.
 *
 * **Projected field by field rather than spread**, which is why the function
 * exists: the call site builds its argument from an `LlmEvent` carrying the
 * reply's text, and one `...event` there would put every conversation on the
 * platform into Cloud Logging.
 */
export function logGeneration(context: GenerationLogContext): void {
  logGenerationEvent('generation.complete', {
    model: context.model,
    stopReason: context.stopReason,
    truncated: context.truncated,
    durationMs: context.durationMs,
    inputTokens: context.inputTokens,
    outputTokens: context.outputTokens,
    cacheCreationInputTokens: context.cacheCreationInputTokens,
    cacheReadInputTokens: context.cacheReadInputTokens,
    hlCallsKnown: context.hlCallsKnown,
    hlCallsUnknown: context.hlCallsUnknown,
  })
}

/**
 * The error handler, on both sides of the flush: the ordinary JSON envelope
 * before it, and an `error` frame on the 200 that has already gone out after —
 * the client is mid-stream and has to be told something it can parse.
 */
export function terminalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!res.headersSent) {
    errorHandler(err, req, res, next)
    return
  }

  writeTerminalFrame(
    res,
    encodeSse('error', {
      error: 'Something went wrong. Please try again.',
      code: 'internal',
      message: null,
    }),
  )
}

export function createGenerateApp(): Express {
  const app = express()

  app.use(cors({ origin: originAllowlist, credentials: false }))
  // The body is `{ projectId }`; nothing here needs the API app's 1 MB.
  app.use(express.json({ limit: '16kb' }))

  /*
   * Both paths: the emulator strips the function name so the app sees `/`, and a
   * Hosting rewrite forwards the original path so it sees `/generate`.
   */
  const attested = asyncHandler(requireAppCheck)
  const handler = asyncHandler(withVerifiedUser(handleGenerate))
  app.post('/', attested, handler)
  app.post('/generate', attested, handler)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'not_found' })
  })

  app.use(terminalErrorHandler)

  return app
}

export const generate = onRequest(
  {
    // Safe to grant because the handler is authenticated, attested and
    // email-verified: a nine-minute *unauthenticated* function is a slow-loris
    // target.
    timeoutSeconds: 540,
    memory: '512MiB',
    /*
     * `ALLOWED_ORIGINS` as well as the model key: `originAllowlist` is imported
     * from `./api`, and without the binding it resolves to `''` here and falls
     * back to the localhost defaults — accepting the real site on `api` and
     * rejecting it on this one.
     */
    secrets: [ANTHROPIC_API_KEY, ALLOWED_ORIGINS],
    cors: false,
  },
  createGenerateApp(),
)

/**
 * One turn, and the order is the whole of the two-channel rule: body, project,
 * message cap, context, the project's files, then the upstream stream. Each can
 * still answer with a real status line. Only then do headers go out.
 */
export async function handleGenerate(req: Request, res: Response, uid: string): Promise<void> {
  const { projectId, content } = parseBody(generateBodySchema, req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  const stored = await readTranscript(uid, projectId)

  /*
   * **A new turn needs room for two documents, a retry for one.** This request
   * writes both halves, so refusing a new turn at 199 is what stops a transcript
   * ending on a prompt with nowhere to put its answer — and refusing a retry at
   * 200 is what stops `transcriptQuery`'s own limit hiding the reply that just
   * arrived. Checked before a token is bought and before the prompt is stored.
   */
  const needed = content === undefined ? 1 : 2
  if (stored.length + needed > MESSAGE_LIMIT) {
    throw new HttpError(
      409,
      `This project has reached its limit of ${String(MESSAGE_LIMIT)} messages.`,
      'message_limit',
    )
  }

  /*
   * The prompt goes down **before** the stream opens, so any failure from here
   * on has a stored turn to be attached to. `content` absent means `retry: true`
   * — the prompt is already in the transcript and nothing is written.
   */
  const userMessage =
    content === undefined ? null : await appendUserMessage(uid, projectId, content)
  const transcript = userMessage === null ? stored : [...stored, userMessage]

  const context = buildContext(transcript)
  if (context.length === 0) {
    throw new HttpError(
      400,
      'There is nothing to generate from yet. Send a message first.',
      'empty_context',
    )
  }

  /*
   * The project's files, which become the system block after the `cache_control`
   * breakpoint. Read before the flush, deliberately: it is a third way this path
   * can fail, and here a failure is still a real status line.
   */
  const files = await readProjectFiles(uid, projectId)

  const startedAt = Date.now()
  const stream = await openStream(buildParams(context, files))

  /*
   * The client leaving aborts the generation — an orphaned one still bills — and
   * what it produced is still persisted.
   *
   * **The listener is on `res`, not `req`.** `express.json()` has already drained
   * the request body, so `req` has emitted its `close` before this runs and the
   * disconnect would never be observed. `writableEnded` tells a finished response
   * apart from a terminated connection.
   */
  let clientGone = false
  res.on('close', () => {
    if (res.writableEnded) return
    clientGone = true
    stream.abort()
  })

  res.status(200)
  res.set('Content-Type', 'text/event-stream; charset=utf-8')
  res.set('Cache-Control', 'no-cache, no-transform')
  // Belt and braces against an intermediary that buffers on its own.
  res.set('X-Accel-Buffering', 'no')
  /*
   * **`Connection` is deliberately not set.** It is hop-by-hop, and with
   * `keep-alive` on it the next `POST /generate` over the reused socket comes
   * back as an empty 400 — the second prompt of every conversation fails.
   */
  res.flushHeaders()

  // One comment straight away, so the client sees bytes — and therefore knows
  // the request was accepted — before the model has thought of anything.
  res.write(encodeSseComment())

  // The prompt as stored, so the bubble the browser drew optimistically can be
  // replaced by the real document rather than guessing at its id and timestamp.
  if (userMessage !== null) res.write(encodeSse('user', { message: userMessage }))

  /*
   * The first token can be seconds away, and an intermediary that closes an idle
   * connection would kill the request during the model's most productive moment.
   * `wroteSinceTick` keeps the comment out of a stream that is already flowing.
   */
  let wroteSinceTick = true
  const keepAlive = setInterval(() => {
    if (res.destroyed || res.writableEnded) return
    if (wroteSinceTick) {
      wroteSinceTick = false
      return
    }
    res.write(encodeSseComment())
  }, keepAliveMs())

  // The splitter sits between the mapper and the framing: nothing above it knows
  // the file-tag grammar exists.
  const collector = createFileCollector(files)

  try {
    for await (const event of mapStream(stream)) {
      if (event.kind === 'token') {
        // Pushed before the socket check: the files are written whether or not
        // anyone is listening, so a disconnect stops the writing, not the parsing.
        const frames = collector.push(event.text)

        // Guards the write rather than breaking the loop: the terminal event
        // still has to run, since that is what persists the partial.
        if (!res.destroyed && frames.length > 0) {
          wroteSinceTick = true
          for (const frame of frames) res.write(encodeFrame(frame))
        }
        continue
      }

      await finishTurn(res, uid, projectId, event, clientGone, Date.now() - startedAt, collector)
      return
    }
  } finally {
    clearInterval(keepAlive)
  }

  if (!res.writableEnded) res.end()
}

/** The user-facing copy for each way a stream can end badly. */
const ERROR_COPY: Record<GenerateErrorCode, string> = {
  upstream: 'The reply was interrupted. Try again.',
  refused: 'Claude declined to answer that. Try rephrasing.',
  internal: 'Something went wrong. Please try again.',
}

/**
 * The terminal event — every way a turn can end, in one place.
 *
 * **Success and interruption are one code path**: whichever frame goes out, it
 * carries the document that was stored, so the client replaces its placeholder
 * with the server's record rather than with its own accumulated text.
 *
 * **`clientGone` forces `truncated`** rather than trusting the mapper. `abort()`
 * makes the iterator throw, which maps to an `upstream` error — but a stream
 * that happened to stop cleanly would otherwise be persisted as complete.
 */
async function finishTurn(
  res: Response,
  uid: string,
  projectId: string,
  event: Extract<LlmEvent, { kind: 'end' | 'error' }>,
  clientGone: boolean,
  durationMs: number,
  collector: FileCollector,
): Promise<void> {
  // An `end` carries the mapper's verdict — false on `end_turn`, true on
  // `max_tokens` and on the byte cap — and every `error` is incomplete.
  const truncated = clientGone || (event.kind === 'end' ? event.truncated : true)

  /*
   * The end-of-input flush, above the log line so the counters have something to
   * count. A delimiter may end at end of input as well as at a newline, so a
   * reply whose last bytes are `</genesis:file>` resolves its close here.
   */
  const collected = collector.finish()

  /*
   * **The file blocks, not the chat text**: a call described in prose is not one
   * the app will ever run, and counting it would make the number mean "mentions".
   */
  const hlCalls = countHlCalls(extractHlCalls(writtenText(collected.steps)), process.env)

  // Before the frame, so a turn is accounted for even if the socket dies while
  // it is being told about.
  logGeneration({
    model: event.model,
    stopReason: event.stopReason,
    truncated,
    durationMs,
    hlCallsKnown: hlCalls.known,
    hlCallsUnknown: hlCalls.unknown,
    ...event.usage,
  })

  if (!res.destroyed) {
    for (const frame of collected.frames) res.write(encodeFrame(frame))
  }

  /*
   * **The mapper's flag, not `truncated` above.** They differ for a client that
   * disconnects after a clean `end`: the message is marked truncated, and the
   * files are still written — they belong to the project, not the connection.
   */
  const completed = event.kind === 'end' && !event.truncated
  const plan = await planFileWrites(uid, projectId, collected, completed)

  /*
   * The refusal goes into the transcript as a marker line, and it goes out as a
   * `token` frame first — so the stored content stays exactly the concatenation of
   * the frames the client received, and the reason survives a reload *and* reaches
   * the model on the next turn, which is what makes Retry a repair rather than a
   * re-roll. The copy is stripped of `]` and newlines, which are the only two
   * characters that could break the marker out of its own line.
   */
  const fileError = plan.error === null ? null : fileErrorCopy(plan.error)
  const errorMarker =
    fileError === null ? '' : `\n[error: ${fileError.replace(/[\]\n]/g, '')}]\n`
  if (errorMarker !== '' && !res.destroyed) {
    res.write(encodeFrame({ kind: 'token', text: errorMarker }))
  }
  const content = collected.messageText + errorMarker

  /*
   * Why the turn failed, persisted with it — which is what lets a failure
   * survive a refresh. Without it, an upstream error before the first token left
   * a transcript ending on a prompt and a footer alert a reload cleared.
   */
  const failure = event.kind === 'error' ? event.code : null

  /*
   * A turn with nothing to say and nothing to report writes nothing, and pays
   * for no snapshot read either. The content is the collector's `messageText`,
   * not the mapper's raw accumulation, which still carries the tags and the code.
   *
   * The snapshot is planned here and staged on the batch `appendAssistantMessage`
   * already owns; it is never committed separately.
   */
  const message =
    content === '' && failure === null
      ? null
      : await appendAssistantMessage(uid, projectId, {
          content,
          truncated,
          error: failure,
          fileWrites: plan.writes,
          snapshot:
            plan.writes.length > 0
              ? await planSnapshot(uid, projectId, plan.resulting, 'generation')
              : null,
        })

  // Nobody is listening, and the partial and its files are already committed —
  // which is the whole of what a returning user needs.
  if (clientGone) return

  if (event.kind === 'end' && message !== null) {
    writeTerminalFrame(
      res,
      encodeSse('done', {
        message,
        // Sorted, which matches the list route's `orderBy('path')`.
        files: plan.writes.map((write) => write.path).sort(),
        fileError,
      }),
    )
    return
  }

  const code: GenerateErrorCode = event.kind === 'end' ? 'upstream' : event.code
  writeTerminalFrame(res, encodeSse('error', { error: ERROR_COPY[code], code, message }))
}
