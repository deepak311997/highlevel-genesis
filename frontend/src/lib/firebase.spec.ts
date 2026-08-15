import { describe, expect, it, vi } from 'vitest'

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
 */

vi.mock('firebase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/auth')>()),
  connectAuthEmulator: vi.fn(),
}))

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  connectFirestoreEmulator: vi.fn(),
}))

describe('firebase bootstrap', () => {
  it('does not connect to an emulator outside emulator mode', async () => {
    const { connectAuthEmulator } = await import('firebase/auth')
    const { connectFirestoreEmulator } = await import('firebase/firestore')

    await import('./firebase')

    expect(import.meta.env.MODE).not.toBe('emulator')
    expect(connectAuthEmulator).not.toHaveBeenCalled()
    expect(connectFirestoreEmulator).not.toHaveBeenCalled()
  })

  it('exposes the app, auth and database handles', async () => {
    const mod = await import('./firebase')

    expect(mod.app).toBeDefined()
    expect(mod.auth).toBeDefined()
    expect(mod.db).toBeDefined()
  })
})
