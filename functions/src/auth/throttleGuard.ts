import type { NextFunction, Request, Response } from 'express'

import { HttpError } from '../lib/errors'
import { getDb } from '../lib/firebase'
import { logAuthEvent } from '../lib/log'
import {
  emailKey,
  evaluate,
  hashKey,
  ipKey,
  THROTTLE_IP_LIMIT,
  THROTTLE_LIMIT,
  type ThrottleCounter,
} from './throttle'

/**
 * Rate limiting for the auth endpoints, over the arithmetic in `./throttle`.
 *
 * Two keys, both counted, either can refuse. **Email** is authoritative — the only
 * key an attacker cannot rotate, and what bounds mail sent to any one victim.
 * **IP** is best-effort: read from `X-Forwarded-For`, which the client controls, so
 * it slows a naive flood rather than stopping a deliberate one.
 *
 * The counter advances for addresses that do not exist exactly as for ones that
 * do, or the 429 boundary would answer the question the endpoint refuses to.
 */

export const THROTTLE_COLLECTION = 'authThrottle'

/** Best-effort client address. Spoofable by design of the header. */
function clientIp(req: Request): string {
  const forwarded = req.header('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (first !== undefined && first !== '') return first
  return req.ip ?? 'unknown'
}

/**
 * The address this request is about, for counting only — not validated here, since
 * an unparseable body still deserves to be counted. Normalised as the schema
 * normalises, so one address cannot hold two budgets by changing case.
 */
function subjectEmail(req: Request): string | null {
  const body: unknown = req.body
  if (typeof body !== 'object' || body === null) return null
  const { email } = body as { email?: unknown }
  return typeof email === 'string' && email.trim() !== '' ? email : null
}

function toCounter(data: unknown): ThrottleCounter | null {
  if (typeof data !== 'object' || data === null) return null
  const { count, windowStart } = data as { count?: unknown; windowStart?: unknown }
  if (typeof count !== 'number' || typeof windowStart !== 'number') return null
  return { count, windowStart }
}

/**
 * Express middleware. Attach per route, never with `router.use`: this router is
 * mounted at both `/` and `/api`, so it would run twice and double-count.
 */
export async function throttleAuthRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const email = subjectEmail(req)
  const now = Date.now()

  const targets = [
    ...(email === null ? [] : [{ key: emailKey(email), limit: THROTTLE_LIMIT }]),
    { key: ipKey(clientIp(req)), limit: THROTTLE_IP_LIMIT },
  ]

  const db = getDb()
  const refs = targets.map((t) => db.collection(THROTTLE_COLLECTION).doc(t.key))

  let retryAfterMs = 0
  await db.runTransaction(async (tx) => {
    const snapshots = await tx.getAll(...refs)
    const decisions = snapshots.map((snapshot, index) =>
      evaluate(toCounter(snapshot.data()), now, targets[index]?.limit ?? THROTTLE_LIMIT),
    )

    const refused = decisions.filter((d) => !d.allowed)
    if (refused.length > 0) {
      retryAfterMs = Math.max(...refused.map((d) => d.retryAfterMs))
      // Nothing written. A refused attempt must not extend its own lockout.
      return
    }

    decisions.forEach((decision, index) => {
      const ref = refs[index]
      if (ref !== undefined) tx.set(ref, decision.next)
    })
  })

  if (retryAfterMs > 0) {
    logAuthEvent('throttle.refused', {
      outcome: 'throttled',
      ...(email === null ? {} : { emailHash: hashKey(email) }),
    })
    res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
    throw new HttpError(429, 'Too many attempts. Try again in a few minutes.', 'throttled')
  }

  next()
}
