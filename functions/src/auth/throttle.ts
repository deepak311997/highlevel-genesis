import { createHash } from 'node:crypto'

/**
 * Fixed-window rate limiting for the auth endpoints.
 *
 * `/api/auth/register` is public, unauthenticated, and sends email. Unthrottled
 * it is both an email-bomb aimed at third parties and a bill aimed at us, which
 * is why this is a precondition of shipping the endpoint rather than a later
 * hardening pass.
 *
 * The arithmetic is pure and lives here; the Firestore counter it operates on
 * lives in the middleware. Splitting them means the boundary conditions — the
 * millisecond either side of a window, a clock that went backwards — are unit
 * tested without an emulator.
 *
 * **The counter must advance identically for an address that exists and one
 * that does not.** Counting only real accounts would make the 429 boundary an
 * account-existence oracle, reintroducing exactly what the uniform registration
 * response was built to close.
 */

export const THROTTLE_LIMIT = 5
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000

export interface ThrottleCounter {
  count: number
  /** Epoch milliseconds. */
  windowStart: number
}

export interface ThrottleDecision {
  allowed: boolean
  /** The counter to persist. Equal to the input when refusing, so the caller can skip the write. */
  next: ThrottleCounter
  retryAfterMs: number
}

function freshWindow(now: number): ThrottleDecision {
  return { allowed: true, next: { count: 1, windowStart: now }, retryAfterMs: 0 }
}

/**
 * Decide whether an attempt may proceed, and what the counter becomes.
 *
 * A counter whose window starts in the future is treated as a fresh window
 * rather than honoured: it can only arise from clock skew or a tampered write,
 * and honouring it would lock an address out for as long as the skew lasts.
 */
export function evaluate(current: ThrottleCounter | null, now: number): ThrottleDecision {
  if (current === null) return freshWindow(now)

  const elapsed = now - current.windowStart
  if (elapsed >= THROTTLE_WINDOW_MS || elapsed < 0) return freshWindow(now)

  if (current.count >= THROTTLE_LIMIT) {
    return {
      allowed: false,
      // Unchanged: a refused attempt must not extend its own lockout, or an
      // attacker could hold a victim's address shut indefinitely.
      next: current,
      retryAfterMs: THROTTLE_WINDOW_MS - elapsed,
    }
  }

  return {
    allowed: true,
    next: { count: current.count + 1, windowStart: current.windowStart },
    retryAfterMs: 0,
  }
}

/**
 * SHA-256 of a normalised value.
 *
 * The counter documents are keyed by hash so the collection never holds a list
 * of addresses that have tried to register — that list is exactly the thing an
 * enumeration attack is trying to build.
 */
export function hashKey(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

/** Namespaced so a value cannot consume the budget of the other dimension. */
export function emailKey(email: string): string {
  return `email:${hashKey(email)}`
}

export function ipKey(ip: string): string {
  return `ip:${hashKey(ip)}`
}
