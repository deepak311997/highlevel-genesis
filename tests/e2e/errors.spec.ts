import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import { assertEmulatorBuild, openNewProject, PASSWORD, signUpAndVerify } from './helpers'

/**
 * AC-20 — **an expired session explains itself and gives the user back their workspace.**
 *
 * Before this slice every panel answered a dead session with the server's own *"Sign in and try
 * again."* beside a **Try again** button that would fail identically, forever, on a screen with
 * no way to sign in. The user's only way out was knowing to reload. This walk is the claim that
 * the way out is now on screen and leads back to where they were.
 */

/** Exactly what `auth/requireUser.ts` emits when the credential is dead. */
const DEAD_SESSION = {
  status: 401,
  contentType: 'application/json',
  body: JSON.stringify({ error: 'Sign in and try again.', code: 'unauthenticated' }),
}

test.describe('Slice 12 — error handling', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  test('an expired session lands on sign-in and comes back to the workspace', async ({ page }) => {
    const email = await signUpAndVerify(page, 'errors')

    await page.goto('/dashboard')
    await openNewProject(page)

    /*
     * The concrete path, read off the browser rather than constructed: the id is the server's,
     * and the whole point of AC-12 is that a *parameterised* route survives the round trip.
     */
    const workspacePath = new URL(page.url()).pathname
    expect(workspacePath).toMatch(/^\/projects\/.+/)

    await page.route('**/api/**', (route) => route.fulfill(DEAD_SESSION))

    // Exactly one authenticated call: History issues `GET /api/projects/:id/snapshots`
    // and nothing else, so what follows cannot be another request's doing.
    await page.getByTestId('snapshot-trigger').click()

    /* Asserted as *parsed parameters* rather than as a URL literal. */
    await expect(page).toHaveURL(/\/signin\?/)

    const landed = new URL(page.url())
    expect(landed.pathname).toBe('/signin')
    expect(landed.searchParams.get('redirect')).toBe(workspacePath)
    expect(landed.searchParams.get('reason')).toBe('session_expired')

    await expect(page.getByTestId('signin-notice')).toContainText('Your session expired')

    /*
     * Firebase Auth talks to the emulator directly, so signing in would work
     * with the route still armed — but everything *after* sign-in goes through
     * `/api/**` and would 401 forever, signing the user straight back out.
     */
    await page.unroute('**/api/**')

    await page.fill('#signin-email', email)
    await page.fill('#signin-password', PASSWORD)
    await page.click('button[type="submit"]')

    // Back where they were, not on the dashboard — the whole point.
    await expect(page).toHaveURL(workspacePath, { timeout: 15_000 })
    await expect(page.getByTestId('chat-panel')).toBeVisible()
  })
})
