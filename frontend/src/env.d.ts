/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_EMULATOR_PORT: string
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  readonly VITE_FIREBASE_APP_ID?: string
  readonly VITE_FUNCTIONS_BASE_URL?: string
  /**
   * The `generate` function's own URL, which takes the streaming turn off the
   * Hosting rewrite — see `lib/api.ts` for why it has to. Blank keeps it
   * same-origin.
   */
  readonly VITE_GENERATE_URL?: string
  /**
   * reCAPTCHA v3 **site** key for App Check. Public by design — it ships in the
   * bundle. The matching secret key must never appear in this file; anything
   * prefixed VITE_ is compiled into assets any visitor can read.
   */
  readonly VITE_GOOGLE_RECAPTCHA_V3_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

/**
 * `edcore.main` is the editor with every contribution and **no languages** (D3):
 * find, folding, bracket matching, the context menu, and none of the ~90
 * tokenizers `editor.main` would drag in. monaco ships no `.d.ts` for it — only
 * for `editor.api`, which `edcore.main.js` re-exports wholesale — so this is the
 * declaration that makes the value import typecheck.
 */
declare module 'monaco-editor/esm/vs/editor/edcore.main' {
  export * from 'monaco-editor/esm/vs/editor/editor.api'
}

interface Window {
  /**
   * The locally bundled monaco, published on `window` by `lib/monacoSetup.ts`.
   *
   * **Parity, not a test hook.** `@monaco-editor/loader`'s CDN path sets this as a
   * matter of course and its `init()` explicitly looks for it — the local path was
   * the odd one out. It is also what lets the e2e read the editor's text exactly,
   * through `monaco.editor.getEditors()[0].getModel().getValue()`, rather than
   * scraping virtualised `.view-lines` (P3).
   */
  monaco?: typeof import('monaco-editor/esm/vs/editor/edcore.main')
}
