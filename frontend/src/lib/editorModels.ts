// Type-only, and that matters: `verbatimModuleSyntax` erases this at build time. A
// bare value import would pull all ~90 languages into whatever chunk imports it,
// because the package's `module` field is `editor.main.js`.
import type { editor, Uri } from 'monaco-editor'

/**
 * Who owns the text models — **we do, not the wrapper**.
 *
 * Bind its `path` prop and the wrapper keys models by URI in monaco's **global**
 * registry, disposing only whichever happened to be active at unmount. So
 * `path="index.html"` in two different projects is *one* model: open project B and
 * it shows project A's code, with A's undo history — a data-confusion bug with no
 * error attached. Hence the project id in every URI, and this module disposing its
 * own models.
 *
 * The wrapper still owns what we want from it: the loader, editor construction, the
 * container, the sizing and the theme.
 */

/** The scheme is monaco's own convention for a model with no file behind it. */
const SCHEME = 'inmemory://genesis'

/** What the registry needs of monaco — all fakeable, which is how the L1 runs. */
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
 * What the registry needs of the editor. `IStandaloneCodeEditor` satisfies it
 * structurally; named as three methods so the L1 can hand it a recorder, and so
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
   * The path currently on screen, in the closure — what lets a view state be filed
   * under the path it belonged to rather than the one being switched to.
   */
  let activePath: string | null = null

  function model(path: string, value: string, language: string): editor.ITextModel {
    const existing = models.get(path)
    if (existing !== undefined && !existing.isDisposed()) return existing

    /*
     * monaco's registry is global and outlives this one — a component the `lg`
     * breakpoint remounts builds a fresh registry over models that are still there
     * — and `createModel` throws on a duplicate URI, so an existing model is adopted.
     */
    const uri = monaco.Uri.parse(modelUriString(projectId, path))
    const adopted = monaco.editor.getModel(uri)
    const created = adopted ?? monaco.editor.createModel(value, language, uri)

    /*
     * **LF, stated rather than inherited.** Monaco guesses a new model's line ending
     * from the text it is created with and falls back to the platform default when
     * there is none — and a tab is activated before its bytes arrive. Left alone that
     * empty model can come out CRLF, and every `\n` written into it afterwards
     * becomes `\r\n`: the first keystroke marks the whole document dirty.
     */
    created.setEOL(monaco.editor.EndOfLineSequence.LF)
    models.set(path, created)
    return created
  }

  function activate(host: EditorHost, path: string, value: string, language: string): void {
    if (activePath === path) return

    // Saved *before* the model changes: afterwards the editor is reporting the new
    // document's viewport, which would be filed under the old path.
    if (activePath !== null) viewStates.set(activePath, host.saveViewState())

    host.setModel(model(path, value, language))
    activePath = path

    // Only for a path that has been open before. Restoring a state we never saved
    // would hand monaco `null` and reset a viewport it had just set.
    if (viewStates.has(path)) host.restoreViewState(viewStates.get(path) ?? null)
  }

  function disposeAll(host: EditorHost | null): void {
    /*
     * The editor is detached **first**, and this is load-bearing: the wrapper's own
     * `onUnmounted` disposes the editor's current model, so one left pointing at a
     * model we have already disposed hands a disposed model straight back out.
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
