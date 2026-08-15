import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/rules/**/*.spec.ts'],
    environment: 'node',
    // The rules emulator is shared state; parallel files race on it.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
