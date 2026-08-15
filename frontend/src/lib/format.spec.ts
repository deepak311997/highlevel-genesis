import { describe, expect, it } from 'vitest'

import { formatDuration } from './format'

describe('formatDuration', () => {
  it('renders sub-millisecond timings as "<1 ms" rather than "0 ms"', () => {
    expect(formatDuration(0)).toBe('<1 ms')
    expect(formatDuration(0.4)).toBe('<1 ms')
  })

  it('rounds millisecond timings', () => {
    expect(formatDuration(1)).toBe('1 ms')
    expect(formatDuration(42.6)).toBe('43 ms')
    expect(formatDuration(999)).toBe('999 ms')
  })

  it('switches to seconds at one thousand milliseconds', () => {
    expect(formatDuration(1000)).toBe('1.00 s')
    expect(formatDuration(1500)).toBe('1.50 s')
  })

  it('returns an em dash for values that are not real durations', () => {
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
  })
})
