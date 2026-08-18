import { describe, expect, it } from 'vitest'

import { buildFakeHlRouter } from './fake'

/**
 * The fake HighLevel, and the one thing about it that must never regress.
 *
 * It mints access tokens on demand and answers `/oauth/token` without a client secret. In a
 * deployed build that is not a test double, it is an open door — so the gate is not a config
 * flag or an env var of our own but `FUNCTIONS_EMULATOR`, the one signal an operator cannot set
 * by mistake and a deploy cannot carry. Same reasoning as the fake mail transport in Slice 1 and
 * the test-only cleanup route.
 */
describe('the fake HighLevel router', () => {
  it('has no routes at all outside the emulator', () => {
    const router = buildFakeHlRouter(false)

    expect(router.stack).toHaveLength(0)
  })

  it('serves its routes under the emulator', () => {
    const router = buildFakeHlRouter(true)

    expect(router.stack.length).toBeGreaterThan(0)
  })
})
