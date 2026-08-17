// Type-only, and that matters: `verbatimModuleSyntax` erases this at build time.
// A bare `import … from 'monaco-editor'` as a *value* would pull all ~90
// languages into whatever chunk imports it, because the package's `module` field
// is `editor.main.js`. `monacoSetup.ts` is the only module here that imports
// monaco for its value, and it names `edcore.main` explicitly.
import type { editor, Uri } from 'monaco-editor'

/**
 * Who owns the text models — **we do, not the wrapper** (D7, R5).
 *
 * Read out of `@guolao/vue-monaco-editor`'s source rather than assumed: bind its
 * `path` prop and it keys models by `monaco.Uri.parse(path)` in monaco's
 * **global** registry, and at unmount it disposes only whichever model happened
 * to be active. So `path="index.html"` in two different projects is *one* model:
 * open project B and it shows project A's code, with A's undo history. That is a
 * data-confusion bug with no error attached to it, which is why the URIs here
 * carry the project id and why this module disposes its own models.
 *
 * The wrapper still owns everything we actually want from it — the loader, editor
 * construction, the container, the sizing, and the theme prop. Its `path` and
 * `value` props are simply left unbound, which also removes a load-bearing
 * dependency on whether the parent's watcher or the child's fires first in a
 * flush.
 */

/** The scheme is monaco's own convention for a model with no file behind it. */
const SCHEME = 'inmemory://genesis'

/** What the registry needs of monaco. All fakeable, which is how AC-6–AC-9 run. */
export interface MonacoModelApi {
  Uri: { parse: (raw: string) => Uri }
  editor: {
    createModel: (value: string, language?: string, uri?: Uri) => editor.ITextModel
    getModel: (uri: Uri) => editor.ITextModel | null
    /** Only `LF` is named, because only `LF` is ever used — see `model`. */
    EndOfLineSequence: { LF: editor.EndOfLineSequence }
  }
}

/**
 * What the registry needs of the editor.
 *
 * `IStandaloneCodeEditor` satisfies it structurally. Named as three methods
 * rather than taken as the editor type so the L1 can hand it a recorder — and so
 * this module cannot quietly start reaching for something else on the instance.
 */
export interface EditorHost {
  setModel: (model: editor.ITextModel | null) => void
  saveViewState: () => editor.ICodeEditorViewState | null
  restoreViewState: (state: editor.ICodeEditorViewState | null) => void
}

export interface ModelRegistry {
  /** The model for a path, created on first use and reused thereafter. */
  model: (path: string, value: string, language: string) => editor.ITextModel
  /** Switch the editor to a path, carrying the view states across. */
  activate: (host: EditorHost, path: string, value: string, language: string) => void
  /** Detach the editor, then dispose everything this registry created. */
  disposeAll: (host: EditorHost | null) => void
  /** The paths this registry currently holds models for. */
  paths: () => string[]
}

/** `inmemory://genesis/<projectId>/<path>` — the project is what makes it unique. */
export function modelUriString(projectId: string, path: string): string {
  return `${SCHEME}/${projectId}/${path}`
}

export function createModelRegistry(monaco: MonacoModelApi, projectId: string): ModelRegistry {
  const models = new Map<string, editor.ITextModel>()
  const viewStates = new Map<string, editor.ICodeEditorViewState | null>()

  /**
   * The path currently on screen, in the closure.
   *
   * This is what lets a view state be filed under the path it belonged to rather
   * than the one being switched to — the editor can only report the viewport it
   * has *now*, so the registry has to remember whose it was.
   */
  let activePath: string | null = null

  function model(path: string, value: string, language: string): editor.ITextModel {
    const existing = models.get(path)
    if (existing !== undefined && !existing.isDisposed()) return existing

    /*
     * monaco's registry is global and outlives this one — a component the `lg`
     * breakpoint remounts builds a fresh registry over models that are still
     * there — and `createModel` throws ERR_MODEL_ALREADY_EXISTS on a duplicate
     * URI. So an existing model is adopted rather than recreated.
     */
    const uri = monaco.Uri.parse(modelUriString(projectId, path))
    const adopted = monaco.editor.getModel(uri)
    const created = adopted ?? monaco.editor.createModel(value, language, uri)

    /*
     * **LF, stated rather than inherited.**
     *
     * Monaco guesses a new model's line ending from the text it is created with
     * and falls back to the platform default when there is none — and a tab is
     * activated, so its model is created, *before* the file's bytes arrive. Left
     * alone, that empty model can come out CRLF, and every `\n` written into it
     * afterwards becomes `\r\n`: the first keystroke marks the whole document
     * dirty and **Save** stores a file in which every line changed. Monaco skips
     * the call when the model already agrees, so this is free on the common path.
     */
    created.setEOL(monaco.editor.EndOfLineSequence.LF)
    models.set(path, created)
    return created
  }

  function activate(host: EditorHost, path: string, value: string, language: string): void {
    if (activePath === path) return

    // Saved *before* the model changes: afterwards the editor is reporting the
    // new document's viewport, which would be filed under the old path.
    if (activePath !== null) viewStates.set(activePath, host.saveViewState())

    host.setModel(model(path, value, language))
    activePath = path

    // Only for a path that has been open before. Restoring a state we never
    // saved would hand monaco `null` and reset a viewport it had just set.
    if (viewStates.has(path)) host.restoreViewState(viewStates.get(path) ?? null)
  }

  function disposeAll(host: EditorHost | null): void {
    /*
     * The editor is detached **first**, and this is load-bearing rather than
     * tidy. The wrapper's own `onUnmounted` disposes `editorRef.value.getModel()`
     * — so an editor left pointing at a model we have already disposed hands a
     * disposed model straight back out.
     */
    host?.setModel(null)
    for (const held of models.values()) {
      if (!held.isDisposed()) held.dispose()
    }
    models.clear()
    viewStates.clear()
    activePath = null
  }

  return { model, activate, disposeAll, paths: () => [...models.keys()] }
}
