import { readFileSync } from 'node:fs'

import { defineConfig } from 'vitest/config'

/**
 * The emulator's HighLevel token key, read from the file the emulator resolves it from.
 *
 * This suite opens tokens the functions sealed, so it needs the same key. Copying
 * the literal here would be a second source of truth, and it would drift silently
 * the first time the emulator's value changed — the suite would then fail with a
 * decryption error that says nothing about why.
 */
function emulatorTokenSecret(): string {
  const text = readFileSync(new URL('../../functions/.secret.local', import.meta.url), 'utf8')
  const value = /^HL_TOKEN_SECRET=(.*)$/m.exec(text)?.[1]?.trim()

  if (value === undefined || value === '') {
    throw new Error('functions/.secret.local declares no HL_TOKEN_SECRET — run scripts/ensure-secret-local.mjs')
  }
  return value
}

export default defineConfig({
  test: {
    env: { HL_TOKEN_SECRET: emulatorTokenSecret() },
    include: ['tests/integration/**/*.spec.ts'],
    environment: 'node',
    // The emulators are shared state; parallel files race on the user list
    // and on the throttle counters.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
