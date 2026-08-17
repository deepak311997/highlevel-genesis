import type { editor, Uri } from 'monaco-editor'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createModelRegistry,
  modelUriString,
  type EditorHost,
  type MonacoModelApi,
} from './editorModels'

/**
 * AC-6 – AC-9, D7, R5 — the model registry, against a hand-written fake monaco.
 *
 * Monaco itself never runs below L5 (D23): jsdom has no layout, no canvas metrics
 * and no `ResizeObserver` worth the name, so a test that mounted the real editor
 * would prove the mock works. Everything that *decides* which model the editor
 * shows is here instead, where it can be proven cheaply and repeatedly.
 *
 * The bug this module exists to close has no error attached to it. The wrapper's
 * own model management keys models by `monaco.Uri.parse(path)` in monaco's
 * **global** registry, so binding `path="index.html"` makes two different
 * projects share one model — open project B and it shows project A's code, with
 * A's undo history. AC-6 is that, asserted.
 */

/**
 * A model that records what was done to it, and nothing else.
 *
 * `dispose()` also unregisters it, because that is what monaco's own does — the
 * standalone model service drops a disposed model, so `getModel(uri)` answers
 * `null` afterwards. A fake that kept it would let this suite pass over an
 * implementation that hands out disposed models.
 */
function fakeModel(
  uri: Uri,
  value: string,
  language: string,
  unregister: () => void,
): editor.ITextModel {
  let disposed = false
  return {
    uri,
    value,
    language,
    dispose: vi.fn(() => {
      disposed = true
      unregister()
    }),
    isDisposed: () => disposed,
  } as unknown as editor.ITextModel
}

/**
 * `Uri.parse` returning something that stringifies back to what it was given.
 *
 * That is all the registry asks of a `Uri`, and the identity is what lets the
 * fake's model map be keyed the way monaco's real global registry is.
 */
function fakeMonaco(): MonacoModelApi & { created: string[] } {
  const models = new Map<string, editor.ITextModel>()
  const created: string[] = []

  return {
    created,
    Uri: {
      parse: (raw: string) => ({ toString: () => raw }) as unknown as Uri,
    },
    editor: {
      createModel: (value: string, language?: string, uri?: Uri) => {
        const key = uri?.toString() ?? ''
        if (models.has(key)) throw new Error(`ERR_MODEL_ALREADY_EXISTS: ${key}`)
        created.push(key)
        // `uri` is optional on monaco's signature and always supplied by the
        // registry — asserted rather than defaulted, so a call without one is a
        // failure here rather than a model filed under the empty string.
        const model = fakeModel(uri!, value, language ?? 'plaintext', () => {
          models.delete(key)
        })
        models.set(key, model)
        return model
      },
      getModel: (uri: Uri) => models.get(uri.toString()) ?? null,
    },
  }
}

interface FakeHost extends EditorHost {
  calls: string[]
  model: editor.ITextModel | null
  restored: (editor.ICodeEditorViewState | null)[]
}

/** The editor, reduced to the three calls a switch is made of, in order. */
function fakeHost(): FakeHost {
  const host = {
    calls: [] as string[],
    model: null as editor.ITextModel | null,
    restored: [] as (editor.ICodeEditorViewState | null)[],
    setModel: (model: editor.ITextModel | null) => {
      host.calls.push(model === null ? 'setModel(null)' : 'setModel')
      host.model = model
    },
    saveViewState: () => {
      host.calls.push('saveViewState')
      // A distinct object per call, so "whose state was restored" is answerable.
      return { forModel: host.model } as unknown as editor.ICodeEditorViewState
    },
    restoreViewState: (state: editor.ICodeEditorViewState | null) => {
      host.calls.push('restoreViewState')
      host.restored.push(state)
    },
  }
  return host
}

let monaco: ReturnType<typeof fakeMonaco>

beforeEach(() => {
  monaco = fakeMonaco()
})

describe('modelUriString', () => {
  /** AC-6's first half: the URI carries the project, so two cannot collide. */
  it('scopes the URI to the project', () => {
    expect(modelUriString('proj-1', 'index.html')).toBe('inmemory://genesis/proj-1/index.html')
    expect(modelUriString('proj-2', 'index.html')).toBe('inmemory://genesis/proj-2/index.html')
  })
})

describe('createModelRegistry', () => {
  /**
   * AC-6, R5. Two projects, one filename, two models — the bug with no error
   * attached, asserted rather than commented.
   */
  it('gives two projects distinct models for the same filename', () => {
    const one = createModelRegistry(monaco, 'proj-1')
    const two = createModelRegistry(monaco, 'proj-2')

    const a = one.model('index.html', '<h1>A</h1>', 'html')
    const b = two.model('index.html', '<h1>B</h1>', 'html')

    expect(a).not.toBe(b)
    expect(monaco.created).toEqual([
      'inmemory://genesis/proj-1/index.html',
      'inmemory://genesis/proj-2/index.html',
    ])
  })

  /** AC-7. Reused, not recreated — a second model would be a second undo stack. */
  it('returns the same model for a path it already has', () => {
    const registry = createModelRegistry(monaco, 'proj-1')

    const first = registry.model('index.html', '<h1>A</h1>', 'html')
    const second = registry.model('index.html', 'ignored', 'html')

    expect(second).toBe(first)
    expect(monaco.created).toHaveLength(1)
  })

  /*
   * `createModel` throws ERR_MODEL_ALREADY_EXISTS on a duplicate URI, and
   * monaco's registry is global and outlives this one — a component remounted by
   * the `lg` breakpoint builds a fresh registry over models that are still there.
   * So the adoption path is a case, not an implementation detail.
   */
  it('adopts a model monaco already holds rather than throwing', () => {
    const first = createModelRegistry(monaco, 'proj-1')
    const adopted = first.model('index.html', '<h1>A</h1>', 'html')

    const second = createModelRegistry(monaco, 'proj-1')

    expect(second.model('index.html', 'ignored', 'html')).toBe(adopted)
    expect(monaco.created).toHaveLength(1)
  })

  /** AC-8. Saved before the switch, restored after it, filed under the right key. */
  it('saves A’s view state before the switch and restores B’s after it', () => {
    const registry = createModelRegistry(monaco, 'proj-1')
    const host = fakeHost()

    registry.activate(host, 'index.html', '<h1>A</h1>', 'html')
    // Nothing was open, so there was no state to save and none to restore.
    expect(host.calls).toEqual(['setModel'])

    host.calls.length = 0
    registry.activate(host, 'styles.css', 'body{}', 'css')

    // The order is the assertion: saving after the model changed would file the
    // new model's viewport under the old path.
    expect(host.calls).toEqual(['saveViewState', 'setModel'])

    host.calls.length = 0
    registry.activate(host, 'index.html', '<h1>A</h1>', 'html')

    expect(host.calls).toEqual(['saveViewState', 'setModel', 'restoreViewState'])
    // And what came back is index.html's own, not styles.css's.
    expect(host.restored.at(-1)).toEqual({ forModel: expect.anything() })
  })

  /** AC-8's negative: a path never opened has no state, so none is restored. */
  it('attempts no restore for a path that was never open', () => {
    const registry = createModelRegistry(monaco, 'proj-1')
    const host = fakeHost()

    registry.activate(host, 'index.html', '<h1>A</h1>', 'html')
    host.calls.length = 0
    registry.activate(host, 'app.js', 'const a = 1', 'javascript')

    expect(host.calls).not.toContain('restoreViewState')
  })

  /* Re-activating the path that is already active is not a switch. */
  it('does nothing when the active path is activated again', () => {
    const registry = createModelRegistry(monaco, 'proj-1')
    const host = fakeHost()

    registry.activate(host, 'index.html', '<h1>A</h1>', 'html')
    host.calls.length = 0
    registry.activate(host, 'index.html', '<h1>A</h1>', 'html')

    expect(host.calls).toEqual([])
  })

  /**
   * AC-9. The editor's model is detached **first**, then the models go.
   *
   * That order is load-bearing rather than tidy: the wrapper's own `onUnmounted`
   * disposes `editorRef.value.getModel()`, and the `lg` breakpoint unmounts this
   * component on a window resize — so an editor left pointing at a model we have
   * disposed is a disposed model handed straight back out.
   */
  it('detaches the editor, disposes everything it made, and empties itself', () => {
    const registry = createModelRegistry(monaco, 'proj-1')
    const host = fakeHost()
    registry.activate(host, 'index.html', '<h1>A</h1>', 'html')
    registry.activate(host, 'styles.css', 'body{}', 'css')
    const first = registry.model('index.html', '', 'html')
    const second = registry.model('styles.css', '', 'css')
    host.calls.length = 0

    registry.disposeAll(host)

    expect(host.calls[0]).toBe('setModel(null)')
    expect(first.isDisposed()).toBe(true)
    expect(second.isDisposed()).toBe(true)
    expect(registry.paths()).toEqual([])
  })

  /** AC-9's second half: a later open is a fresh model, not a disposed one. */
  it('creates fresh models after a disposal', () => {
    const registry = createModelRegistry(monaco, 'proj-1')
    const host = fakeHost()
    const before = registry.model('index.html', '<h1>A</h1>', 'html')
    registry.disposeAll(host)

    const after = registry.model('index.html', '<h1>A</h1>', 'html')

    expect(after).not.toBe(before)
    expect(after.isDisposed()).toBe(false)
    expect(registry.paths()).toEqual(['index.html'])
  })

  /* Unmounting with no editor left to detach is a disposal, not a crash. */
  it('disposes with a null host', () => {
    const registry = createModelRegistry(monaco, 'proj-1')
    const model = registry.model('index.html', '<h1>A</h1>', 'html')

    registry.disposeAll(null)

    expect(model.isDisposed()).toBe(true)
    expect(registry.paths()).toEqual([])
  })

  /* And a disposal forgets the active path, so the next activate is not a
   * switch away from a model that no longer exists. */
  it('forgets the active path, so the next activate saves no state', () => {
    const registry = createModelRegistry(monaco, 'proj-1')
    const host = fakeHost()
    registry.activate(host, 'index.html', '<h1>A</h1>', 'html')
    registry.disposeAll(host)
    host.calls.length = 0

    registry.activate(host, 'index.html', '<h1>A</h1>', 'html')

    expect(host.calls).toEqual(['setModel'])
  })
})
