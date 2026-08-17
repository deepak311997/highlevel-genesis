import { expect, test } from '@playwright/test'

import { resetEmulators } from '../integration/helpers'
import {
  assertEmulatorBuild,
  editorText,
  editorTokenClasses,
  focusEditor,
  openNewProject,
  setEditorContent,
  signUpAndVerify,
} from './helpers'

/**
 * AC-30 and AC-31 — **the only level where Monaco actually runs** (D23, R3).
 *
 * Everything decidable without a browser is proven cheaply elsewhere: the
 * language map, the append-vs-replace rule, the model registry, and the props
 * `CodeEditor` passes. What is left needs a layout engine and a canvas, and it is
 * precisely the part that would ship broken and silent:
 *
 * - **Colouring.** A missing `basic-languages` contribution, or a wrong language
 *   id, renders grey text — correct, readable, and wrong. More than one distinct
 *   `mtk*` class is what "syntax-coloured" means in the DOM.
 * - **A non-zero height.** Monaco measures its container, so a container sized by
 *   its own content collapses the editor to 0 px and renders nothing at all, with
 *   no error attached (R4). jsdom computes no layout, so L2 can only pin classes.
 * - **`readOnly` actually refusing a keystroke.** L2 asserts the option is
 *   passed; only Monaco can be asked whether it honoured it.
 * - **A buffer surviving a tab switch**, which is the whole reason this slice
 *   exists, end to end and through the real widget.
 *
 * Two specs, not one (D24): `files.spec.ts` stays the signal for "file operations
 * broke" and this one for "the editor broke", so a red run still names which.
 */

/** `__slow` makes the stream observable: 600 ms, then a token every 150 ms. */
const PROMPT = '__slow build a contact dashboard'

/**
 * AC-25's runtime half — **the editor never reaches for a CDN** (D2).
 *
 * `no-cdn.spec.ts` proves nobody wrote one of these hosts into `frontend/src`,
 * which is a claim about the source and not about the running app:
 * `@monaco-editor/loader`'s own default — `cdn.jsdelivr.net/npm/monaco-editor@…`
 * — is inside the bundle whatever our source says, and what makes it inert is
 * `loader.config({ monaco })` having run before the first `init()`. Only a
 * browser can be asked whether that held. A regression here is invisible on a
 * developer's machine and fatal on a locked-down network, which is exactly the
 * shape of failure this suite exists to catch.
 */
const CDN_HOST = /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/

test.describe('Slice 07 — Monaco editor', () => {
  test.beforeEach(async ({ page }) => {
    await resetEmulators()
    await assertEmulatorBuild(page)
  })

  test('code streams coloured into a locked editor, and tabs keep their edits', async ({
    page,
  }) => {
    // Registered before the first navigation, so it sees every request this test
    // makes — including the ones the reload at the end issues.
    const cdn: string[] = []
    page.on('request', (request) => {
      if (CDN_HOST.test(request.url())) cdn.push(request.url())
    })

    await signUpAndVerify(page, 'editor')
    await openNewProject(page)

    await expect(page.getByTestId('file-editor-empty')).toBeVisible()
    // Nothing is open, so there is no strip at all.
    await expect(page.getByTestId('editor-tab')).toHaveCount(0)

    /* Movement one: the stream, coloured, into an editor that refuses to be typed in. */
    await page.getByTestId('composer-input').fill(PROMPT)
    await page.getByTestId('composer-input').press('Enter')
    await expect(page.getByTestId('chat-generating')).toBeVisible()

    // The generation opened a tab into an empty strip (D11, AC-18).
    await expect(page.getByTestId('editor-tab')).toHaveCount(1, { timeout: 20_000 })
    await expect(page.getByTestId('code-editor')).toBeVisible()

    /*
     * **AC-31's first assertion.** More than one distinct token class while the
     * badge is still up: the bytes are being coloured *as they arrive*, which is
     * the thing D8's append edit exists to make possible and which a `setValue`
     * per chunk would also produce — but only after snapping the view to line 1,
     * which is what AC-30's height and the tail-following below are about.
     */
    await expect
      .poll(async () => (await editorTokenClasses(page)).length, { timeout: 20_000 })
      .toBeGreaterThan(1)
    await expect(page.getByTestId('chat-generating')).toBeVisible()

    /*
     * Locked, and saying so (D9, AC-11) — and **Monaco actually refuses the
     * keystroke**, which is the half no other level can assert: L2 proves the
     * `readOnly` option is passed, not that it was honoured.
     *
     * Phrased as "the typed string never appears" rather than "the text is
     * unchanged", because the stream is still appending underneath and a snapshot
     * comparison would race it.
     */
    await expect(page.getByTestId('file-editor-readonly')).toBeVisible()
    expect(await editorText(page)).not.toBe('')
    await focusEditor(page)
    await page.keyboard.insertText('typed while generating')
    expect(await editorText(page)).not.toContain('typed while generating')

    /* Movement two: the stream ends, and the editor is editable again. */
    await expect(page.getByTestId('chat-generating')).toBeHidden({ timeout: 20_000 })
    await expect(page.getByTestId('file-editor-readonly')).toBeHidden()

    /* Movement three: a second tab, an edit, and a switch that does not lose it. */
    await page.getByTestId('file-row').filter({ hasText: 'styles.css' }).click()
    await expect(page.getByTestId('editor-tab')).toHaveCount(2)

    const edited = 'body { margin: 0 }\n.edited-by-the-test { display: none }\n'
    await setEditorContent(page, edited)
    await expect(page.getByTestId('file-editor-save')).toBeEnabled()

    // Away and back. **This is the slice's reason for existing.**
    await page.getByTestId('editor-tab').first().click()
    await expect.poll(() => editorText(page)).not.toBe(edited)
    await page.getByTestId('editor-tab').nth(1).click()
    expect(await editorText(page)).toBe(edited)
    await expect(page.getByTestId('file-editor-save')).toBeEnabled()

    /*
     * Waited on the response rather than on the button, `files.spec.ts`'s rule:
     * Save is disabled *while* the request is in flight as well as after it
     * succeeds, so a state assertion alone cannot tell "stored" from "still
     * going" — and the reload below would abort the very PUT this is about.
     */
    const stored = page.waitForResponse(
      (res) => res.request().method() === 'PUT' && res.url().includes('/files/styles.css'),
    )
    await page.getByTestId('file-editor-save').click()
    expect((await stored).status()).toBe(200)
    await expect(page.getByTestId('file-editor-save')).toBeDisabled()

    /* Movement four: the reload. A PUT that answered 200 and stored nothing
       passes every assertion above this line and fails this one. */
    await page.reload()
    await expect(page.getByTestId('editor-tab')).toHaveCount(0)
    await expect(page.getByTestId('file-editor-empty')).toBeVisible()

    await page.getByTestId('file-row').filter({ hasText: 'styles.css' }).click()
    await expect.poll(() => editorText(page)).toBe(edited)

    /* AC-25, at the only level that can answer it — see `CDN_HOST`. Monaco
       mounted, coloured, streamed, saved and reloaded above this line, and not
       one byte of it came off a CDN. */
    expect(cdn).toEqual([])
  })

  /**
   * AC-30 — **the box has a size**, at both layouts.
   *
   * This is the Slice 6 finding in the form Monaco makes fatal: a container sized
   * by its own content collapses the editor to zero and renders nothing, with no
   * error and no failing test anywhere below this line. Asserted on both the
   * resizable layout and the narrow tabbed one, because they are two component
   * trees rather than one tree with CSS on it — a broken chain in one is
   * invisible to a test that only looks at the other.
   */
  test('the editor renders with a real height at both layouts', async ({ page }) => {
    await signUpAndVerify(page, 'editor-box')
    await openNewProject(page)

    await page.getByTestId('composer-input').fill('build a contact dashboard')
    await page.getByTestId('composer-input').press('Enter')
    await expect(page.getByTestId('chat-generating')).toBeHidden({ timeout: 30_000 })

    await page.getByTestId('file-row').filter({ hasText: 'index.html' }).click()
    await expect(page.getByTestId('code-editor')).toBeVisible()

    const wide = await page.getByTestId('code-editor').boundingBox()
    expect(wide?.height ?? 0).toBeGreaterThan(100)
    // Monaco's own line elements, so this is the editor rendering rather than an
    // empty box that happens to be tall.
    await expect.poll(() => page.locator('.view-line').count()).toBeGreaterThan(0)

    // The tree still scrolls within its cap, with every row reachable.
    const capped = page.locator('[data-testid="editor-panel"] .max-h-56')
    await expect(capped).toHaveCount(1)
    await expect(page.getByTestId('file-row')).toHaveCount(3)

    /* The narrow layout is a different component tree, so it is asserted again. */
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: 'Code' }).click()
    await expect(page.getByTestId('code-editor')).toBeVisible()

    const narrow = await page.getByTestId('code-editor').boundingBox()
    expect(narrow?.height ?? 0).toBeGreaterThan(100)
    await expect.poll(() => page.locator('.view-line').count()).toBeGreaterThan(0)
  })
})
