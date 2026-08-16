import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests run against the Vite dev server in **emulator mode**, with
 * the Firebase emulators up around them — `npm run test:e2e` wraps the whole
 * run in `firebase emulators:exec`, so there is nothing to start by hand and no
 * real credentials involved.
 *
 * `--mode emulator` is what makes the app connect to the emulated Auth and
 * Firestore; any other mode targets real Firebase, and that selection happens
 * at build time rather than at runtime so it cannot be flipped by accident.
 */
/** Matches the port `npm run test:e2e` starts Vite on — see scripts/test-emulator-config.mjs. */
const PORT = process.env['E2E_PORT'] ?? '5173'

export default defineConfig({
  testDir: './tests/e2e',
  // One emulator, shared by every test, and each clears it before running —
  // so a parallel run has one test wiping another's account mid-flight. The
  // rules and integration suites set fileParallelism: false for the same
  // reason; this was the one place still running concurrently.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm --prefix frontend run dev:emulator',
    url: `http://localhost:${PORT}`,
    // Never reuse. A development-mode server on the same port talks to real
    // Firebase, and reusing it means the suite tests production while looking
    // like it tested the emulator. Failing to start is the better outcome.
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
