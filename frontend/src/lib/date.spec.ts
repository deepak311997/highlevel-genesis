import { describe, expect, it } from 'vitest'

import { formatDay, formatTime } from './date'

/**
 * Two formatters — a day for the cards, a time for chat bubbles.
 *
 * The pinning is the point: left to the environment, a rendered date depends on whichever
 * machine the page — or the test — happens to run on, which turns a stable assertion into a
 * machine-dependent one and shows two users different text for the same day. The zone is
 * IST, so the fixtures below are UTC instants read five and a half hours later.
 */

describe('formatDay', () => {
  it('formats an ISO-8601 timestamp as a day, pinned to en-GB and IST', () => {
    expect(formatDay('2026-08-17T09:00:00.000Z')).toBe('17 Aug 2026')
  })

  /* The pin, asserted: 23:30 UTC is already 05:00 the next day in IST. */
  it('reads the day in IST rather than the local time zone', () => {
    expect(formatDay('2026-08-17T23:30:00.000Z')).toBe('18 Aug 2026')
  })

  /*
   * A stored timestamp that does not parse is not worth a broken screen. The caller renders
   * nothing where the date would be, and the rest of the card still says what it is about.
   */
  it.each(['', 'not a date', 'undefined'])('returns null for %s', (value) => {
    expect(formatDay(value)).toBeNull()
  })
})

describe('formatTime', () => {
  /** AC-29. 24-hour, zero-padded, no seconds — a chat bubble's timestamp. */
  it('formats an ISO-8601 timestamp as HH:mm, pinned to en-GB and IST', () => {
    expect(formatTime('2026-08-17T09:05:00.000Z')).toBe('14:35')
  })

  /* The pin, asserted: the +05:30 offset is IST's alone, so neither UTC nor a
   * whole-hour machine zone can produce this. */
  it('reads the time in IST rather than the local time zone', () => {
    expect(formatTime('2026-08-17T23:30:00.000Z')).toBe('05:00')
  })

  it('renders midnight as 00:00 rather than 24:00', () => {
    expect(formatTime('2026-08-16T18:30:00.000Z')).toBe('00:00')
  })

  /*
   * D29. A message whose stored timestamp will not parse renders without a time
   * rather than with "Invalid Date" — its content is what matters.
   */
  it.each(['', 'not a date', 'undefined'])('returns null for %s', (value) => {
    expect(formatTime(value)).toBeNull()
  })
})
