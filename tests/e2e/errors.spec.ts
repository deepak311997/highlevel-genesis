import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import { assertEmulatorBuild, openNewProject, PASSWORD, signUpAndVerify } from './helpers'

/**
 * AC-20 — **an expired session explains itself and gives the user back their
 * workspace.**
 *
 * Before this slice every panel answered a dead session with the server's own
 * *"Sign in and try again."* beside a **Try again** button that would fail
 * identically, forever, on a screen with no way to sign in. The user's only way
 * out was knowing to reload. This walk is the claim that the way out is now on
 * screen and leads back to where they were.
 *
 * It is the only test that runs the real router, the real auth store and the
 * real API client together, which is why it is the one L5 walk this slice
 * spends: `main.ts`'s wiring has no unit test by design — it is four statements
 * of application assembly with no exports and no branches, and a unit test of it
 * would assert that the file calls the functions the file calls. This is the
 * level at which "they are actually connected" is a claim at all.
 *
 * **Why the 401 is forced with `page.route` rather than by a real revocation.**
 * The Auth emulator will not invalidate an unexpired ID token, and
 * `verifyIdToken` does not check revocation — so there is no way from a browser
 * to make the server genuinely reject a token that has not aged out. The server
 * half of this is already covered: `requireUser`'s L1 tests and its L4
 * integration tests prove that a bad credential produces exactly the envelope
 * fulfilled below. This walk's subject is the **client's reaction** to that
 * envelope, and that is what it fakes the fewest things to observe.
 *
 * The envelope is `auth/requireUser.ts`'s own, verbatim, so the client sees what
 * it would see from a genuinely dead session.
 *
 * The other two failures the slice's demo breaks are deliberately not here:
 * `workspace.spec.ts`'s `__fail_midstream` walk already covers the interrupted
 * reply and `preview.spec.ts` the HighLevel failure banner, and neither is
 * changed by this slice. One walk per slice is the rule; this is the new
 * behaviour, so this is where it is spent.
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
     * The concrete path, read off the browser rather than constructed: the id is
     * the server's, and the whole point of AC-12 is that a *parameterised* route
     * survives the round trip. A hardcoded path would pass even if `safeRedirect`
     * still refused everything but the static routes.
     *
     * `openNewProject` ends on `chat-empty` being visible, so the workspace's
     * own opening calls have settled before the route below is armed — otherwise
     * one of them could trip it and sign the user out before the click that is
     * meant to.
     */
    const workspacePath = new URL(page.url()).pathname
    expect(workspacePath).toMatch(/^\/projects\/.+/)

    await page.route('**/api/**', (route) => route.fulfill(DEAD_SESSION))

    // Exactly one authenticated call: History issues `GET /api/projects/:id/snapshots`
    // and nothing else, so what follows cannot be another request's doing.
    await page.getByTestId('snapshot-trigger').click()

    /*
     * Asserted as *parsed parameters* rather than as a URL literal.
     *
     * `expiredSignInPath` percent-encodes the path — `sessionExpiry.spec.ts`
     * pins that, and AC-10 states it — but `router.replace()` re-serialises the
     * query on the way into the address bar, and `/` is legal unescaped there,
     * so what the browser shows is `?redirect=/projects/…`. The two are the same
     * URL and both parse to the same `redirect` value. Reading the parameters
     * asserts the thing AC-10 is actually about, and does not pin a
     * serialisation choice vue-router owns.
     */
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
