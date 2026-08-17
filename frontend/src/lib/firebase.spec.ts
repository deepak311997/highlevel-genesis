import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * AC-54. Emulators are selected by **build mode**, not by a runtime flag, so
 * that `import.meta.env.MODE` is statically replaced at build time and the
 * whole branch is eliminated from any other bundle. A production build
 * therefore cannot contain emulator wiring even if something at runtime wanted
 * it to.
 *
 * These tests run under Vitest, whose mode is `test` — not `emulator` — so they
 * assert the negative case. The positive case is exercised for real by the
 * Playwright suite, which builds with `--mode emulator`.
 *
 * There is no `firebase/firestore` mock here any more, and there is nothing to
 * mock: this module no longer imports it. That is AC-24's ground truth — the
 * frontend's every read and write goes through a Cloud Function route.
 */

vi.mock('firebase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/auth')>()),
  connectAuthEmulator: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('firebase bootstrap', () => {
  it('does not connect to an emulator outside emulator mode', async () => {
    const { connectAuthEmulator } = await import('firebase/auth')

    await import('./firebase')

    expect(import.meta.env.MODE).not.toBe('emulator')
    expect(connectAuthEmulator).not.toHaveBeenCalled()
  })

  it('exposes the app and auth handles', async () => {
    const mod = await import('./firebase')

    expect(mod.app).toBeDefined()
    expect(mod.auth).toBeDefined()
  })

  /*
   * AC-27's first half. `db` is not merely unused — it is gone. An exported
   * handle nobody reads is an invitation to read it, and the ban on
   * `firebase/firestore` needs no allowlist only because there is nothing left
   * that legitimately imports it.
   */
  it('exports no Firestore handle', async () => {
    const mod = await import('./firebase')

    expect('db' in mod).toBe(false)
  })

  /*
   * AC-27's second half. Both variables were required at module load; a boot
   * with neither set is what proves they have stopped being configuration
   * rather than merely stopped being read.
   */
  it('boots with neither VITE_FIREBASE_DATABASE_ID nor VITE_FIRESTORE_EMULATOR_PORT set', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_FIREBASE_DATABASE_ID', undefined)
    vi.stubEnv('VITE_FIRESTORE_EMULATOR_PORT', undefined)

    await expect(import('./firebase')).resolves.toHaveProperty('auth')
  })
})
