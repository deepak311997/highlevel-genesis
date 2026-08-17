import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import { assertEmulatorBuild, signUpAndVerify } from './helpers'

/**
 * Slice 3's one end-to-end test: the demo line, walked in a browser.
 *
 * Everything here is the real thing — a real account, a real ID token, real
 * Cloud Function routes, real Firestore documents. Nothing is stubbed, because
 * there is no third party in this slice to stub.
 *
 * **Every step survives a reload**, and that is the assertion carrying the
 * weight. A create that only updated component state would pass every check
 * except that one; reloading is what proves the row came back from
 * `GET /api/projects`, which means it was written to a collection the browser
 * cannot reach with the Firestore SDK — because there is no Firestore SDK in the
 * bundle at all.
 */

test.describe('Slice 03 — projects', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  /** AC-34. */
  test('create a project, rename it, delete it, and end where you started', async ({ page }) => {
    await signUpAndVerify(page, 'projects')

    // Empty state: the card has asked the endpoint and been told there is
    // nothing. Reaching this at all proves the authenticated GET works with a
    // real ID token.
    await expect(page.getByTestId('projects-empty')).toBeVisible()

    await page.getByTestId('projects-new').click()
    await page.getByTestId('project-form-name').fill('Contact dashboard')
    await page.getByTestId('project-form-description').fill('Lists and filters contacts')
    await page.getByTestId('project-form-submit').click()

    // The dialog closes and the store refetches, so the row is the server's
    // answer rather than what was typed.
    await expect(page.getByTestId('project-form-dialog')).toBeHidden()
    await expect(page.getByTestId('project-name')).toHaveText('Contact dashboard')
    await expect(page.getByTestId('project-description')).toHaveText('Lists and filters contacts')
    await expect(page.getByTestId('project-updated')).toContainText('Updated')

    await page.reload()
    await expect(page.getByTestId('project-name')).toHaveText('Contact dashboard')

    await page.getByTestId('project-rename').click()
    await expect(page.getByTestId('project-form-name')).toHaveValue('Contact dashboard')
    await page.getByTestId('project-form-name').fill('Contacts')
    await page.getByTestId('project-form-submit').click()

    await expect(page.getByTestId('project-form-dialog')).toBeHidden()
    await expect(page.getByTestId('project-name')).toHaveText('Contacts')

    await page.reload()
    await expect(page.getByTestId('project-name')).toHaveText('Contacts')

    await page.getByTestId('project-delete').click()
    await expect(page.getByTestId('project-delete-name')).toHaveText('Contacts')
    await page.getByTestId('project-delete-confirm').click()

    // Back to where we started — the empty state, not an empty list with a
    // heading over it.
    await expect(page.getByTestId('projects-empty')).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('projects-empty')).toBeVisible()
  })

  /*
   * The rest of the dashboard is unaffected by any of it. The account card and
   * the connection panel each own a store and an endpoint of their own, and a
   * slice that quietly broke one of them would still pass every test above.
   */
  test('leaves the rest of the dashboard working', async ({ page }) => {
    const email = await signUpAndVerify(page, 'projects')

    await page.getByTestId('projects-new').click()
    await page.getByTestId('project-form-name').fill('Contact dashboard')
    await page.getByTestId('project-form-submit').click()
    await expect(page.getByTestId('project-name')).toHaveText('Contact dashboard')

    await expect(page.getByTestId('dashboard-email')).toHaveText(email)
    await expect(page.getByTestId('connection-empty')).toBeVisible()

    await page.click('button:has-text("Sign out")')
    await expect(page).toHaveURL(/\/signin/)
  })
})
