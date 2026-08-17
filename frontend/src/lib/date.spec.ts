import { describe, expect, it } from 'vitest'

import { formatDay } from './date'

/**
 * One day formatter, shared by the account card and the projects card.
 *
 * The pinning is the point: left to the environment, a rendered date depends on
 * whichever machine the page — or the test — happens to run on, which turns a
 * stable assertion into a machine-dependent one and shows two users different
 * text for the same day.
 */

describe('formatDay', () => {
  it('formats an ISO-8601 timestamp as a day, pinned to en-GB and UTC', () => {
    expect(formatDay('2026-08-17T09:00:00.000Z')).toBe('17 Aug 2026')
  })

  /* The pin, asserted: 23:30 UTC is already the next day in some zones. */
  it('does not shift the day into the local time zone', () => {
    expect(formatDay('2026-08-17T23:30:00.000Z')).toBe('17 Aug 2026')
  })

  /*
   * A stored timestamp that does not parse is not worth a broken screen. The
   * caller renders nothing where the date would be, and the rest of the card
   * still says what it is about.
   */
  it.each(['', 'not a date', 'undefined'])('returns null for %s', (value) => {
    expect(formatDay(value)).toBeNull()
  })
})
