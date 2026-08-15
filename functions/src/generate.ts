import { onRequest } from 'firebase-functions/v2/https'

import { encodeSse } from './lib/sse'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Slice 0 placeholder for the generation endpoint.
 *
 * It streams a fixed sentence rather than calling an LLM. The point is to prove
 * the transport before Slice 5 depends on it: that Cloud Functions v2 really
 * does stream in this region, that headers flush before the body, and that
 * nothing between here and the browser buffers the response.
 *
 * Auth and the real Claude call arrive in Slice 5.
 */
export const generate = onRequest(
  {
    // Deliberately short while this endpoint is unauthenticated. A public
    // function with a 60-minute timeout is a slow-loris target: a caller can
    // hold instances open for an hour at a time. The long timeout that real
    // generation needs arrives in Slice 5, together with the ID-token check
    // that makes it safe to grant.
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true,
  },
  async (_req, res) => {
    res.set('Content-Type', 'text/event-stream; charset=utf-8')
    res.set('Cache-Control', 'no-cache, no-transform')
    res.set('Connection', 'keep-alive')
    // Belt and braces against an intermediary that buffers on its own.
    res.set('X-Accel-Buffering', 'no')
    res.flushHeaders()

    // `res.destroyed` is the socket's own state, so there is no flag to keep in
    // sync — and unlike a closure variable, the compiler can see it change.
    for (const word of ['Streaming', 'works', 'end', 'to', 'end.']) {
      if (res.destroyed) return
      res.write(encodeSse('token', { text: `${word} ` }))
      await sleep(150)
    }

    if (res.destroyed) return
    res.write(encodeSse('done', { ok: true }))
    res.end()
  },
)
