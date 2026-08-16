import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.spec.ts'],
    environment: 'node',
    // The emulators are shared state; parallel files race on the user list
    // and on the throttle counters.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
