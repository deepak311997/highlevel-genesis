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
} from './llm'
import { appendAssistantMessage, readTranscript } from './messages/handlers'
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
 * 3. the context, with trailing assistant turns dropped (D6);
 * 4. an empty context, which is a 400 before any LLM call (D7);
 * 5. the upstream stream — a missing API key throws here, and it is still an
 *    ordinary 500 with the reason logged rather than surfaced.
 *
 * Only then do headers go out.
 */
export async function handleGenerate(req: Request, res: Response, uid: string): Promise<void> {
  const { projectId } = parseBody(generateBodySchema, req)

  if ((await readProject(uid, projectId)) === null) throw notFound()

  const context = buildContext(await readTranscript(uid, projectId))
  if (context.length === 0) {
    throw new HttpError(
      400,
      'There is nothing to generate from yet. Send a message first.',
      'empty_context',
    )
  }

  const startedAt = Date.now()
  const stream = await openStream(buildParams(context))

  res.status(200)
  res.set('Content-Type', 'text/event-stream; charset=utf-8')
  res.set('Cache-Control', 'no-cache, no-transform')
  res.set('Connection', 'keep-alive')
  // Belt and braces against an intermediary that buffers on its own.
  res.set('X-Accel-Buffering', 'no')
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
      // `res.destroyed` is the socket's own state, so there is no flag to keep in
      // sync — Slice 0's check, unchanged.
      if (res.destroyed) break

      if (event.kind === 'token') {
        wroteSinceTick = true
        res.write(encodeSse('token', { text: event.text }))
        continue
      }

      logGeneration({
        model: event.model,
        stopReason: event.stopReason,
        truncated: event.kind === 'end' && event.truncated,
        durationMs: Date.now() - startedAt,
        ...event.usage,
      })

      if (event.kind === 'end') {
        const message = await appendAssistantMessage(uid, projectId, event.text, event.truncated)
        writeTerminalFrame(res, encodeSse('done', { message }))
        return
      }
    }
  } finally {
    clearInterval(keepAlive)
  }

  if (!res.writableEnded) res.end()
}
