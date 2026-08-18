import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import {
  assertEmulatorBuild,
  editorText,
  openNewProject,
  setEditorContent,
  signUpAndVerify,
} from './helpers'

/**
 * AC-48 — the slice's demo line, walked in a browser.
 *
 * Real account, real ID token, real Cloud Function routes, real Firestore documents, a real SSE
 * stream through the Vite dev proxy. Only the model is stubbed, by the emulator-only fake.
 *
 * Two assertions here cannot be made anywhere else in the suite. The **first** is that a file
 * row appears *while the reply is still streaming*: L1 can prove the store fills a buffer and L2
 * that a marked row renders, but only this can prove that the frames survive the proxy in time
 * to be seen — a buffering proxy would deliver every `file_chunk` at once, after which the tree
 * would fill in simultaneously with the reply finishing and look identical to a broken one. The
 * **second** is that an edit survives a reload, which is the whole of "save an edit": a `PUT`
 * that returned 200 and stored nothing passes every other level.
 */

/** `__slow` makes the stream observable: 600 ms, then a token every 150 ms. */
const PROMPT = '__slow build a contact dashboard'

/**
 * What `reply.json` writes, in the tree's order.
 *
 * The tree groups by kind now — markup, styles, scripts — with the entry point
 * still first inside its own group, so this is no longer the flat alphabetical
 * order the paths would sort into. Written out rather than derived, because a
 * list computed the same way the component computes it asserts nothing.
 */
const GENERATED = ['index.html', 'styles.css', 'app.js']

/**
 * Slice 9 AC-26 — the one function the generated code reaches HighLevel through.
 *
 * Beside `GENERATED` because both are facts about the same fixture, and the fixture is hand-
 * authored (`tests/fixtures/llm/README.md`, D20): this asserts that HighLevel-shaped code
 * reaches the editor through the whole pipeline, not that the real model writes it.
 */
const HL_CALL = /hl\(/

test.describe('Slice 06 — file operations', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  test('files stream into the tree, and an edit survives a reload', async ({ page }) => {
    await signUpAndVerify(page, 'files')
    await openNewProject(page)

    // A project that has never generated: the empty state, not an error.
    await expect(page.getByTestId('file-tree-empty')).toBeVisible()
    await expect(page.getByTestId('file-editor-empty')).toBeVisible()

    /* Movement one: the reply, and the tree filling in as it arrives. */
    await page.getByTestId('composer-input').fill(PROMPT)
    await page.getByTestId('composer-input').press('Enter')

    await expect(page.getByTestId('chat-generating')).toBeVisible()

    /*
     * **The assertion this test exists for.** A row is on screen while the badge
     * still is, so the file frames reached the browser during the stream rather
     * than in one buffered lump at the end.
     */
    await expect(page.getByTestId('file-row').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('chat-generating')).toBeVisible()

    // And the bubble shows chips, not code — the whole of D6, in the running app.
    const streaming = page.getByTestId('streaming-bubble')
    await expect(streaming.getByTestId('file-chip').first()).toBeVisible()
    await expect(streaming).not.toContainText('<genesis:file')
    await expect(streaming).not.toContainText('[file:')

    /* Movement two: the stream ends, and the list is what the server stored. */
    await expect(page.getByTestId('chat-generating')).toBeHidden({ timeout: 20_000 })
    await expect(page.getByTestId('file-row')).toHaveCount(GENERATED.length)
    expect(await page.getByTestId('file-row').allTextContents()).toEqual(
      GENERATED.map((path) => expect.stringContaining(path)),
    )
    // Nothing was refused, so the bubble carries no error chip.
    await expect(page.getByTestId('message-error')).toHaveCount(0)

    // The persisted bubble carries the same chips and still no code.
    const reply = page.getByTestId('message-bubble').nth(1)
    await expect(reply.getByTestId('file-chip')).toHaveCount(GENERATED.length)
    await expect(reply).not.toContainText('<h1')

    /* Movement three: the differentiator, read out of the editor. */
    await page.getByTestId('file-row').filter({ hasText: 'app.js' }).click()
    await expect(page.getByTestId('code-editor')).toBeVisible()
    await expect.poll(async () => (await editorText(page)) ?? '').toMatch(HL_CALL)

    /*
     * Captured once and asserted three times, rather than re-read per assertion:
     * the two negatives are satisfied by an empty string, so they are only worth
     * anything against a value that has been shown to hold `hl(`.
     */
    const generated = (await editorText(page)) ?? ''
    expect(generated).toMatch(HL_CALL)
    expect(generated).not.toMatch(/locationId/)
    expect(generated).not.toMatch(/leadconnectorhq/)

    /* Movement four: open a file, edit it, save it. */
    await page.getByTestId('file-row').filter({ hasText: 'index.html' }).click()
    await expect(page.getByTestId('code-editor')).toBeVisible()
    await expect.poll(() => editorText(page)).not.toBe('')
    /* Editable again: the read-only window is exactly the length of a stream. */
    await expect(page.getByTestId('file-editor-readonly')).toBeHidden()

    const edited = '<!doctype html>\n<title>Edited by the test</title>\n'
    await setEditorContent(page, edited)
    await expect(page.getByTestId('file-editor-save')).toBeEnabled()

    /*
     * Waited on the response rather than on the button. Save is disabled *while*
     * the request is in flight as well as after it succeeds, so a state assertion
     * alone cannot tell "stored" from "still going" — and the reload below would
     * then abort the very PUT this test is about.
     */
    const stored = page.waitForResponse(
      (res) => res.request().method() === 'PUT' && res.url().includes('/files/index.html'),
    )
    await page.getByTestId('file-editor-save').click()
    expect((await stored).status()).toBe(200)

    // Settled: the server's answer replaced the buffer, so there is nothing to save.
    await expect(page.getByTestId('file-editor-save')).toBeDisabled()
    await expect(page.getByTestId('file-editor-error')).toBeHidden()

    /*
     * Movement five: the reload. A `PUT` that answered 200 and stored nothing
     * passes every assertion above this line and fails this one.
     */
    await page.reload()
    await expect(page.getByTestId('file-row')).toHaveCount(GENERATED.length)
    // A reload opens no tab (D12's set is per session), so the strip is empty.
    await expect(page.getByTestId('editor-tab')).toHaveCount(0)
    await page.getByTestId('file-row').filter({ hasText: 'index.html' }).click()

    // Read from the model, so the trailing newline survives the assertion.
    await expect.poll(() => editorText(page)).toBe(edited)
  })

  /**
   * A reply whose files are refused: the turn still lands, nothing is written, and the bubble
   * says which file it was about (D18) — in the transcript rather than in a banner beside it,
   * so it survives the reload that used to clear it.
   */
  test('a refused file set leaves the tree untouched and names the refusal', async ({ page }) => {
    await signUpAndVerify(page, 'files-bad')
    await openNewProject(page)

    await page.getByTestId('composer-input').fill('__bad_path build something')
    await page.getByTestId('composer-input').press('Enter')

    await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 20_000 })
    await expect(page.getByTestId('chat-generating')).toBeHidden()

    await expect(page.getByTestId('message-error')).toContainText('secrets.js')
    // Nothing was stored, so the tree is back to the state it opened in.
    await expect(page.getByTestId('file-tree-empty')).toBeVisible()
    await expect(page.getByTestId('file-row')).toHaveCount(0)
    await expect(page.getByTestId('file-editor-empty')).toBeVisible()
  })
})
