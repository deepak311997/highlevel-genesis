import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'

/**
 * AC-10 – AC-12 and AC-26 – AC-28 — the one component that touches the editor.
 *
 * **Monaco itself never runs here**. jsdom has no layout, no canvas metrics and no
 * `ResizeObserver` worth the name, so a test that mounted the real editor would prove the mock
 * works and nothing else. What is asserted instead is the *contract*: which props the component
 * passes, which model it writes to, and which method it uses to write — against a stub wrapper
 * and a fake monaco. The real editor is exercised once, at L5.
 */

/* ── the fake monaco, and the module the component dynamically imports ────── */

interface FakeEdit {
  range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }
  text: string
}

interface SetupState {
  /** Flipped to make the dynamic import fail, which is AC-26's middle case. */
  fail: boolean
  monaco: FakeMonaco | null
}

const state = vi.hoisted<SetupState>(() => ({ fail: false, monaco: null }))

vi.mock('@/lib/monacoSetup', () => ({
  /*
   * A getter rather than a value: a failed chunk is what AC-26 is about, and throwing on access
   * is the closest a mocked module can get to the browser rejecting an `import()`.
   */
  get monaco() {
    if (state.fail) throw new Error('Failed to fetch dynamically imported module')
    return state.monaco
  },
}))

/**
 * A model that behaves like a document under `applyEdits`, and records what was done to it.
 *
 * It understands the only two edits this component produces: a zero-width range at the end
 * (append) and the full model range (replace). Modelling them rather than just recording them is
 * what makes a *sequence* of appends meaningful — with a static `getValue`, the second chunk's
 * edit would be computed from the first chunk's document and the test would pass over a broken
 * accumulator.
 */
function fakeModel(value: string) {
  const model = {
    value,
    edits: [] as FakeEdit[],
    disposed: false,
    /**
     * The wrapper's `onDidChangeModelContent` listener, which monaco fires **synchronously**
     * inside `applyEdits`.
     */
    onChange: null as null | (() => void),
    setValue: vi.fn(),
    /**
     * The registry pins every model it hands out to LF, because monaco guesses a new model's
     * line ending from the text it was created with — and a tab's model is created before its
     * bytes arrive.
     */
    setEOL: vi.fn(),
    dispose: vi.fn(() => {
      model.disposed = true
    }),
    isDisposed: () => model.disposed,
    getValue: () => model.value,
    getLineCount: () => model.value.split('\n').length,
    getLineMaxColumn: (line: number) => (model.value.split('\n')[line - 1] ?? '').length + 1,
    getFullModelRange: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: model.getLineCount(),
      endColumn: model.getLineMaxColumn(model.getLineCount()),
    }),
    applyEdits: vi.fn((edits: FakeEdit[]) => {
      for (const edit of edits) {
        model.edits.push(edit)
        const full = model.getFullModelRange()
        const isFull =
          edit.range.startLineNumber === full.startLineNumber &&
          edit.range.startColumn === full.startColumn &&
          edit.range.endLineNumber === full.endLineNumber &&
          edit.range.endColumn === full.endColumn
        model.value = isFull ? edit.text : model.value + edit.text
      }
      model.onChange?.()
    }),
  }
  return model
}

type FakeModel = ReturnType<typeof fakeModel>

function makeMonaco() {
  const models = new Map<string, FakeModel>()
  return {
    models,
    setTheme: vi.fn(),
    Uri: { parse: (raw: string) => ({ toString: () => raw }) },
    editor: {
      setTheme: vi.fn(),
      createModel: (value: string, _language?: string, uri?: { toString: () => string }) => {
        const model = fakeModel(value)
        models.set(uri?.toString() ?? '', model)
        return model
      },
      getModel: (uri: { toString: () => string }) => models.get(uri.toString()) ?? null,
      EndOfLineSequence: { LF: 0 },
    },
  }
}

type FakeMonaco = ReturnType<typeof makeMonaco>

/** The editor instance the stub hands us at `mount` — AC-28's sentinel. */
function fakeEditor(initial: FakeModel | null) {
  let model = initial
  return {
    revealLine: vi.fn(),
    saveViewState: vi.fn(() => ({ scroll: 1 })),
    restoreViewState: vi.fn(),
    setValue: vi.fn(),
    getModel: () => model,
    setModel: vi.fn((next: FakeModel | null) => {
      model = next
    }),
  }
}

/* ── the stub wrapper ─────────────────────────────────────────────────────── */

/**
 * The same props and emits as `VueMonacoEditor`, and no editor.
 *
 * Declaring them rather than using `stubs: { VueMonacoEditor: true }` is what
 * lets the prop assertions below be about *values* — `readOnly`, `theme` — and
 * lets a test emit `mount` the way the real component does.
 */
const VueMonacoEditorStub = defineComponent({
  name: 'VueMonacoEditor',
  props: {
    theme: { type: String, default: 'vs' },
    options: { type: Object, default: () => ({}) },
    width: { type: [Number, String], default: '100%' },
    height: { type: [Number, String], default: '100%' },
    path: { type: String, default: undefined },
    value: { type: String, default: undefined },
    language: { type: String, default: undefined },
  },
  emits: ['update:value', 'mount', 'beforeMount', 'change', 'validate'],
  setup: () => () => h('div', { 'data-testid': 'monaco-stub' }),
})

vi.mock('@guolao/vue-monaco-editor', () => ({ VueMonacoEditor: VueMonacoEditorStub }))

/* ── the store fake ───────────────────────────────────────────────────────── */

/**
 * `editorContent` is a **getter**, not a field, so it derives from
 * `streamingFiles` and the buffer exactly as the real computed does. That is
 * what makes AC-12 a real assertion: pushing a chunk for a path that is not the
 * active tab leaves this unchanged, and therefore must leave the model alone.
 */
interface StoreFake {
  projectId: string | null
  selectedPath: string | null
  generating: boolean
  streamingFiles: Record<string, string>
  /** Stands in for `buffers[path].content`, which is all this component reads. */
  contents: Record<string, string>
  editContent: (text: string) => void
  readonly editorContent: string
}

const store: StoreFake = reactive({
  projectId: 'proj-1',
  selectedPath: null,
  generating: false,
  streamingFiles: {},
  contents: {},
  editContent: vi.fn(),
  /*
   * Through `store` rather than `this`: a getter's `this` is inferred from the literal, not from
   * the annotation, so `this.selectedPath` would be typed `null`.
   */
  get editorContent(): string {
    const path = store.selectedPath
    if (path === null) return ''
    return store.streamingFiles[path] ?? store.contents[path] ?? ''
  },
})

/** The same object, typed so the cases can assert on the spy. */
const editContentSpy = store.editContent as ReturnType<typeof vi.fn>

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

const CodeEditor = (await import('./CodeEditor.vue')).default

beforeEach(() => {
  vi.clearAllMocks()
  state.fail = false
  state.monaco = makeMonaco()
  store.projectId = 'proj-1'
  store.selectedPath = null
  store.generating = false
  store.streamingFiles = {}
  store.contents = {}
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  document.documentElement.classList.remove('dark')
})

/** The fake `beforeEach` installed. Non-null by construction, narrowed not cast. */
function monacoOf(): FakeMonaco {
  const resolved = state.monaco
  expect(resolved).not.toBeNull()
  return resolved!
}

/** Mount, let the dynamic import resolve, and hand the component an editor. */
async function mounted(instance = fakeEditor(fakeModel('anonymous'))) {
  const wrapper = mount(CodeEditor)
  await flushPromises()
  const stub = wrapper.findComponent(VueMonacoEditorStub)
  stub.vm.$emit('mount', instance)
  await flushPromises()
  return { wrapper, stub, instance }
}

/** The model the registry put on the editor — ours, not the wrapper's. */
function activeModel(instance: ReturnType<typeof fakeEditor>): FakeModel {
  const model = instance.getModel()
  expect(model).not.toBeNull()
  return model!
}

describe('CodeEditor', () => {
  /** AC-26, all three states. */
  it('renders the skeleton until the editor mounts', async () => {
    const wrapper = mount(CodeEditor)

    expect(wrapper.find('[data-testid="code-editor-loading"]').exists()).toBe(true)

    await flushPromises()
    // The chunk resolved, but the editor has not reported itself yet.
    expect(wrapper.find('[data-testid="code-editor-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="code-editor-failed"]').exists()).toBe(false)
  })

  /*
   * The three lines of the skeleton are the shared `Skeleton`, not hand-rolled pulsing divs —
   * the testid still resolves to the same element, and what it holds carries the primitive's
   * slot attribute.
   */
  it('renders Skeleton placeholders while loading', () => {
    const wrapper = mount(CodeEditor)

    const loading = wrapper.find('[data-testid="code-editor-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.findAll('[data-slot="skeleton"]')).toHaveLength(3)
  })

  it('renders neither once mounted', async () => {
    const { wrapper } = await mounted()

    expect(wrapper.find('[data-testid="code-editor-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="code-editor-failed"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="monaco-stub"]').exists()).toBe(true)
  })

  /**
   * D20 bought this state along with the chunk split, and the definition of done
   * requires it anyway: a megabyte of editor is exactly the kind of thing that
   * fails to arrive on a bad connection.
   */
  it('renders the failure and a Try again that retries the load', async () => {
    state.fail = true
    const wrapper = mount(CodeEditor)
    await flushPromises()

    const failed = wrapper.find('[data-testid="code-editor-failed"]')
    expect(failed.exists()).toBe(true)
    expect(failed.text()).toContain('editor could not be loaded')
    expect(wrapper.find('[data-testid="code-editor-loading"]').exists()).toBe(false)

    state.fail = false
    await wrapper.find('[data-testid="code-editor-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="code-editor-failed"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="monaco-stub"]').exists()).toBe(true)
  })

  /** AC-28, D6 — **the instance is not made reactive**, asserted rather than commented. */
  it('holds the editor instance identically', async () => {
    const sentinel = fakeEditor(fakeModel(''))
    const { wrapper } = await mounted(sentinel)

    // The registry's `setModel` is called on the very object that was emitted.
    expect(sentinel.setModel).toHaveBeenCalled()
    expect(sentinel.setModel.mock.instances[0] ?? sentinel).toBe(sentinel)
    // And nothing rendered it, so it never became a template ref either.
    expect(wrapper.html()).not.toContain('revealLine')
  })

  /** AC-11, and D18's load-bearing option. */
  it('passes readOnly while generating, with a message, and automaticLayout always', async () => {
    store.generating = true
    const { stub } = await mounted()

    const options = stub.props('options') as Record<string, unknown>
    expect(options['readOnly']).toBe(true)
    expect(options['readOnlyMessage']).toEqual({
      value: 'Read-only while a reply is generating.',
    })
    // Without this the editor never re-measures when the splitter moves, and the
    // text stays clipped at the old width with no error attached.
    expect(options['automaticLayout']).toBe(true)
    expect(options['minimap']).toEqual({ enabled: false })

    store.generating = false
    await flushPromises()

    expect((stub.props('options') as Record<string, unknown>)['readOnly']).toBe(false)
    // Set even when the editor is editable, where it is inert:
    // `exactOptionalPropertyTypes` makes a conditional `undefined` an error.
    expect((stub.props('options') as Record<string, unknown>)['readOnlyMessage']).toEqual({
      value: 'Read-only while a reply is generating.',
    })
  })

  /** A theme change is a prop change, not a remount. */
  it('passes the Instrument themes for dark and light, without remounting', async () => {
    store.selectedPath = 'index.html'
    store.contents = { 'index.html': '<h1>Contacts</h1>' }
    const { stub, instance } = await mounted()

    expect(stub.props('theme')).toBe('instrument-light')
    const before = stub.vm
    const model = activeModel(instance)

    document.documentElement.classList.add('dark')
    await vi.waitFor(() => {
      expect(stub.props('theme')).toBe('instrument-dark')
    })

    // Same component instance, same model, same text: the ground changed and
    // nothing else did.
    expect(stub.vm).toBe(before)
    expect(activeModel(instance)).toBe(model)
    expect(model.getValue()).toBe('<h1>Contacts</h1>')

    document.documentElement.classList.remove('dark')
    await vi.waitFor(() => {
      expect(stub.props('theme')).toBe('instrument-light')
    })
  })

  /**
   * AC-10, D8, P4 — **the slice's one real hazard**, at the level where the component's part of
   * it can be seen.
   */
  it('appends the tail of a streamed chunk, follows it, and never calls setValue', async () => {
    store.selectedPath = 'index.html'
    store.streamingFiles = { 'index.html': '' }
    store.generating = true
    const { instance } = await mounted()
    const model = activeModel(instance)

    store.streamingFiles = { 'index.html': '<!doctype html>\n' }
    await flushPromises()
    store.streamingFiles = { 'index.html': '<!doctype html>\n<title>Contacts</title>\n' }
    await flushPromises()

    // Two edits, each carrying only what arrived — not the document.
    expect(model.edits.map((edit) => edit.text)).toEqual([
      '<!doctype html>\n',
      '<title>Contacts</title>\n',
    ])
    // Zero-width, at the end of the document as it stood.
    expect(model.edits[1]?.range).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
    })
    expect(model.getValue()).toBe('<!doctype html>\n<title>Contacts</title>\n')

    // The view follows the tail, which is what "tokens appear live" looks like.
    expect(instance.revealLine).toHaveBeenLastCalledWith(model.getLineCount())

    // The negative that matters — nowhere, ever.
    expect(model.setValue).not.toHaveBeenCalled()
    expect(instance.setValue).not.toHaveBeenCalled()
  })

  /* A server repair that changed earlier bytes is a replace over the whole
   * range — still `applyEdits`, still never `setValue` (P4). */
  it('replaces over the full range when the content is not an extension', async () => {
    store.selectedPath = 'index.html'
    store.contents = { 'index.html': '<h1>Contacts</h1>' }
    const { instance } = await mounted()
    const model = activeModel(instance)

    store.contents = { 'index.html': '<!doctype html>\n<h1>Contacts</h1>' }
    await flushPromises()

    expect(model.edits).toHaveLength(1)
    expect(model.edits[0]?.text).toBe('<!doctype html>\n<h1>Contacts</h1>')
    expect(model.edits[0]?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 18,
    })
    expect(model.setValue).not.toHaveBeenCalled()
  })

  /** AC-12. The stream writes another path; the open document does not move. */
  it('leaves the active model alone when the stream writes another path', async () => {
    store.selectedPath = 'index.html'
    store.contents = { 'index.html': '<h1>Contacts</h1>' }
    store.generating = true
    const { instance } = await mounted()
    const model = activeModel(instance)

    store.streamingFiles = { 'styles.css': 'body { margin: 0 }' }
    await flushPromises()

    expect(model.edits).toEqual([])
    expect(model.getValue()).toBe('<h1>Contacts</h1>')
    expect(instance.revealLine).not.toHaveBeenCalled()
  })

  /**
   * The round trip terminates by itself, which is why `applying` can be a plain boolean rather
   * than a queue: our own write makes `editorContent` equal to the model, so the next
   * `editorEdit` returns `null`.
   */
  it('does not write a streamed append back into the store', async () => {
    store.selectedPath = 'index.html'
    store.streamingFiles = { 'index.html': '' }
    const { stub, instance } = await mounted()
    const model = activeModel(instance)
    // The wrapper's listener, wired where monaco really wires it: fired
    // synchronously from inside `applyEdits`, while `applying` is still up.
    model.onChange = () => {
      stub.vm.$emit('update:value', model.getValue())
    }

    store.streamingFiles = { 'index.html': 'body{}' }
    await flushPromises()

    expect(model.getValue()).toBe('body{}')
    expect(editContentSpy).not.toHaveBeenCalled()
  })

  /** A keystroke, on the other hand, is exactly what the store wants. */
  it('writes a typed change into the active buffer', async () => {
    store.selectedPath = 'index.html'
    store.contents = { 'index.html': '<h1>Contacts</h1>' }
    const { stub } = await mounted()

    stub.vm.$emit('update:value', '<h1>People</h1>')
    await flushPromises()

    expect(editContentSpy).toHaveBeenCalledWith('<h1>People</h1>')
  })

  /**
   * D7/R5, at the component's boundary: the URI carries the project id, so two
   * projects cannot share one model and one undo stack.
   */
  it('creates project-scoped models and disposes the wrapper’s anonymous one', async () => {
    store.selectedPath = 'index.html'
    store.contents = { 'index.html': '<h1>Contacts</h1>' }
    const anonymous = fakeModel('')
    const { instance } = await mounted(fakeEditor(anonymous))

    expect([...monacoOf().models.keys()]).toEqual(['inmemory://genesis/proj-1/index.html'])
    expect(activeModel(instance)).not.toBe(anonymous)
    // The wrapper creates one because `path` is unbound; left alive it would leak
    // a model per mount.
    expect(anonymous.dispose).toHaveBeenCalled()
  })

  /** AC-9's component half: leaving a project disposes what it created. */
  it('disposes the registry when the project changes, and rebuilds it', async () => {
    store.selectedPath = 'index.html'
    store.contents = { 'index.html': '<h1>A</h1>' }
    const { instance } = await mounted()
    const first = activeModel(instance)

    store.projectId = 'proj-2'
    store.contents = { 'index.html': '<h1>B</h1>' }
    await flushPromises()

    expect(first.dispose).toHaveBeenCalled()
    expect(activeModel(instance)).not.toBe(first)
    expect([...monacoOf().models.keys()]).toContain('inmemory://genesis/proj-2/index.html')
  })

  /**
   * The wrapper's own `onUnmounted` disposes `editorRef.value.getModel()`, and the `lg`
   * breakpoint unmounts this component on a window resize — so the detach has to happen first,
   * or the registry hands out a disposed model afterwards.
   */
  it('detaches the editor before unmounting', async () => {
    store.selectedPath = 'index.html'
    store.contents = { 'index.html': '<h1>A</h1>' }
    const { wrapper, instance } = await mounted()
    instance.setModel.mockClear()

    wrapper.unmount()

    expect(instance.setModel).toHaveBeenCalledWith(null)
  })

  /* No tab open is an editor with no document, not an editor showing the last
   * one — `FileEditor` renders the empty state over it. */
  it('clears the model when the last tab closes', async () => {
    store.selectedPath = 'index.html'
    store.contents = { 'index.html': '<h1>A</h1>' }
    const { instance } = await mounted()
    instance.setModel.mockClear()

    store.selectedPath = null
    await flushPromises()

    expect(instance.setModel).toHaveBeenCalledWith(null)
  })
})
