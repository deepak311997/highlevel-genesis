import { loader } from '@guolao/vue-monaco-editor'
// `edcore.main`, not `editor.main` and not `editor.api` (D3). `editor.api` alone
// is the bare API with no contributions — no find, no folding, no bracket
// matching, no context menu — and gives a crippled editor. `editor.main` is the
// other extreme: it drags in all ~90 languages *and* the four language-service
// workers. `edcore.main` is the complete editor with every contribution and no
// languages, which is exactly the shape this app wants.
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main'
// Four tokenizers, named one by one, and **no language services** (D3). The
// services are the part we actively do not want: they put red squiggles on
// LLM-generated code, and a reviewer watching the demo reads that as "Genesis
// generates broken code" when it is usually a missing tsconfig or an
// unresolvable relative <script src>. Colouring is what F6.3 asks for;
// diagnostics are not. `editorLanguage.ts` maps exactly these four.
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

import { registerEditorThemes } from './editorTheme'

/**
 * Monaco, bundled locally and handed to the loader (D2, D3, D5, D20).
 *
 * **Nothing imports this statically.** `CodeEditor.vue` reaches it through
 * `await import('@/lib/monacoSetup')`, which is what puts monaco in its own chunk
 * behind the workspace — it is roughly a megabyte gzipped and the sign-in page
 * has no use for it (D20, R6). That dynamic import is also what earns the editor
 * an honest loading state and an honest error state, which the definition of done
 * requires anyway.
 *
 * **One worker, not none** (D5). The standalone editor reaches for its generic
 * worker on its own — word-based suggestions, link detection, anything that diffs
 * a model — and with `MonacoEnvironment` unset it throws a bare *"You must define
 * a function MonacoEnvironment.getWorker"* the first time it does. That is at a
 * keystroke, not at mount, so it survives a smoke test. A few kilobytes removes
 * the whole class of failure; disabling the features by option instead means
 * hoping nothing else ever asks.
 */

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

/**
 * The call that takes the network out of the editor's critical path (D2).
 *
 * The package's default is `@monaco-editor/loader` fetching monaco from jsDelivr
 * over AMD. Verified in the loader's source: `config({ monaco })` stores the
 * instance and `init()` then resolves with it immediately, before it reaches
 * `injectScripts` — so no request is made. Without this, `npm run dev` on the
 * emulators would require the internet from a fresh clone, a third party would
 * sit in the e2e suite's critical path, and Slice 13 would owe a CSP allowlist
 * entry. `no-cdn.spec.ts` is the standing guard that nobody puts it back.
 */
loader.config({ monaco })

/**
 * Instrument's two editor themes, defined on this instance before any editor
 * asks for one by name. `CodeEditor.vue` reaches monaco through this module, so
 * by the time it can render a `<VueMonacoEditor theme="instrument-light">` the
 * definition is already here — an unknown theme name silently falls back to
 * `vs`, which would look like a palette that did not quite take.
 */
registerEditorThemes(monaco)

/**
 * Published on `window` for parity with the loader's own CDN path, which sets it
 * as a matter of course and whose `init()` explicitly looks for it (P3). It is
 * also what lets the e2e read the editor's text **exactly** —
 * `monaco.editor.getEditors()[0].getModel().getValue()` — rather than scraping
 * virtualised `.view-lines`, which is neither exact nor stable.
 */
window.monaco = monaco

export { monaco }
