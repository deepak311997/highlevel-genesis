import { expect, test } from '@playwright/test'

import { adminDb, linkFrom, resetEmulators, type RecordedMail } from '../integration/helpers'

/**
 * The slice's one end-to-end test, covering the demo path.
 *
 * SMTP2GO is never called: under the emulator the transport records mail into
 * Firestore, and this test reads the activation link straight out of it. That
 * seam is what makes an email-based flow testable without a mailbox.
 *
 * Two things here are worth more than the rest, because they are the ones unit
 * tests cannot see:
 *
 *  - `/auth/action` renders while the session is signed-in-and-unverified. Every
 *    other route redirects in that state, and if this one did too, verification
 *    would be unreachable — a deadlock no amount of component testing catches.
 *  - The dashboard loads *and its Firestore read succeeds* after verifying,
 *    which is only true because the ID token was refreshed. Without that the
 *    page renders and then fails, which looks like a working app until it isn't.
 */

const PASSWORD = 'correct-horse-battery'

/** Unique per run, so a re-run does not collide with a previous account. */
function freshEmail(): string {
  return `e2e-${String(Date.now())}-${String(Math.floor(Math.random() * 10_000))}@example.test`
}

async function activationLinkFor(email: string): Promise<string> {
  const snapshot = await adminDb().collection('_devMail').get()
  const mail = snapshot.docs
    .map((doc) => doc.data() as RecordedMail)
    .filter((m) => m.to === email && m.textBody.includes('mode=verifyEmail'))

  const latest = mail.at(-1)
  if (latest === undefined) throw new Error(`no activation email recorded for ${email}`)
  return linkFrom(latest)
}

test.describe('Slice 01 — account and session', () => {
  test.beforeEach(async () => {
    await resetEmulators()
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
    // would produce.
    await expect(page.getByTestId('signup-sent')).toContainText('If that address can be used')

    await page.goto('/signin')
    await page.fill('#signin-email', email)
    await page.fill('#signin-password', PASSWORD)
    await page.click('button[type="submit"]')

    // Signed in, but held: the dashboard is not reachable yet.
    await expect(page).toHaveURL(/\/verify-email/)
    await expect(page.getByTestId('verify-address')).toHaveText(email)

    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/verify-email/)

    // The deadlock check: this route must render in exactly this auth state.
    await page.goto(await activationLinkFor(email))
    await expect(page.getByTestId('action-verified')).toBeVisible({ timeout: 15_000 })

    await page.click('button:has-text("Continue")')
    await expect(page).toHaveURL(/\/dashboard/)

    // Reading this element means the Firestore-backed session is live and the
    // refreshed token satisfied the rules.
    await expect(page.getByTestId('dashboard-email')).toHaveText(email)

    // Session persists across a full reload.
    await page.reload()
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByTestId('dashboard-email')).toHaveText(email)

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
    await page.fill('#signup-password', 'a-completely-different-one')
    await page.click('button[type="submit"]')
    const second = await page.getByTestId('signup-sent').textContent()

    expect(second).toBe(first)
  })
})
