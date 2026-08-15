import { describe, expect, it } from 'vitest'

import {
  emailKey,
  evaluate,
  hashKey,
  ipKey,
  THROTTLE_LIMIT,
  THROTTLE_WINDOW_MS,
  type ThrottleCounter,
} from './throttle'

const NOW = 1_700_000_000_000

describe('evaluate', () => {
  it('allows the first attempt and opens a window', () => {
    const decision = evaluate(null, NOW)

    expect(decision.allowed).toBe(true)
    expect(decision.next).toEqual({ count: 1, windowStart: NOW })
  })

  it('allows attempts below the limit and keeps the window open', () => {
    const current: ThrottleCounter = { count: THROTTLE_LIMIT - 1, windowStart: NOW }

    const decision = evaluate(current, NOW + 1_000)

    expect(decision.allowed).toBe(true)
    expect(decision.next).toEqual({ count: THROTTLE_LIMIT, windowStart: NOW })
  })

  it('refuses the attempt that would exceed the limit', () => {
    const current: ThrottleCounter = { count: THROTTLE_LIMIT, windowStart: NOW }

    expect(evaluate(current, NOW + 1_000).allowed).toBe(false)
  })

  /**
   * A refused attempt leaves the counter alone. Incrementing it would let an
   * attacker hold a victim's address locked out indefinitely by hammering it,
   * and it would spend a Firestore write per refused request.
   */
  it('does not advance the counter or the window when refusing', () => {
    const current: ThrottleCounter = { count: THROTTLE_LIMIT, windowStart: NOW }

    const decision = evaluate(current, NOW + 1_000)

    expect(decision.next).toEqual(current)
  })

  it('reports how long the caller must wait', () => {
    const current: ThrottleCounter = { count: THROTTLE_LIMIT, windowStart: NOW }

    const decision = evaluate(current, NOW + 60_000)

    expect(decision.retryAfterMs).toBe(THROTTLE_WINDOW_MS - 60_000)
  })

  it('opens a fresh window once the old one has elapsed', () => {
    const current: ThrottleCounter = { count: THROTTLE_LIMIT, windowStart: NOW }
    const later = NOW + THROTTLE_WINDOW_MS

    const decision = evaluate(current, later)

    expect(decision.allowed).toBe(true)
    expect(decision.next).toEqual({ count: 1, windowStart: later })
  })

  it('still refuses one millisecond before the window elapses', () => {
    const current: ThrottleCounter = { count: THROTTLE_LIMIT, windowStart: NOW }

    expect(evaluate(current, NOW + THROTTLE_WINDOW_MS - 1).allowed).toBe(false)
  })

  it('treats a counter from the future as a fresh window rather than trusting it', () => {
    const current: ThrottleCounter = { count: THROTTLE_LIMIT, windowStart: NOW + 60_000 }

    const decision = evaluate(current, NOW)

    expect(decision.allowed).toBe(true)
    expect(decision.next).toEqual({ count: 1, windowStart: NOW })
  })
})

describe('hashKey', () => {
  it('is stable for the same input', () => {
    expect(hashKey('alice@example.test')).toBe(hashKey('alice@example.test'))
  })

  it('produces a hex digest that does not contain the input', () => {
    const hashed = hashKey('alice@example.test')

    expect(hashed).toMatch(/^[0-9a-f]{64}$/)
    expect(hashed).not.toContain('alice')
  })

  it('ignores casing and surrounding space, so one address cannot hold two budgets', () => {
    expect(hashKey('  Alice@Example.TEST ')).toBe(hashKey('alice@example.test'))
  })

  it('separates different inputs', () => {
    expect(hashKey('alice@example.test')).not.toBe(hashKey('bob@example.test'))
  })
})

describe('key namespacing', () => {
  it('prefixes so an address and an address-shaped IP cannot share a budget', () => {
    expect(emailKey('alice@example.test')).toMatch(/^email:[0-9a-f]{64}$/)
    expect(ipKey('203.0.113.7')).toMatch(/^ip:[0-9a-f]{64}$/)
    expect(emailKey('x')).not.toBe(ipKey('x'))
  })
})
