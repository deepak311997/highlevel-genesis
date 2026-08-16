import { expect, test } from '@playwright/test'

import { latestCodeFor, resetEmulators } from '../integration/helpers'

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

const PASSWORD = 'Correct-Horse-9'

function freshEmail(): string {
  return `hl-${String(Date.now())}-${String(Math.floor(Math.random() * 10_000))}@example.test`
}

async function activationLinkFor(email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = await latestCodeFor(email, 'VERIFY_EMAIL')
    if (code !== undefined) {
      return `/auth/action?mode=verifyEmail&oobCode=${encodeURIComponent(code.oobCode)}`
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no verification code was issued for ${email}`)
}

/** Sign up, verify, and land on the dashboard — Slice 1's path, reused. */
async function signUpAndVerify(page: import('@playwright/test').Page): Promise<string> {
  const email = freshEmail()

  await page.goto('/signup')
  await page.fill('#signup-email', email)
  await page.fill('#signup-password', PASSWORD)
  await page.click('button[type="submit"]')
  await expect(page.getByTestId('signup-sent')).toBeVisible()

  await page.goto('/signin')
  await page.fill('#signin-password', PASSWORD)
  await page.click('button[type="submit"]')
  await expect(page).toHaveURL(/\/verify-email/)
  await expect(page.getByTestId('verify-headline')).toContainText("We've sent a link", {
    timeout: 15_000,
  })

  await page.goto(await activationLinkFor(email))
  await expect(page.getByTestId('action-verified')).toBeVisible({ timeout: 15_000 })
  await page.click('button:has-text("Continue")')
  await expect(page).toHaveURL(/\/dashboard/)

  return email
}

test.describe('Slice 02 — HighLevel connection', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()

    // The same guard Slice 1 uses. A development-mode server on this port talks
    // to real Firebase, and a suite that silently tested production while
    // reporting an emulator pass is worse than one that refuses to start.
    await page.goto('/signin')
    expect(
      await page.locator('html').getAttribute('data-genesis-emulator'),
      'the app under test is not an emulator build — start it with `vite --mode emulator`',
    ).toBe('true')
  })

  test('connect the sandbox location, see its name, disconnect', async ({ page }) => {
    await signUpAndVerify(page)

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
    await signUpAndVerify(page)

    await page.getByTestId('connection-connect').click()
    await expect(page.locator('#deny')).toBeVisible({ timeout: 15_000 })
    await page.click('#deny')

    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
    await expect(page.getByTestId('connection-callback-error')).toContainText('cancelled')
    // The way back is still there, which is the whole point of not dead-ending.
    await expect(page.getByTestId('connection-connect')).toBeEnabled()
  })
})
