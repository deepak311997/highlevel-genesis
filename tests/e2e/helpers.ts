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

/**
 * Reading and writing Monaco from a test (Slice 7, D24, P3).
 *
 * `fill()` and `toHaveValue()` both stop working the moment the textarea is gone,
 * and Monaco **virtualises its lines** — only what is on screen is in the DOM —
 * so scraping `.view-lines` is neither exact nor stable: it would miss the tail
 * of a long file and drop the trailing newline of a short one.
 *
 * So reads go through the model and writes go through the widget. That split is
 * deliberate: the read has to be exact for the assertions to mean anything, and
 * the write has to be real for the test to prove a user can type.
 */

/**
 * What the browser context exposes, declared here because this tree is its own
 * TypeScript program — the root `tsconfig.json` covers `tests/` and does not see
 * `frontend/src/env.d.ts`, where the app declares the same property.
 *
 * Narrowed to exactly what is read, so this cannot quietly become a second,
 * looser description of monaco.
 */
declare global {
  interface Window {
    monaco?: {
      editor: {
        getEditors: () => { getModel: () => { getValue: () => string } | null }[]
      }
    }
  }
}

/**
 * The editor's visible surface — **the only thing that can be clicked**.
 *
 * Monaco's input is a zero-size `textarea.inputarea` sitting under `.view-lines`,
 * which intercepts pointer events, so a click on the textarea never lands and
 * Playwright retries until the test times out. Focusing it directly does not work
 * either, and fails in a much nastier way: the textarea holds only a small window
 * of text around the cursor, so a browser-level `Cmd+A` inside it selects that
 * fragment rather than reaching Monaco's own select-all — and the following
 * `Delete` removes **one character** of the document. Clicking the surface is
 * what puts Monaco itself into a focused state, after which its keybindings run.
 */
const SURFACE = '.monaco-editor .view-lines'

/**
 * The active editor's text, read from its model.
 *
 * **Parity, not a test hook.** `@monaco-editor/loader`'s CDN path publishes
 * `window.monaco` as a matter of course and its `init()` explicitly looks for it;
 * the locally bundled path was the odd one out, and `lib/monacoSetup.ts` sets it
 * for that reason. What this buys the suite is an *exact* read, which is what
 * lets `files.spec.ts` keep asserting the same strings it did over a textarea —
 * trailing newline included.
 */
export async function editorText(page: Page): Promise<string | null> {
  return page.evaluate(() => window.monaco?.editor.getEditors()[0]?.getModel()?.getValue() ?? null)
}

/**
 * Replace the editor's content the way a person would: focus, select all, delete,
 * type.
 *
 * `insertText` rather than `type()` — it delivers the whole string as **one**
 * input event, so Monaco's auto-closing brackets cannot rewrite what the test
 * meant to write. Typing `<title>` character by character produces `<title>>`.
 */
export async function setEditorContent(page: Page, text: string): Promise<void> {
  await selectAllInEditor(page)

  /*
   * **Clear first, then write into an empty document with no selection.**
   *
   * Writing straight over the selection does not work, and the reason is
   * `autoSurround`: typing an opening bracket while text is selected wraps that
   * text rather than replacing it. Measured — `'<!doctype html>'` came back as
   * `'<!doctype html>>'` and `'<title>x</title>\n'` as `'<title>x</title>\n>'`,
   * while `'abc\n'` was untouched. The leading `<` surrounded the whole document
   * (`<` + old + `>`), the rest of the insert then replaced the old text inside
   * it, and the `>` was left at the end. That is correct editor behaviour, not a
   * bug to switch off in the product to suit a test.
   *
   * With nothing selected there is nothing to surround, and a multi-character
   * insert does not auto-close either — Monaco only runs those interceptors for
   * single-character types.
   */
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)

  // The helper verifies its own work, so a selection or an insert that went
  // wrong fails here with a readable diff rather than three assertions later.
  expect(await editorText(page)).toBe(text)
}

/**
 * Select the whole document, **without a `Cmd`/`Ctrl` chord**.
 *
 * Measured against the running editor rather than guessed at. With the editor
 * focused (`hasTextFocus()` true, caret placed by the click), pressing
 * `ControlOrMeta+a` leaves `getSelection()` **completely unchanged** — as does
 * `ControlOrMeta+ArrowDown`. `Shift+ArrowDown` on its own moves it correctly. So
 * Monaco's keybindings work fine under Playwright; the modified chords are what
 * never arrive, which is why `Cmd+A` "select all" silently did nothing and the
 * following `Delete` fell through to the textarea's own native forward-delete,
 * removing exactly one character.
 *
 * A corner-to-corner drag was tried instead and is worse: Monaco clamps the
 * endpoint to the last rendered line, leaving the tail of the file behind.
 *
 * So the selection is built out of the keys that do arrive, and **without
 * assuming where the caret starts**: the editor may be scrolled — a tab that was
 * streamed into has its view state restored at the tail — so the click's landing
 * line is not line 1. `ArrowUp` once per line reaches the top from anywhere,
 * `Home` pins the column, then `Shift+ArrowDown` once per line reaches the bottom
 * and `Shift+End` takes the last line's tail. Overshooting is harmless at both
 * ends: the cursor clamps.
 */
export async function selectAllInEditor(page: Page): Promise<void> {
  await focusEditor(page)
  const lines = ((await editorText(page)) ?? '').split('\n').length

  for (let line = 0; line < lines; line += 1) await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Home')
  for (let line = 0; line < lines; line += 1) await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+End')
}

/** Put the caret in the editor, the way a person does — see `SURFACE`. */
export async function focusEditor(page: Page): Promise<void> {
  await page.locator(SURFACE).click()
}

/**
 * The distinct `mtk*` classes Monaco's tokenizer put on screen.
 *
 * More than one of them **is** syntax colouring: an uncoloured document is every
 * span in the same class, which is what a missing `basic-languages` contribution
 * or a wrong language id produces. AC-31 asserts the count rather than a specific
 * class, because the palette is monaco's business and the colouring is ours.
 */
export async function editorTokenClasses(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const classes = new Set<string>()
    // `Array.from` rather than `for…of`: this tree's `lib` is DOM without
    // DOM.Iterable, and a NodeList is not iterable there.
    for (const span of Array.from(document.querySelectorAll('.view-lines span[class^="mtk"]'))) {
      for (const name of Array.from(span.classList)) {
        if (name.startsWith('mtk')) classes.add(name)
      }
    }
    return Array.from(classes)
  })
}
