import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import { assertEmulatorBuild, connectHighLevel, openNewProject, signUpAndVerify } from './helpers'

/**
 * AC-39 — the money shot, walked in a browser.
 *
 * Everything on this path is the real thing except the model and HighLevel itself: a real
 * account with a verified email, a real OAuth handshake against the emulator-only fake, real
 * Cloud Function routes, real Firestore documents, a real SSE stream, and a real sandboxed
 * iframe running code that was written seconds earlier and has never touched a token.
 */

/** Plain, not `__slow`: nothing here is asserted mid-stream. */
const PROMPT = 'build a contact dashboard'

/**
 * A name out of `tests/fixtures/highlevel/contacts-search.json`, which the
 * emulator-only fake replays for `POST /contacts/search`.
 *
 * The fixture is recorded data and every record in it is prefixed `(Example)`,
 * so the match is on the name alone and case-insensitive — this asserts that a
 * CRM record reached the page, not that a particular fixture never changes.
 */
const FIXTURE_CONTACT = /casey morgan/i

test.describe('Slice 10 — live preview', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  test('a generated app runs in the preview and reads the connected account', async ({ page }) => {
    await signUpAndVerify(page, 'preview')
    await connectHighLevel(page)

    await page.goto('/dashboard')
    await openNewProject(page)

    // Movement one: a project that has never generated. The panel says what to
    // do next and renders no frame — an empty `srcdoc` would run nothing, so
    // there must be nothing there rather than an empty something.
    await expect(page.getByTestId('preview-empty')).toBeVisible()
    await expect(page.getByTestId('preview-frame')).toHaveCount(0)

    /*
     * Armed *before* the prompt is sent, because the brokered call happens on its own schedule —
     * the generation finishes, the store bumps its counter, the panel rebuilds and the
     * document's own `load()` runs.
     */
    const proxied = page.waitForResponse(
      (response) =>
        response.url().includes('/api/hl/proxy/contacts/search') && response.status() === 200,
      { timeout: 30_000 },
    )

    // Movement two: the generation.
    await page.getByTestId('composer-input').fill(PROMPT)
    await page.getByTestId('composer-input').press('Enter')
    await expect(page.getByTestId('chat-generating')).toBeVisible()
    await expect(page.getByTestId('chat-generating')).toBeHidden({ timeout: 30_000 })

    /*
     * Movement three: **nobody presses anything.** F6.4's requirement and the
     * whole demo — the panel notices the generation applied and rebuilds itself.
     */
    await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: 20_000 })

    // The host-visible half: a call really went out, through the proxy, with
    // this user's credentials attached on this side of the boundary.
    await proxied

    // The user-visible half: a CRM record, rendered by generated code, inside a
    // frame that holds no credential and cannot reach the network itself.
    await expect(page.frameLocator('[data-testid="preview-frame"]').locator('#rows')).toContainText(
      FIXTURE_CONTACT,
      { timeout: 20_000 },
    )

    /*
     * And nothing went wrong on the way. The fixture app wraps both of its calls
     * in one `try`/`catch` that replaces the list with the error message, so a
     * visible contact name already implies both hops succeeded — but the host
     * raises its own banner for every brokered failure whether the app caught it
     * or not (D17), so these are the assertion that no failure happened at all.
     */
    await expect(page.getByTestId('preview-failure')).toHaveCount(0)
    await expect(page.getByTestId('preview-runtime-error')).toHaveCount(0)

    // A fresh generation is what rebuilds; a preview nobody has touched since is
    // not stale.
    await expect(page.getByTestId('preview-stale')).toHaveCount(0)
  })
})
