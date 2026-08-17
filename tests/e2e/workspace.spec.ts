import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import { assertEmulatorBuild, signUpAndVerify } from './helpers'

/**
 * Slice 4's one end-to-end test: the demo line, walked in a browser.
 *
 * Everything here is the real thing — a real account, a real ID token, real Cloud
 * Function routes, real Firestore documents. Nothing is stubbed, because the
 * assistant in this slice is a server-side echo and there is no third party to stub.
 *
 * **The transcript survives a reload and a round trip through the dashboard**, and
 * those two are the assertions carrying the weight. A send that only appended to
 * component state would pass every check except them; the reload proves the pair came
 * back from `GET /api/projects/:projectId/messages`, and the second visit proves it
 * is not sitting in a store that merely happened not to be cleared.
 *
 * Playwright's Desktop Chrome viewport is 1280×720, so this walks the **resizable**
 * tree — the tabbed one below `lg` is covered at L2, where the breakpoint can be
 * controlled rather than guessed at.
 */

const PROMPT = 'build a contact dashboard'
const ECHO = 'You said: build a contact dashboard'

test.describe('Slice 04 — workspace shell & chat persistence', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  /** AC-37. */
  test('open a project, send a prompt, and find the exchange still there', async ({ page }) => {
    await signUpAndVerify(page, 'workspace')

    await expect(page.getByTestId('projects-empty')).toBeVisible()
    await page.getByTestId('projects-new').click()
    await page.getByTestId('project-form-name').fill('Contact dashboard')
    await page.getByTestId('project-form-submit').click()
    await expect(page.getByTestId('project-form-dialog')).toBeHidden()

    // The project's *name* is the link, and the row is not (D23).
    await page.getByTestId('project-name').click()
    await expect(page).toHaveURL(/\/projects\/[A-Za-z0-9_-]+$/)

    // The header read its project from `GET /api/projects/:projectId` — the store is
    // empty on a deep link, so this is a real request either way (D26).
    await expect(page.getByTestId('workspace-name')).toHaveText('Contact dashboard')
    // No HighLevel connection was made, so the project was created without a
    // locationId and the badge says so (AC-26).
    await expect(page.getByTestId('workspace-connection')).toHaveText('Not connected')

    // All three panels at 1280px wide, and two of them name the slice that fills them.
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expect(page.getByTestId('editor-panel')).toContainText('Slice 6')
    await expect(page.getByTestId('preview-panel')).toContainText('Slice 10')

    // Empty, not an error: a project with no messages is an ordinary place to be.
    await expect(page.getByTestId('chat-empty')).toBeVisible()

    await page.getByTestId('composer-input').fill(PROMPT)
    await page.getByTestId('composer-input').press('Enter')

    // Two bubbles, prompt above echo. `nth` rather than a text search, because the
    // *order* is the thing R1 is about: the two documents share a commit timestamp,
    // and `seq` is what stops the reply rendering above the prompt.
    const bubbles = page.getByTestId('message-bubble')
    await expect(bubbles).toHaveCount(2)
    await expect(bubbles.nth(0)).toContainText(PROMPT)
    await expect(bubbles.nth(0)).toHaveAttribute('data-role', 'user')
    await expect(bubbles.nth(1)).toContainText(ECHO)
    await expect(bubbles.nth(1)).toHaveAttribute('data-role', 'assistant')

    // The composer cleared, so the next prompt starts from nothing.
    await expect(page.getByTestId('composer-input')).toHaveValue('')

    /*
     * The reload. This is the assertion the slice exists for: the pair is read back
     * from Firestore through the API, in the order it was written, by a browser with
     * no Firestore SDK in its bundle at all.
     */
    await page.reload()
    await expect(page.getByTestId('workspace-name')).toHaveText('Contact dashboard')
    await expect(bubbles).toHaveCount(2)
    await expect(bubbles.nth(0)).toContainText(PROMPT)
    await expect(bubbles.nth(1)).toContainText(ECHO)

    // And a third time, arriving through the dashboard rather than a reload — which
    // is a fresh store rather than a fresh page.
    await page.getByRole('link', { name: 'Back to dashboard' }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    await page.getByTestId('project-name').click()

    await expect(page.getByTestId('workspace-name')).toHaveText('Contact dashboard')
    await expect(bubbles).toHaveCount(2)
    await expect(bubbles.nth(0)).toContainText(PROMPT)
    await expect(bubbles.nth(1)).toContainText(ECHO)
  })

  /*
   * Shift+Enter, in a real browser (AC-33). The L2 suite asserts no request is
   * issued; what only a browser can show is that the keystroke actually inserts a
   * newline into the textarea.
   */
  test('Shift+Enter writes a newline instead of sending', async ({ page }) => {
    await signUpAndVerify(page, 'workspace-shift')

    await page.getByTestId('projects-new').click()
    await page.getByTestId('project-form-name').fill('Contact dashboard')
    await page.getByTestId('project-form-submit').click()
    await expect(page.getByTestId('project-form-dialog')).toBeHidden()
    await page.getByTestId('project-name').click()
    await expect(page.getByTestId('chat-empty')).toBeVisible()

    const composer = page.getByTestId('composer-input')
    await composer.fill('first line')
    await composer.press('Shift+Enter')
    await composer.pressSequentially('second line')

    await expect(composer).toHaveValue('first line\nsecond line')
    await expect(page.getByTestId('message-bubble')).toHaveCount(0)
    await expect(page.getByTestId('chat-empty')).toBeVisible()
  })

  /*
   * A project deleted in another tab, then opened (AC-21). The 404 is one answer for
   * absent, soft-deleted, unreadable and somebody else's, and this is the path a real
   * user reaches it by.
   */
  test('a project deleted elsewhere reads as gone, with a way back', async ({ page }) => {
    await signUpAndVerify(page, 'workspace-gone')

    await page.getByTestId('projects-new').click()
    await page.getByTestId('project-form-name').fill('Contact dashboard')
    await page.getByTestId('project-form-submit').click()
    await expect(page.getByTestId('project-form-dialog')).toBeHidden()

    await page.getByTestId('project-name').click()
    await expect(page.getByTestId('workspace-name')).toBeVisible()
    const workspaceUrl = page.url()

    await page.goto('/dashboard')
    await page.getByTestId('project-delete').click()
    await page.getByTestId('project-delete-confirm').click()
    await expect(page.getByTestId('projects-empty')).toBeVisible()

    await page.goto(workspaceUrl)

    await expect(page.getByTestId('workspace-missing')).toContainText(
      'That project no longer exists.',
    )
    await expect(page.getByTestId('chat-panel')).toBeHidden()
    await page.getByRole('link', { name: 'Back to dashboard' }).click()
    await expect(page).toHaveURL(/\/dashboard/)
  })
})
