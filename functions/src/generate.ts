import cors from 'cors'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { onRequest } from 'firebase-functions/v2/https'

import { originAllowlist } from './api'
import { requireAppCheck } from './auth/appCheck'
import { withVerifiedUser } from './auth/requireUser'
import { asyncHandler, errorHandler, HttpError } from './lib/errors'
import { logGenerationEvent, type GenerationLogContext } from './lib/log'
import { parseBody } from './lib/parse'
import { encodeSse, encodeSseComment } from './lib/sse'
import {
  ANTHROPIC_API_KEY,
  buildContext,
  buildParams,
  generateBodySchema,
  mapStream,
  openStream,
  type GenerateErrorCode,
  type LlmEvent,
} from './llm'
import { appendAssistantMessage, readTranscript } from './messages/handlers'
import { MESSAGE_LIMIT } from './messages/schema'
import { notFound, readProject } from './projects/handlers'

/**
 * `POST /generate` — the streaming generation endpoint.
 *
 * ## The path names an action, not a user (D1)
 *
 * Kept from Slice 0, along with its Hosting rewrite and its Vite dev-proxy
 * entry. The project id travels in a `.strict()` body and is ownership-checked
 * against the uid on the token; no path segment names a user. The rejected
 * alternative — `/api/projects/:projectId/generate` — reads better and costs two
 * hand-maintained environment-specific mappings that must agree with each other,
 * which is precisely the class of defect this project has already paid for twice.
 *
 * ## Its own function, and its own Express app
 *
 * The function is separate because it needs `timeoutSeconds: 540` and 512 MiB,
 * and the CRUD endpoints must not pay for either. The *app* is separate for a
 * smaller reason that is worth stating: `onRequest` hands its callback
 * `firebase-functions`' own request and response types, which come from a
 * different `@types/express` major than this package depends on — so a
 * hand-rolled wrapper cannot pass that response to `withVerifiedUser`,
 * `requireAppCheck` or `errorHandler` without a cast. An `Express` application is
 * the shape `onRequest` already accepts (it is how `api` is mounted), and inside
 * it every helper composes exactly as it does everywhere else. One app rather
 * than one cast.
 *
 * ## Two failure channels, and the boundary is `flushHeaders()` (D9, R6)
 *
 * Once the headers are flushed the status line is spent: a stream cannot go back
 * and become a 401. So **everything that can be decided cheaply is decided
 * first** — auth, App Check, the body parse, the project lookup, the empty
 * context, and opening the upstream stream — and each of those is an ordinary
 * JSON error with a real status. Only genuinely mid-flight failures become an
 * `error` event on a 200. `handleGenerate`'s order is that rule, executed, and
 * `terminalErrorHandler` below is the same rule seen from the catch side.
 */

/** Milliseconds between keep-alive comments while nothing else is written. */
const KEEP_ALIVE_MS = 15_000

/**
 * A value the *test scripts* can force, which no `.env` file can overrule.
 *
 * `hl/config.ts`'s `emulatorOverride` pattern exactly: honoured **only** under
 * `FUNCTIONS_EMULATOR`, and the name appears in no `.env` file, so a shell value
 * survives. The suites set it to 250 ms, which turns AC-19 into a two-second test
 * rather than a twenty-second one.
 */
export function keepAliveMs(): number {
  if (process.env['FUNCTIONS_EMULATOR'] !== 'true') return KEEP_ALIVE_MS

  const raw = Number(process.env['GENERATE_TEST_KEEPALIVE_MS'] ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : KEEP_ALIVE_MS
}

/** Write and end, unless the socket has already gone — Slice 0's check. */
function writeTerminalFrame(res: Response, frame: string): void {
  if (res.destroyed || res.writableEnded) return
  res.write(frame)
  res.end()
}

/**
 * The one line per turn — F3.4's generation metadata, in a log (D25).
 *
 * Exported so it has an L1 test that needs no emulator, and because the negative
 * is the assertion that matters: `GenerationLogContext` has no field for message
 * content, so nothing the user wrote and nothing the model wrote can reach Cloud
 * Logging through here.
 *
 * Called once on **every** path — completion, refusal, mid-stream failure and
 * client disconnect alike — and before the frame is written, so a turn is
 * accounted for even if the socket dies while it is being told about.
 */
export function logGeneration(context: GenerationLogContext): void {
  /*
   * Projected field by field rather than passed through, and that is the point
   * of the function existing at all. The call site builds this from an
   * `LlmEvent`, which carries the reply's `text` — one `...event` spread there
   * and every conversation on the platform would be in Cloud Logging. Naming the
   * eight fields means the leak is impossible rather than merely against the
   * rules; the type would catch it at the call site, and this catches it if the
   * type is ever widened.
   */
  logGenerationEvent('generation.complete', {
    model: context.model,
    stopReason: context.stopReason,
    truncated: context.truncated,
    durationMs: context.durationMs,
    inputTokens: context.inputTokens,
    outputTokens: context.outputTokens,
    cacheCreationInputTokens: context.cacheCreationInputTokens,
    cacheReadInputTokens: context.cacheReadInputTokens,
  })
}

/**
 * The terminal handler, and D9 from the catch side.
 *
 * Before the flush this is the ordinary JSON envelope every other route answers
 * with. After it the status line is spent, so the only thing left is an `error`
 * frame on the 200 that has already gone out — the client is mid-stream and has
 * to be told something it can parse.
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
   * Mounted at both paths on purpose. The functions emulator strips the function
   * name, so the app sees `/`; a Hosting rewrite of `/generate` forwards the
   * original path, so the app sees `/generate`. Every router in this codebase
   * carries the same note.
   *
   * Attestation matters more here than on any route so far: this is the first
   * endpoint where an unattested call spends money.
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
    /*
     * Slice 0 pinned 60 seconds deliberately, saying the long timeout would
     * arrive "in Slice 5, together with the ID-token check that makes it safe to
     * grant" (D29). The check is `withVerifiedUser` above, so the grant lands
     * here: an unauthenticated function with a nine-minute timeout is a
     * slow-loris target; an authenticated, attested, email-verified one is not.
     */
    timeoutSeconds: 540,
    // The SDK plus an accumulating string is more than 256 MiB deserves to be
    // tight against.
    memory: '512MiB',
    // Declared here rather than in index.ts, beside the code that reads it.
    secrets: [ANTHROPIC_API_KEY],
    // Not `cors: true` — see the allowlist above.
    cors: false,
  },
  createGenerateApp(),
)

/**
 * One turn.
 *
 * Everything cheap is decided **before** the flush, in this order and for D9's
 * reason:
 *
 * 1. the body — a refusal costs no Firestore call at all;
 * 2. the project — absent, soft-deleted, unreadable and somebody else's collapse
 *    into one 404 (D14), and the path is composed from the token's uid, so
 *    another user's project is not addressable rather than merely refused;
 * 3. the 200-message cap, which this route writes into and so has to honour;
 * 4. the context, with trailing assistant turns dropped (D6);
 * 5. an empty context, which is a 400 before any LLM call (D7);
 * 6. the upstream stream — a missing API key throws here, and it is still an
 *    ordinary 500 with the reason logged rather than surfaced.
 *
 * Only then do headers go out.
 */
export async function handleGenerate(req: Request, res: Response, uid: string): Promise<void> {
  const { projectId } = parseBody(generateBodySchema, req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  const transcript = await readTranscript(uid, projectId)

  /*
   * The cap, honoured by the endpoint that also writes into the collection.
   *
   * `POST /api/projects/:projectId/messages` refuses at 199 so the reply it is
   * about to trigger has room — but this route writes an assistant message
   * without going through that one, and Retry re-opens it with no new user
   * message at all (D26). Left unchecked, a transcript at the cap grows past it
   * once per Retry, and `transcriptQuery`'s own `limit(MESSAGE_LIMIT)` then
   * hides every document beyond the two-hundredth: the reply arrives on screen
   * and is gone on the next load. D34 leans on this cap to bound a project's
   * spend absolutely, so the endpoint that spends the money enforces it too.
   *
   * Same status, code and copy as the message route, because it is the same
   * limit — a caller should not have to learn two ways to be told one thing.
   */
  if (transcript.length >= MESSAGE_LIMIT) {
    throw new HttpError(
      409,
      `This project has reached its limit of ${String(MESSAGE_LIMIT)} messages.`,
      'message_limit',
    )
  }

  const context = buildContext(transcript)
  if (context.length === 0) {
    throw new HttpError(
      400,
      'There is nothing to generate from yet. Send a message first.',
      'empty_context',
    )
  }

  const startedAt = Date.now()
  const stream = await openStream(buildParams(context))

  /*
   * D21, AC-17, AC-18. Aborting rather than letting the generation run to
   * completion is half the decision — an orphaned generation still bills — and
   * persisting what it produced is the other: a user who closed the tab
   * mid-reply comes back to what had been written, not to a prompt with no
   * answer.
   *
   * **The listener is on `res`, not on `req`.** `express.json()` has already
   * drained the request body by the time this runs, so `req` has finished and
   * emitted its own `close` — attaching there registers a handler for an event
   * that has already fired, and the disconnect is never observed. `res` emits
   * `close` when the response finishes *or* when the connection is terminated
   * early, which is exactly the pair of cases that need telling apart.
   *
   * `writableEnded` is what tells them apart: a completed turn has already
   * called `res.end()`, so a successful stream is never recorded as an
   * abandonment.
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
   * **`Connection` is deliberately not set here**, and Slice 0 did set it.
   *
   * It is a hop-by-hop header: the HTTP layer owns it, and an application that
   * writes it by hand is describing a connection it does not manage. Slice 0's
   * `Connection: keep-alive` was harmless only because nothing ever sent a
   * *second* request over that connection. It is not harmless now — with it set,
   * the first generation of a session succeeds and the **next `POST /generate`
   * on the reused socket comes back as an empty 400**, which in the running app
   * means the second prompt of every conversation fails. Left to Node, the
   * streamed response closes its socket and each generation gets a clean one.
   */
  res.flushHeaders()

  // One comment straight away, so the client sees bytes — and therefore knows
  // the request was accepted — before the model has thought of anything.
  res.write(encodeSseComment())

  /*
   * D28. Adaptive thinking (D14) means the first token can be seconds away, and
   * an intermediary that closes an idle connection would kill the request during
   * the model's most productive moment. `wroteSinceTick` is what keeps the
   * comment out of a stream that is already flowing: a keep-alive between every
   * token would double the frame count for nothing.
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

  try {
    for await (const event of mapStream(stream)) {
      if (event.kind === 'token') {
        /*
         * `res.destroyed` is the socket's own state, so there is no flag to keep
         * in sync — Slice 0's check. It guards the *write* rather than breaking
         * the loop, because the terminal event still has to be handled: a client
         * that left mid-stream is exactly the case whose partial must be
         * persisted (D21).
         */
        if (!res.destroyed) {
          wroteSinceTick = true
          res.write(encodeSse('token', { text: event.text }))
        }
        continue
      }

      await finishTurn(res, uid, projectId, event, clientGone, Date.now() - startedAt)
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
 * The one terminal, and the one place both kinds of them are handled.
 *
 * | Mapper event | Persisted | Frame |
 * |---|---|---|
 * | `end`, text non-empty | `truncated` from the event | `done` with the message |
 * | `end`, text empty | nothing | `error` `upstream`, `message: null` |
 * | `error` `refused` | nothing — content is empty by construction | `error` `refused`, `null` |
 * | `error` `upstream`, text non-empty | `truncated: true` | `error` `upstream`, the partial |
 * | `error` `upstream`, text empty | nothing | `error` `upstream`, `null` |
 * | any of the above with `clientGone` | as above, `truncated: true` | **nothing** |
 *
 * **Success and interruption are one code path** because the client renders them
 * the same way (D9): whatever frame arrives, the placeholder bubble is replaced
 * by what the server actually stored. An `error` carrying only a string would
 * leave the client holding its own accumulated text as an id-less bubble that
 * then disagrees with the server's copy on the next load.
 *
 * **An `end` with no text cannot really happen** — a model that said nothing with
 * `end_turn` — but it is not persisted as an empty message either, because
 * `storedMessageSchema` requires non-empty content and the document would be
 * unreadable the moment it was written. It is reported as an interruption, which
 * is what it looks like from the user's side.
 *
 * **`clientGone` forces `truncated`** rather than trusting the mapper's flag. The
 * real SDK's `abort()` makes the in-flight iterator throw, which the mapper turns
 * into an `upstream` error; a stream that stops cleanly instead would otherwise
 * be persisted as complete. The client left mid-stream, so the reply is
 * incomplete whichever way the upstream chose to say so — and the `writableEnded`
 * guard above is what guarantees `clientGone` means exactly that.
 */
async function finishTurn(
  res: Response,
  uid: string,
  projectId: string,
  event: Extract<LlmEvent, { kind: 'end' | 'error' }>,
  clientGone: boolean,
  durationMs: number,
): Promise<void> {
  /*
   * `clientGone` forces the flag; otherwise an `end` carries the mapper's own
   * verdict — `false` on `end_turn`, `true` on `max_tokens` (D23) and on the
   * byte cap (D22) — and every `error` is by definition incomplete.
   */
  const truncated = clientGone || (event.kind === 'end' ? event.truncated : true)

  // Once per turn, on every path, and before the frame — so a turn is accounted
  // for even if the socket dies while it is being told about.
  logGeneration({
    model: event.model,
    stopReason: event.stopReason,
    truncated,
    durationMs,
    ...event.usage,
  })

  const message =
    event.text === '' ? null : await appendAssistantMessage(uid, projectId, event.text, truncated)

  // Nobody is listening. The partial is already stored, which is the whole of
  // what a returning user needs (F8.2).
  if (clientGone) return

  if (event.kind === 'end' && message !== null) {
    writeTerminalFrame(res, encodeSse('done', { message }))
    return
  }

  const code: GenerateErrorCode = event.kind === 'end' ? 'upstream' : event.code
  writeTerminalFrame(res, encodeSse('error', { error: ERROR_COPY[code], code, message }))
}
