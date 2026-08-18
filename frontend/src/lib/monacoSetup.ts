import { loader } from '@guolao/vue-monaco-editor'
// `edcore.main`, not `editor.main` and not `editor.api`. `editor.api` alone is the
// bare API with no contributions — no find, no folding, no bracket matching — and
// `editor.main` drags in all ~90 languages *and* four language-service workers.
// `edcore.main` is the complete editor with every contribution and no languages.
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main'
// Four tokenizers, named one by one, and **no language services**: the services put
// red squiggles on LLM-generated code, which a reviewer watching the demo reads as
// "Genesis generates broken code". Colouring is what is wanted; diagnostics are not.
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

import { registerEditorThemes } from './editorTheme'

/**
 * Monaco, bundled locally and handed to the loader.
 *
 * **Nothing imports this statically.** `CodeEditor.vue` reaches it through
 * `await import(...)`, which puts monaco in its own chunk behind the workspace —
 * roughly a megabyte gzipped, and the sign-in page has no use for it. That dynamic
 * import is also what earns the editor an honest loading and error state.
 *
 * **One worker, not none.** The standalone editor reaches for its generic worker on
 * its own, and with `MonacoEnvironment` unset it throws the first time it does — at
 * a keystroke rather than at mount, so it survives a smoke test.
 */

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

/**
 * The call that takes the network out of the editor's critical path.
 *
 * The package's default is a loader fetching monaco from a CDN over AMD;
 * `config({ monaco })` stores the instance so `init()` resolves immediately and no
 * request is made. Without it, a fresh clone would need the internet to run the
 * emulators and a third party would sit in the e2e suite's critical path.
 * `no-cdn.spec.ts` is the standing guard that nobody puts it back.
 */
loader.config({ monaco })

/**
 * Instrument's two editor themes, defined before any editor asks for one by name:
 * an unknown theme name silently falls back to `vs`, which would look like a
 * palette that did not quite take.
 */
registerEditorThemes(monaco)

/**
 * Published on `window` for parity with the loader's own CDN path, which sets it as
 * a matter of course. It is also what lets the e2e read the editor's text exactly,
 * rather than scraping virtualised `.view-lines`.
 */
window.monaco = monaco

export { monaco }
