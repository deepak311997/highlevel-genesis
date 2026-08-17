import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import { assertEmulatorBuild, editorText, openNewProject, signUpAndVerify } from './helpers'

/**
 * AC-32 — the slice's demo line, walked in a browser.
 *
 * Real account, real ID token, real Cloud Function routes, real Firestore
 * documents in two collections, a real SSE stream through the Vite dev proxy.
 * Only the model is stubbed, by the emulator-only fake.
 *
 * **Three claims live only here.** The first is that a version list read through
 * `GET …/snapshots` renders rows a user can act on — every level below this
 * either stubs the store or stubs the route. The second is that pressing
 * **Restore** reaches real documents: the file the second turn added is *gone
 * from the tree*, which is R3's failure made visible, and the editor shows
 * version 1's bytes rather than version 2's. The third is that all of it
 * **survives a reload**, which is the only assertion that separates "the store
 * was updated" from "the server was".
 *
 * Two versions are only distinguishable because `__alt_files` exists (D24). With
 * one fixture both generations would write identical bytes, a restore would be a
 * no-op, and this test would pass without proving anything at all.
 *
 * Its own spec rather than a movement inside `files.spec.ts`, as Slice 6's D32
 * asks: that one stays the signal for "file operations broke" and this one for
 * "restore broke", so a red run still names the culprit.
 */

/** What `reply.json` writes, in the tree's order (entry point first). */
const VERSION_ONE = ['index.html', 'app.js', 'styles.css']

/** What `reply-alt.json` leaves behind it: the same three, plus the about page. */
const VERSION_TWO = ['index.html', 'about.html', 'app.js', 'styles.css']

async function generate(page: import('@playwright/test').Page, prompt: string): Promise<void> {
  await page.getByTestId('composer-input').fill(prompt)
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('chat-generating')).toBeVisible()
  await expect(page.getByTestId('chat-generating')).toBeHidden({ timeout: 30_000 })
}

const treePaths = (page: import('@playwright/test').Page): Promise<string[]> =>
  page.getByTestId('file-row').allTextContents()

test.describe('Slice 11 — snapshots and restore', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  test('two generations, a restore, and all of it survives a reload', async ({ page }) => {
    await signUpAndVerify(page, 'snapshots')
    await openNewProject(page)

    /*
     * Movement one: a project that has never generated has no history — the
     * empty state, not an error and not a spinner that never resolves.
     */
    await page.getByTestId('snapshot-trigger').click()
    await expect(page.getByTestId('snapshot-sheet')).toBeVisible()
    await expect(page.getByTestId('snapshot-empty')).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('snapshot-sheet')).toBeHidden()

    /* Movement two: two turns, the second changing one file and adding another. */
    await generate(page, 'build a contact dashboard')
    await expect(page.getByTestId('file-row')).toHaveCount(VERSION_ONE.length)

    await page.getByTestId('file-row').filter({ hasText: 'index.html' }).click()
    await expect(page.getByTestId('code-editor')).toBeVisible()
    await expect.poll(() => editorText(page)).not.toBe('')
    const versionOneHtml = await editorText(page)

    await generate(page, '__alt_files add an about page')
    await expect(page.getByTestId('file-row')).toHaveCount(VERSION_TWO.length)
    expect(await treePaths(page)).toEqual(
      VERSION_TWO.map((path) => expect.stringContaining(path)),
    )

    /*
     * The open tab was rewritten by the second turn, so the editor now holds
     * version 2's bytes. Asserted, because the restore's own assertion below is
     * that this changes back — and a test that never saw it change would prove
     * nothing by seeing it not change.
     */
    await expect.poll(() => editorText(page)).not.toBe(versionOneHtml)

    /* Movement three: the history, with a row per turn that stored files. */
    await page.getByTestId('snapshot-trigger').click()
    await expect(page.getByTestId('snapshot-row')).toHaveCount(2, { timeout: 15_000 })
    // Newest first, so version 2 is the row at the top.
    await expect(page.getByTestId('snapshot-row').first()).toContainText('Version 2')
    await expect(page.getByTestId('snapshot-row').first()).toContainText('Generation')
    await expect(page.getByTestId('snapshot-row').first()).toContainText('4 files')
    await expect(page.getByTestId('snapshot-row').last()).toContainText('Version 1')
    await expect(page.getByTestId('snapshot-row').last()).toContainText('3 files')

    /* Movement four: the two-step confirm, cancelled and then taken. */
    const versionOneRow = page.getByTestId('snapshot-row').last()
    await versionOneRow.getByTestId('snapshot-restore').click()
    await expect(versionOneRow.getByTestId('snapshot-confirm')).toBeVisible()
    await versionOneRow.getByTestId('snapshot-cancel').click()
    await expect(versionOneRow.getByTestId('snapshot-confirm')).toBeHidden()
    await expect(versionOneRow.getByTestId('snapshot-restore')).toBeVisible()

    await versionOneRow.getByTestId('snapshot-restore').click()
    const restored = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().includes('/restore'),
    )
    await versionOneRow.getByTestId('snapshot-confirm').click()
    expect((await restored).status()).toBe(200)

    /*
     * Movement five: a third row, because the restore snapshotted what it was
     * about to replace (D9). This is the undo's undo, on screen.
     */
    await expect(page.getByTestId('snapshot-row')).toHaveCount(3, { timeout: 15_000 })
    await expect(page.getByTestId('snapshot-row').first()).toContainText('Before restore')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('snapshot-sheet')).toBeHidden()

    /*
     * **The assertion R3 is about.** A restore that wrote version 1's files
     * without deleting version 2's extra one would leave four rows here, and the
     * app would be a hybrid of two versions that looks fine in the tree.
     */
    await expect(page.getByTestId('file-row')).toHaveCount(VERSION_ONE.length)
    expect(await treePaths(page)).toEqual(
      VERSION_ONE.map((path) => expect.stringContaining(path)),
    )
    await expect(page.getByTestId('file-row').filter({ hasText: 'about.html' })).toHaveCount(0)

    // And the open tab was re-read from the server, so it shows version 1 again.
    await expect.poll(() => editorText(page)).toBe(versionOneHtml)

    /*
     * Movement six: the reload. A restore that updated the store and stored
     * nothing passes every assertion above this line and fails these.
     */
    await page.reload()
    await expect(page.getByTestId('file-row')).toHaveCount(VERSION_ONE.length)
    await expect(page.getByTestId('file-row').filter({ hasText: 'about.html' })).toHaveCount(0)

    await page.getByTestId('file-row').filter({ hasText: 'index.html' }).click()
    await expect(page.getByTestId('code-editor')).toBeVisible()
    await expect.poll(() => editorText(page)).toBe(versionOneHtml)

    await page.getByTestId('snapshot-trigger').click()
    await expect(page.getByTestId('snapshot-row')).toHaveCount(3, { timeout: 15_000 })
    await expect(page.getByTestId('snapshot-row').first()).toContainText('Before restore')
  })
})
