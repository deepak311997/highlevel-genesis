import { expect, type Page } from '@playwright/test'

import { latestCodeFor } from '../integration/helpers'

/**
 * Getting an account to the dashboard — the one thing every e2e spec needs
 * before it can test anything of its own.
 *
 * Extracted because three suites had begun to need it and two already carried
 * byte-identical copies. A third copy is where they start to drift: the moment
 * one of them learns something the others do not, the ones that did not become
 * quietly wrong about what a signed-up account looks like.
 *
 * No mail provider is involved. Firebase sends the verification email itself and
 * the Auth emulator exposes the code it generated, so the test can follow the
 * link without a mailbox.
 */

export const PASSWORD = 'Correct-Horse-9'

/**
 * How long the sign-up confirmation gets to appear.
 *
 * Every spec funnels through `signUpAndVerify`, so `POST /auth/register` is the
 * most-repeated server round trip in the suite — and on Playwright's 5-second
 * default it was the *only* wait that ever failed. Four consecutive runs of the
 * full suite failed three times, on this assertion every time, at a different
 * test each time: first `auth.spec.ts`, then the last two of `workspace.spec.ts`,
 * then one in the middle of `projects.spec.ts`.
 *
 * It is not the endpoint being slow. The emulator logs the handler finishing in
 * 10–134ms in every observed case including the failing ones, and in the worst
 * of them no invocation is logged at all before the 5 seconds are up — the
 * request had not yet left the dev server. The stall is the machine descheduling
 * a single-threaded Vite process, and it lands here because this is where the
 * suite waits on a round trip with the least headroom.
 *
 * 15 seconds, matching what the two waits immediately below already carry for
 * the same reason — the verification headline and the action page. Sign-up's
 * confirmation is the one step of that flow that never got the same treatment.
 * The assertion is unchanged and nothing here asserts a latency budget: the
 * claim is still that submitting the form produces the confirmation screen.
 */
export const REGISTER_TIMEOUT_MS = 15_000

/** Unique per run, so a re-run does not collide with a previous account. */
export function freshEmail(prefix = 'e2e'): string {
  return `${prefix}-${String(Date.now())}-${String(Math.floor(Math.random() * 10_000))}@example.test`
}

/**
 * The verification link, pointed at *our* action route.
 *
 * The emulator's own link targets its built-in handler; in production the
 * equivalent is the custom action URL configured on the email template. Either
 * way the oobCode is the payload, so this rebuilds the URL the deployed app
 * would receive.
 */
export async function activationLinkFor(email: string): Promise<string> {
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
export async function signUpAndVerify(page: Page, prefix = 'e2e'): Promise<string> {
  const email = freshEmail(prefix)

  await page.goto('/signup')
  await page.fill('#signup-email', email)
  await page.fill('#signup-password', PASSWORD)
  await page.click('button[type="submit"]')
  await expect(page.getByTestId('signup-sent')).toBeVisible({ timeout: REGISTER_TIMEOUT_MS })

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

/**
 * Refuse to run against anything but an emulator build.
 *
 * Playwright will reuse a dev server on the same port, and a development-mode
 * server talks to *real* Firebase — which once meant a suite creating accounts
 * on the live project and failing with a confusing message about missing codes.
 */
export async function assertEmulatorBuild(page: Page): Promise<void> {
  await page.goto('/signin')
  expect(
    await page.locator('html').getAttribute('data-genesis-emulator'),
    'the app under test is not an emulator build — start it with `vite --mode emulator`',
  ).toBe('true')
}

/**
 * Create a project and open its workspace.
 *
 * Extracted for the reason `signUpAndVerify` was: a second suite needs it, and a
 * second copy is where two specs start to disagree about what an open workspace
 * looks like. It waits on the chat panel's empty state rather than on the URL,
 * so callers start from a workspace that has finished loading rather than one
 * that has merely been navigated to.
 */
export async function openNewProject(page: Page, name = 'Contact dashboard'): Promise<void> {
  await page.getByTestId('projects-new').click()
  await page.getByTestId('project-form-name').fill(name)
  await page.getByTestId('project-form-submit').click()
  await expect(page.getByTestId('project-form-dialog')).toBeHidden()
  // The project's *name* is the link, not the row.
  await page.getByTestId('project-name').click()
  await expect(page.getByTestId('chat-empty')).toBeVisible()
}
