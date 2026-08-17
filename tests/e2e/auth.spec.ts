import { expect, test } from '@playwright/test'

import { latestCodeFor, resetEmulators } from '../integration/helpers'

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

const PASSWORD = 'Correct-Horse-9'

/** Unique per run, so a re-run does not collide with a previous account. */
function freshEmail(): string {
  return `e2e-${String(Date.now())}-${String(Math.floor(Math.random() * 10_000))}@example.test`
}

/**
 * The verification link, pointed at *our* action route.
 *
 * The emulator's own link targets its built-in handler; in production the
 * equivalent is the custom action URL configured on the email template. Either
 * way the oobCode is the payload, so the test rebuilds the URL the deployed app
 * would receive.
 */
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

test.describe('Slice 01 — account and session', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()

    // Refuse to run against anything but an emulator build. Playwright will
    // reuse a dev server on the same port, and a development-mode server talks
    // to *real* Firebase — which once meant this suite created accounts on the
    // live project and failed with a confusing message about missing codes.
    await page.goto('/signin')
    const marker = await page.locator('html').getAttribute('data-genesis-emulator')
    expect(
      marker,
      'the app under test is not an emulator build — start it with `vite --mode emulator`',
    ).toBe('true')
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
     * AC-28. The address on this card came from `PUT /api/users/me` — there is
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
