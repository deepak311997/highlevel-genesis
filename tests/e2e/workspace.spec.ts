import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import { assertEmulatorBuild, signUpAndVerify } from './helpers'

/**
 * The demo line, walked in a browser.
 *
 * Everything here is the real thing — a real account, a real ID token, real Cloud
 * Function routes, real Firestore documents, and a real SSE stream through the
 * **Vite dev proxy**. Only the model is stubbed, by the emulator-only fake (D20).
 *
 * **That proxy is the point of running the streaming assertion here** (R3). Slice
 * 0 proved the Hosting rewrite streams; nothing had proved the dev proxy does,
 * and a buffering one would make every local demo look broken while production
 * was fine. Asserting that the placeholder bubble is visible with *less* text
 * than the finished reply is what a fully buffered response cannot satisfy.
 *
 * **The transcript survives a reload and a round trip through the dashboard**, and
 * those two are the assertions carrying the weight. A send that only appended to
 * component state would pass every check except them; the reload proves the turn
 * came back from `GET /api/projects/:projectId/messages`, and the second visit
 * proves it is not sitting in a store that merely happened not to be cleared.
 *
 * Playwright's Desktop Chrome viewport is 1280×720, so this walks the **resizable**
 * tree — the tabbed one below `lg` is covered at L2, where the breakpoint can be
 * controlled rather than guessed at.
 */

/** `__slow` makes the stream observable: 600 ms, then a token every 150 ms. */
const PROMPT = '__slow build a contact dashboard'

/** Create a project and open it. Every test here starts from a workspace. */
async function openNewProject(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('projects-new').click()
  await page.getByTestId('project-form-name').fill('Contact dashboard')
  await page.getByTestId('project-form-submit').click()
  await expect(page.getByTestId('project-form-dialog')).toBeHidden()
  await page.getByTestId('project-name').click()
  await expect(page.getByTestId('chat-empty')).toBeVisible()
}

test.describe('Slice 05 — streaming generation', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  /**
   * AC-44, and the demo line in full: a failed open, a Retry, a reply arriving
   * progressively, and the whole exchange still there after a reload.
   *
   * **The Retry is driven by a withdrawn failure, not by a marker**, and that is
   * not a contrivance — it is forced by D6. After a failed turn the transcript
   * ends on the same user message, so a fake keyed on a marker in that message
   * would fail identically forever and Retry could never succeed. Intercepting
   * the first `POST /generate` and withdrawing the interception is a real
   * failure the user can genuinely recover from, which is what F8.2 promises.
   *
   * It is `fulfill` rather than `abort`, and that is load-bearing: aborting the
   * request mid-flight leaves the functions emulator's pooled upstream socket
   * dirty, and the **next test's** `POST /generate` comes back as an empty 400.
   * A refused response is the same client path — `!res.ok`, an `ApiError`, the
   * error state, a Retry — without poisoning the connection for whatever runs
   * after it.
   */
  test('a failed generation, a Retry, and a reply that arrives progressively', async ({ page }) => {
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
    await expect(page.getByTestId('workspace-connection')).toHaveText('Not connected')

    // All three panels at 1280px wide. Two of them are screens now; the third
    // still names the slice that fills it.
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expect(page.getByTestId('file-tree')).toBeVisible()
    await expect(page.getByTestId('preview-panel')).toContainText('Slice 10')

    // A project that has never generated: the tree's empty state, not an error.
    await expect(page.getByTestId('file-tree-empty')).toBeVisible()

    // Empty, not an error: a project with no messages is an ordinary place to be.
    await expect(page.getByTestId('chat-empty')).toBeVisible()

    // AC-38's second clause, in the running app.
    await expect(page.getByTestId('chat-panel')).not.toContainText('Echo mode')

    /* Movement one: the stream is refused before it can open (D9's first channel). */
    await page.route('**/generate', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Something went wrong. Please try again.',
          code: 'internal',
        }),
      }),
    )

    await page.getByTestId('composer-input').fill(PROMPT)
    await page.getByTestId('composer-input').press('Enter')

    const bubbles = page.getByTestId('message-bubble')
    // The prompt is durable before the expensive half begins (D3, F8.2): the user
    // bubble is on screen even though the generation never started.
    await expect(bubbles).toHaveCount(1)
    await expect(bubbles.nth(0)).toContainText(PROMPT)
    await expect(bubbles.nth(0)).toHaveAttribute('data-role', 'user')
    await expect(page.getByTestId('generate-error')).toContainText(
      'Something went wrong. Please try again.',
    )
    await expect(page.getByTestId('generate-retry')).toBeVisible()
    // The composer cleared and is usable again, so the turn is not a dead end.
    await expect(page.getByTestId('composer-input')).toHaveValue('')
    await expect(page.getByTestId('chat-generating')).toBeHidden()

    /* Movement two: withdraw the failure and retry — no new user message (D26). */
    await page.unroute('**/generate')
    await page.getByTestId('generate-retry').click()

    // The badge, while the model is thinking (D30). `__slow` holds this open for
    // 600 ms before the first token, which is also what AC-19's keep-alive needs.
    await expect(page.getByTestId('chat-generating')).toBeVisible()

    /*
     * **R3's assertion.** The placeholder is visible with *part* of the reply in
     * it, which a fully buffered dev proxy cannot produce: buffering would deliver
     * the whole body at once and the placeholder would go from empty straight to
     * replaced.
     */
    const streaming = page.getByTestId('streaming-bubble')
    await expect(streaming).toBeVisible()
    await expect(streaming).toContainText('Here is a contact dashboard.')
    const partial = (await streaming.textContent()) ?? ''

    // Then the finished reply, as a real bubble with a server id behind it.
    await expect(bubbles).toHaveCount(2, { timeout: 15_000 })
    await expect(bubbles.nth(1)).toHaveAttribute('data-role', 'assistant')
    const whole = (await bubbles.nth(1).textContent()) ?? ''
    expect(whole.length).toBeGreaterThan(partial.length)

    // The badge and the placeholder both go when the stream ends (AC-39).
    await expect(page.getByTestId('chat-generating')).toBeHidden()
    await expect(streaming).toBeHidden()
    await expect(page.getByTestId('generate-error')).toBeHidden()
    // A completed reply carries no interrupted marker.
    await expect(page.getByTestId('message-interrupted')).toHaveCount(0)

    /*
     * Movement three: the reload. This is the assertion the slice exists for —
     * the turn is read back from Firestore through the API, in the order it was
     * written, by a browser with no Firestore SDK in its bundle at all.
     */
    await page.reload()
    await expect(page.getByTestId('workspace-name')).toHaveText('Contact dashboard')
    await expect(bubbles).toHaveCount(2)
    await expect(bubbles.nth(0)).toContainText(PROMPT)
    await expect(bubbles.nth(1)).toContainText('Here is a contact dashboard.')

    // And again through the dashboard rather than a reload — a fresh store rather
    // than a fresh page.
    await page.getByRole('link', { name: 'Back to dashboard' }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    await page.getByTestId('project-name').click()

    await expect(page.getByTestId('workspace-name')).toHaveText('Contact dashboard')
    await expect(bubbles).toHaveCount(2)
    await expect(bubbles.nth(1)).toContainText('Here is a contact dashboard.')
  })

  /**
   * AC-44's second half: an interrupted reply, preserved and marked.
   *
   * `__fail_midstream` is a **real** mid-stream upstream failure — two tokens,
   * then the connection to the model dies. The server persists what it had with
   * `truncated: true` and sends an `error` frame carrying that document, so the
   * placeholder is replaced by the server's own record rather than by the
   * client's copy of it (D9). That is F8.2's partial preservation, end to end.
   *
   * The plan's version of this movement navigated away mid-stream instead. It
   * cannot be tested here: the functions emulator never propagates a client
   * disconnect to the function runtime, which T11 measured — so that path is
   * covered at L1 and hand-checked in Slice 13, and this covers the same
   * user-visible outcome by the failure mode that *is* reachable.
   */
  test('an interrupted reply is preserved, marked, and offers a Retry', async ({ page }) => {
    await signUpAndVerify(page, 'workspace-interrupted')
    await openNewProject(page)

    await page.getByTestId('composer-input').fill('__fail_midstream build a contact dashboard')
    await page.getByTestId('composer-input').press('Enter')

    const bubbles = page.getByTestId('message-bubble')
    await expect(bubbles).toHaveCount(2, { timeout: 15_000 })
    await expect(bubbles.nth(1)).toHaveAttribute('data-role', 'assistant')

    // The partial is on screen, and says it is one.
    await expect(page.getByTestId('message-interrupted')).toBeVisible()
    await expect(page.getByTestId('generate-error')).toBeVisible()
    await expect(page.getByTestId('generate-retry')).toBeVisible()

    // The partial is genuinely shorter than a complete reply would have been.
    const partial = (await bubbles.nth(1).textContent()) ?? ''
    expect(partial).not.toContain('Every value is read from your CRM account.')

    /*
     * And it is in Firestore, not merely in a store. Re-entering through the
     * dashboard is a fresh store, so what renders here came back from
     * `GET /api/projects/:projectId/messages` carrying `truncated: true`.
     */
    await page.getByRole('link', { name: 'Back to dashboard' }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    await page.getByTestId('project-name').click()

    await expect(bubbles).toHaveCount(2)
    await expect(page.getByTestId('message-interrupted')).toBeVisible()
    // The error is not persisted — it belonged to the request, not to the
    // transcript — so a returning user sees the partial and no stale alarm.
    await expect(page.getByTestId('generate-error')).toBeHidden()
  })

  /**
   * **Two prompts in a row** — the case that caught a real bug, and the reason it
   * is a permanent test rather than a one-off check.
   *
   * `/generate` originally set `Connection: keep-alive` by hand, inherited from
   * Slice 0. It is a hop-by-hop header the HTTP layer owns, and with it set the
   * first generation of a session succeeded while the **second `POST /generate`
   * on the reused socket came back as an empty 400** — so the second prompt of
   * every conversation failed, in the running app, with nothing in the logs to
   * say why. Every single-turn test passed throughout.
   *
   * One turn proves the transport works once. This proves it works twice, which
   * is the first thing a real user does.
   */
  test('a second prompt in the same conversation also gets a reply', async ({ page }) => {
    await signUpAndVerify(page, 'workspace-second')
    await openNewProject(page)

    const bubbles = page.getByTestId('message-bubble')

    await page.getByTestId('composer-input').fill('build a contact dashboard')
    await page.getByTestId('composer-input').press('Enter')
    await expect(bubbles).toHaveCount(2, { timeout: 15_000 })

    await page.getByTestId('composer-input').fill('and add a search box')
    await page.getByTestId('composer-input').press('Enter')
    await expect(bubbles).toHaveCount(4, { timeout: 15_000 })

    await expect(page.getByTestId('generate-error')).toBeHidden()
    await expect(bubbles.nth(2)).toHaveAttribute('data-role', 'user')
    await expect(bubbles.nth(3)).toHaveAttribute('data-role', 'assistant')

    // And both turns are in Firestore, in order, after a reload.
    await page.reload()
    await expect(bubbles).toHaveCount(4)
    await expect(bubbles.nth(0)).toContainText('build a contact dashboard')
    await expect(bubbles.nth(2)).toContainText('and add a search box')
  })

  /**
   * The model declining, which is a 200 with no content at all (D18).
   *
   * Nothing is persisted, because there is nothing to persist — so the transcript
   * keeps just the prompt, and the panel says why rather than showing an empty
   * assistant bubble.
   */
  test('a refusal leaves the prompt alone and explains itself', async ({ page }) => {
    await signUpAndVerify(page, 'workspace-refused')
    await openNewProject(page)

    await page.getByTestId('composer-input').fill('__refuse do something dubious')
    await page.getByTestId('composer-input').press('Enter')

    await expect(page.getByTestId('generate-error')).toContainText('Claude declined to answer that')
    await expect(page.getByTestId('message-bubble')).toHaveCount(1)
    await expect(page.getByTestId('chat-generating')).toBeHidden()
  })

  /*
   * Shift+Enter, in a real browser (AC-33). The L2 suite asserts no request is
   * issued; what only a browser can show is that the keystroke actually inserts a
   * newline into the textarea.
   */
  test('Shift+Enter writes a newline instead of sending', async ({ page }) => {
    await signUpAndVerify(page, 'workspace-shift')
    await openNewProject(page)

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
