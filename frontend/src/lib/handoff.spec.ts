import { afterEach, describe, expect, it } from 'vitest'

import { recallEmail, rememberEmail } from './handoff'

afterEach(() => {
  sessionStorage.clear()
})

describe('signup-to-signin handoff', () => {
  it('carries the address across the step', () => {
    rememberEmail('alice@example.test')

    expect(recallEmail()).toBe('alice@example.test')
  })

  // Read once: a later visit to sign-in should not resurrect a stale address.
  it('clears the address once read', () => {
    rememberEmail('alice@example.test')
    recallEmail()

    expect(recallEmail()).toBe('')
  })

  it('returns empty when nothing was stored', () => {
    expect(recallEmail()).toBe('')
  })
})
