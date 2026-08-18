import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Emulators are selected by **build mode**, not by a runtime flag, so that
 * `import.meta.env.MODE` is statically replaced at build time and the whole branch is eliminated
 * from any other bundle. A production build therefore cannot contain emulator wiring even if
 * something at runtime wanted it to.
 */

vi.mock('firebase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/auth')>()),
  connectAuthEmulator: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('firebase bootstrap', () => {
  /** The config carries what a loaded SDK reads, and nothing else. */
  it('carries no configuration the loaded SDKs do not read', async () => {
    // Stubbed *present*, which is the only way this test can fail: the default
    // test environment sets neither, so asserting their absence against it would
    // pass whether the code read them or not.
    vi.stubEnv('VITE_FIREBASE_STORAGE_BUCKET', 'genesis-test.appspot.com')
    vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', '000000000000')
    vi.resetModules()

    const { app } = await import('./firebase')
    const keys = Object.keys(app.options)

    expect(keys).not.toContain('storageBucket')
    expect(keys).not.toContain('messagingSenderId')

    // A subset rather than an exact list: `appId` is spread in only when it is
    // configured, and the test environment does not configure it. What this pins
    // is that nothing *outside* the set can appear.
    expect(keys.every((key) => ['apiKey', 'authDomain', 'projectId', 'appId'].includes(key))).toBe(
      true,
    )
    expect(keys).toEqual(expect.arrayContaining(['apiKey', 'authDomain', 'projectId']))
  })

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

  /* AC-27's first half. `db` is not merely unused — it is gone. */
  it('exports no Firestore handle', async () => {
    const mod = await import('./firebase')

    expect('db' in mod).toBe(false)
  })

  /*
   * AC-27's second half. Both variables were required at module load; a boot with neither set is
   * what proves they have stopped being configuration rather than merely stopped being read.
   */
  it('boots with neither VITE_FIREBASE_DATABASE_ID nor VITE_FIRESTORE_EMULATOR_PORT set', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_FIREBASE_DATABASE_ID', undefined)
    vi.stubEnv('VITE_FIRESTORE_EMULATOR_PORT', undefined)

    await expect(import('./firebase')).resolves.toHaveProperty('auth')
  })
})
