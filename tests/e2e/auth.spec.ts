import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import { activationLinkFor, assertEmulatorBuild, freshEmail, PASSWORD } from './helpers'

/**
 * The slice's one end-to-end test, covering the demo path.
 *
 * No mail provider is involved. Firebase sends the verification email itself,
 * and the Auth emulator exposes the code it generated, so the test can follow
 * the link without a mailbox.
 *
 * Two things here are worth more than the rest, because they are the ones unit
 * tests cannot see:
 *
 *  - `/auth/action` renders while the session is signed-in-and-unverified. Every
 *    other route redirects in that state, and if this one did too, verification
 *    would be unreachable — a deadlock no amount of component testing catches.
 *  - The dashboard loads *and its profile request succeeds* after verifying,
 *    which is only true because the ID token was refreshed: `withVerifiedUser`
 *    reads `email_verified` off the token on every API route, so a stale claim
 *    turns the account card into an error state. Without the refresh the page
 *    renders and then fails, which looks like a working app until it isn't.
 */

test.describe('Slice 01 — account and session', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  test('sign up, get held at the gate, verify, and reach the dashboard', async ({ page }) => {
    const email = freshEmail()

    // A protected route while signed out remembers where you were going. The
    // guard percent-encodes the target; the browser displays it decoded, so the
    // assertion reads the parsed parameter rather than the raw string.
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/signin\?redirect=/)
    expect(new URL(page.url()).searchParams.get('redirect')).toBe('/dashboard')

    await page.goto('/signup')
    await page.fill('#signup-email', email)
    await page.fill('#signup-password', PASSWORD)
    await page.click('button[type="submit"]')

    // Non-committal by design — the same screen an already-registered address
    // would produce, and it promises no email, because registration sends none.
    await expect(page.getByTestId('signup-sent')).toContainText('You can sign in now')

    // Sign-in prefills the address from sign-up, so it should already be there.
    await page.goto('/signin')
    await expect(page.locator('#signin-email')).toHaveValue(email)
    await page.fill('#signin-password', PASSWORD)
    await page.click('button[type="submit"]')

    // Signed in, but held: the dashboard is not reachable yet. Reaching the gate
    // is also what sends the verification email — registration sent nothing.
    await expect(page).toHaveURL(/\/verify-email/)
    await expect(page.getByTestId('verify-address')).toHaveText(email)
    // The headline only claims a send once one has actually succeeded.
    await expect(page.getByTestId('verify-headline')).toContainText("We've sent a link", {
      timeout: 15_000,
    })

    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/verify-email/)

    // The deadlock check: this route must render in exactly this auth state.
    await page.goto(await activationLinkFor(email))
    await expect(page.getByTestId('action-verified')).toBeVisible({ timeout: 15_000 })

    await page.click('button:has-text("Continue")')
    await expect(page).toHaveURL(/\/dashboard/)

    /*
     * AC-28. The address on this card came from `PUT /api/profile` — there is
     * no Firestore client in the bundle at all — so reading it means the
     * refreshed ID token satisfied `withVerifiedUser`'s `email_verified` check
     * on the profile route. `account-member-since` is asserted alongside it
     * because it is derived from the stored `createdAt`, which only exists if
     * the server actually wrote the document.
     */
    await expect(page.getByTestId('account-card')).toBeVisible()
    await expect(page.getByTestId('dashboard-email')).toHaveText(email)
    await expect(page.getByTestId('account-member-since')).toContainText('Member since')

    // Session persists across a full reload — and so does the profile, which on
    // the second visit is a touch rather than a create.
    await page.reload()
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByTestId('account-card')).toBeVisible()
    await expect(page.getByTestId('dashboard-email')).toHaveText(email)
    await expect(page.getByTestId('account-member-since')).toContainText('Member since')

    await page.click('button:has-text("Sign out")')
    await expect(page).toHaveURL(/\/signin/)

    // And the protected route is closed again.
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/signin/)
  })

  test('a second sign-up for the same address is indistinguishable', async ({ page }) => {
    const email = freshEmail()

    await page.goto('/signup')
    await page.fill('#signup-email', email)
    await page.fill('#signup-password', PASSWORD)
    await page.click('button[type="submit"]')
    const first = await page.getByTestId('signup-sent').textContent()

    await page.goto('/signup')
    await page.fill('#signup-email', email)
    await page.fill('#signup-password', 'Different-Horse-7')
    await page.click('button[type="submit"]')
    const second = await page.getByTestId('signup-sent').textContent()

    expect(second).toBe(first)
  })
})
