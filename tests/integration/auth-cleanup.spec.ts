import { beforeEach, describe, expect, it } from 'vitest'

import { adminAuth, applyVerification, latestCodeFor, postJson, resetEmulators } from './helpers'

/**
 * The cleanup runs inside the functions runtime, so the integration suite reaches it the same
 * way production's scheduler does — except the emulator has no scheduler, so it is invoked
 * directly through a test-only endpoint that only exists under FUNCTIONS_EMULATOR.
 */
const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(async () => {
  await resetEmulators()
})

async function sweep(now: number): Promise<number> {
  const res = await postJson('/auth/__test/cleanup', { now })
  const body = res.body as { deleted?: number }
  return body.deleted ?? -1
}

async function exists(email: string): Promise<boolean> {
  try {
    await adminAuth().getUserByEmail(email)
    return true
  } catch {
    return false
  }
}

describe('deleting accounts that were never verified', () => {
  it('removes an unverified account older than a day', async () => {
    await adminAuth().createUser({ email: 'stale@example.test', emailVerified: false })

    const deleted = await sweep(Date.now() + DAY_MS + 1_000)

    expect(deleted).toBe(1)
    expect(await exists('stale@example.test')).toBe(false)
  })

  it('leaves an unverified account that is still young', async () => {
    await adminAuth().createUser({ email: 'recent@example.test', emailVerified: false })

    const deleted = await sweep(Date.now())

    expect(deleted).toBe(0)
    expect(await exists('recent@example.test')).toBe(true)
  })

  /** However old it is, a verified account is somebody's. */
  it('never touches a verified account', async () => {
    await adminAuth().createUser({ email: 'verified@example.test', emailVerified: true })

    await sweep(Date.now() + 365 * DAY_MS)

    expect(await exists('verified@example.test')).toBe(true)
  })

  it('frees the address, so the real owner can register it', async () => {
    await postJson('/auth/register', { email: 'squatted@example.test', password: 'Attacker-Pw-1' })
    await sweep(Date.now() + DAY_MS + 1_000)

    const res = await postJson('/auth/register', {
      email: 'squatted@example.test',
      password: 'Owner-Pass-2',
    })

    expect(res.status).toBe(200)
    const user = await adminAuth().getUserByEmail('squatted@example.test')
    expect(user.emailVerified).toBe(false)
  })

  /** AC-19: a link issued to the deleted account must stop working. */
  it('retires a verification code the deleted account was issued', async () => {
    const uid = (await adminAuth().createUser({ email: 'gone@example.test', emailVerified: false }))
      .uid
    // Generating a link is what registers an oob code with the emulator.
    await adminAuth().generateEmailVerificationLink('gone@example.test')
    const issued = await latestCodeFor('gone@example.test', 'VERIFY_EMAIL')
    expect(issued).toBeDefined()
    expect(uid).toBeTruthy()

    await sweep(Date.now() + DAY_MS + 1_000)

    expect(await applyVerification(issued?.oobCode ?? '')).toBe(false)
  })
})
