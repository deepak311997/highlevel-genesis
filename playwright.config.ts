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
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm --prefix frontend run dev:emulator',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
