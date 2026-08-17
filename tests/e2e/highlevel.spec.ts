import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import { assertEmulatorBuild, signUpAndVerify } from './helpers'

/**
 * Slice 2's one end-to-end test: the demo line, walked in a browser.
 *
 * Everything here is the real thing except the far side of the OAuth handshake.
 * The Connect button, the redirect out, the callback, the code exchange, the
 * Firestore write and the redirect back are all production code paths; only
 * HighLevel itself is substituted, by a fake mounted inside the `api` function
 * and reachable only under the emulator.
 *
 * That substitution is what makes this worth having. Hitting the callback
 * directly with a pre-sealed state would test the handler and skip the two
 * things most likely to be misconfigured — that the Connect button sends the
 * browser somewhere real, and that whatever comes back lands on a route the
 * router will actually render.
 */

test.describe('Slice 02 — HighLevel connection', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  test('connect the sandbox location, see its name, disconnect', async ({ page }) => {
    await signUpAndVerify(page, 'hl')

    // Empty state: the panel has asked the endpoint and been told nothing is
    // connected. Reaching this at all proves the authenticated GET works with a
    // real ID token.
    await expect(page.getByTestId('connection-empty')).toBeVisible()

    await page.getByTestId('connection-connect').click()

    // Off to "HighLevel". The server built this URL, so arriving here means the
    // state was sealed, the scopes were composed and the redirect_uri survived.
    await expect(page.locator('#approve')).toBeVisible({ timeout: 15_000 })

    await page.click('#approve')

    // Back through the callback, which exchanged the code, stored the
    // connection, and redirected into the SPA — which then replaced the URL.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
    await expect(page.getByTestId('connection-location')).toHaveText('India Square')

    // Back must not return to the spent callback URL.
    await page.goBack()
    await expect(page).not.toHaveURL(/\/hl\/callback/)

    // The connection came from Firestore, not component state, so it survives a
    // full reload — which is the difference between a connection and a message.
    await page.goto('/dashboard')
    await expect(page.getByTestId('connection-location')).toHaveText('India Square')

    await page.getByTestId('connection-disconnect').click()
    await expect(page.getByTestId('connection-empty')).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('connection-empty')).toBeVisible()
  })

  test('declining at HighLevel says so, and leaves the user able to retry', async ({ page }) => {
    await signUpAndVerify(page, 'hl')

    await page.getByTestId('connection-connect').click()
    await expect(page.locator('#deny')).toBeVisible({ timeout: 15_000 })
    await page.click('#deny')

    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
    await expect(page.getByTestId('connection-callback-error')).toContainText('cancelled')
    // The way back is still there, which is the whole point of not dead-ending.
    await expect(page.getByTestId('connection-connect')).toBeEnabled()
  })
})
