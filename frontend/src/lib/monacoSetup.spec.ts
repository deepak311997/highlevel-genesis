import { describe, expect, it, vi } from 'vitest'

/**
 * AC-25's first half — **the loader is handed our own instance**.
 *
 * `@monaco-editor/loader`'s `config({ monaco })` short-circuits `init()` to the passed instance
 * before it reaches `injectScripts`, which is what makes the whole editor work with no network.
 * Verified in its source, and asserted here so a later edit that drops the call fails a test
 * rather than quietly reintroducing a CDN fetch that only shows up on a machine with the network
 * unplugged.
 */

/* `defineTheme` is part of the stub because this module now registers
   Instrument's two editor themes on the instance it hands the loader. */
const defineTheme = vi.fn<(name: string, data: unknown) => void>()
vi.mock('monaco-editor/esm/vs/editor/edcore.main', () => ({
  editor: {
    getEditors: () => [],
    defineTheme: (name: string, data: unknown) => {
      defineTheme(name, data)
    },
  },
}))
vi.mock('monaco-editor/esm/vs/basic-languages/html/html.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/css/css.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution', () => ({}))

/**
 * The `?worker` specifier mocks cleanly, so the plan's fallback was not needed:
 * `getWorker` is asserted to **return** a worker rather than merely to exist.
 */
class FakeWorker {
  readonly kind = 'monaco-editor-worker'
}
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: FakeWorker }))

const config = vi.hoisted(() => vi.fn())
vi.mock('@guolao/vue-monaco-editor', () => ({ loader: { config } }))

const { monaco } = await import('./monacoSetup')

describe('monacoSetup', () => {
  /** The call that removes the network from the editor's critical path. */
  it('hands the loader the locally imported instance', () => {
    expect(config).toHaveBeenCalledTimes(1)

    /*
     * Identity, not shape: `config({ monaco })` carrying some *other* monaco would satisfy a
     * structural check and leave the loader fetching anyway.
     */
    const passed = config.mock.calls[0]?.[0] as { monaco: unknown } | undefined
    expect(Object.is(passed?.monaco, monaco)).toBe(true)
  })

  /**
   * D3, at runtime. The mock above stands in for `edcore.main` **alone**, so a
   * module that imported `editor.api` or `editor.main` instead would load the
   * real thing and export far more than this one key.
   */
  /* Registration has to happen on *this* instance and before any editor names a theme. */
  it('defines both Instrument editor themes on the instance it hands over', async () => {
    await import('./monacoSetup')
    const { INSTRUMENT_DARK, INSTRUMENT_LIGHT, THEME_DARK, THEME_LIGHT } =
      await import('./editorTheme')

    expect(defineTheme).toHaveBeenCalledWith(THEME_LIGHT, INSTRUMENT_LIGHT)
    expect(defineTheme).toHaveBeenCalledWith(THEME_DARK, INSTRUMENT_DARK)
  })

  it('imports edcore.main rather than another entry point', () => {
    expect(Object.keys(monaco)).toEqual(['editor'])
  })

  /**
   * The standalone editor reaches for its generic worker on its own — word suggestions, link
   * detection, anything that diffs a model — and with `MonacoEnvironment` unset it throws a bare
   * "You must define a function MonacoEnvironment.getWorker" at the **first keystroke**, not at
   * mount.
   */
  it('wires one generic worker through MonacoEnvironment', () => {
    /*
     * Called rather than referenced. `getWorker` is optional on monaco's `Environment`, so both
     * links are optional-chained — and a *reference* to it would trip `unbound-method`, which is
     * the rule's whole point: what this asserts is that calling it produces a worker, which is
     * what monaco does.
     */
    expect(self.MonacoEnvironment?.getWorker?.('', '')).toBeInstanceOf(FakeWorker)
  })

  /** P3 — parity with the loader's CDN path, which sets this as a matter of course. */
  it('publishes the instance on window for the loader and the e2e', () => {
    expect(Object.is(window.monaco, monaco)).toBe(true)
  })
})
