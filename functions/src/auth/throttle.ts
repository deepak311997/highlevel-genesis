import { createHash } from 'node:crypto'

/**
 * Fixed-window rate limiting for the auth endpoints.
 *
 * `/api/auth/register` is public, unauthenticated, and sends email — unthrottled
 * it is both an email-bomb aimed at third parties and a bill aimed at us.
 *
 * The arithmetic is pure and lives here; the Firestore counter it operates on
 * lives in the middleware, so the boundary conditions are unit tested without an
 * emulator.
 *
 * **The counter must advance identically for an address that exists and one that
 * does not**, or the 429 boundary becomes an account-existence oracle.
 */

export const THROTTLE_LIMIT = 5
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000

/**
 * The per-IP ceiling is deliberately looser: an IP is shared — an office, a
 * campus, a carrier's NAT — so a limit tight enough to matter against one attacker
 * would lock out everyone behind it. The email counter is the one that holds,
 * because it is the only key an attacker cannot rotate.
 */
export const THROTTLE_IP_LIMIT = 30

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
 * A window starting in the future is treated as fresh rather than honoured: it can
 * only come from clock skew or a tampered write, and honouring it would lock an
 * address out for as long as the skew lasts.
 */
export function evaluate(
  current: ThrottleCounter | null,
  now: number,
  limit: number = THROTTLE_LIMIT,
): ThrottleDecision {
  if (current === null) return freshWindow(now)

  const elapsed = now - current.windowStart
  if (elapsed >= THROTTLE_WINDOW_MS || elapsed < 0) return freshWindow(now)

  if (current.count >= limit) {
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
 * SHA-256 of a normalised value. The documents are keyed by hash so the collection
 * never holds a list of addresses that have tried to register — which is exactly
 * what an enumeration attack is trying to build.
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
