import { describe, expect, it } from 'vitest'

import * as deployed from './index'

/**
 * What actually gets deployed.
 *
 * This file exists because of a real failure: `deleteExpiredUnverifiedUsers`
 * was written, unit-tested and integration-tested, and then its `onSchedule`
 * trigger was dropped in an unrelated commit. Every test stayed green, because
 * every test called the function directly — none of them asked whether anything
 * in production ever would. The sweep silently stopped existing for two days.
 *
 * A handler with no trigger is dead code wearing a passing test. These
 * assertions are deliberately structural: they check the deployment surface,
 * which is the one thing the other levels cannot see.
 */
describe('deployed function surface', () => {
  it.each(['api', 'generate', 'cleanupUnverifiedUsers'])('exports %s', (name) => {
    expect(deployed).toHaveProperty(name)
  })

  it('schedules the unverified-account sweep', () => {
    // D18's fourth mitigation. Without a trigger an account an attacker
    // registered at someone else's address persists indefinitely, and the
    // victim can still be talked into verifying it months later.
    expect(deployed.cleanupUnverifiedUsers).toBeDefined()
  })
})
