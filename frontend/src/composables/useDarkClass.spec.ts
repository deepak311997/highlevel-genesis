import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { useDarkClass } from './useDarkClass'

/**
 * P2 — reading the resolved theme, rather than resolving it a second time.
 *
 * `useTheme()` builds fresh state per call, deliberately (its own spec depends on that), so a
 * second call inside `CodeEditor` would hold a different `preference` ref and never hear
 * `ThemeToggle`'s change — no storage event fires in the tab that wrote it. The `dark` class is
 * already the single source of truth: both `applyTheme()` and the pre-paint script in
 * `index.html` write it. So this reads the answer instead of recomputing it.
 */

afterEach(() => {
  document.documentElement.classList.remove('dark')
})

describe('useDarkClass', () => {
  it('reports the class as it is, and follows it when it changes', async () => {
    const scope = effectScope()
    const dark = scope.run(() => useDarkClass())!

    expect(dark.value).toBe(false)

    document.documentElement.classList.add('dark')
    await vi.waitFor(() => {
      expect(dark.value).toBe(true)
    })

    document.documentElement.classList.remove('dark')
    await vi.waitFor(() => {
      expect(dark.value).toBe(false)
    })

    scope.stop()
  })

  /* Seeded from the document, so an editor mounted into an already-dark page
   * does not render light for one frame and then snap. */
  it('starts true when the class is already set', () => {
    document.documentElement.classList.add('dark')
    const scope = effectScope()

    const dark = scope.run(() => useDarkClass())!

    expect(dark.value).toBe(true)
    scope.stop()
  })

  /* `useTheme.ts`'s own cleanup pattern: the observer goes when the scope does,
   * or every mounted-and-unmounted editor leaves one watching the document. */
  it('stops observing when its scope is disposed', async () => {
    const scope = effectScope()
    const dark = scope.run(() => useDarkClass())!

    scope.stop()
    document.documentElement.classList.add('dark')
    // A microtask queue turn is all a live MutationObserver would need.
    await Promise.resolve()
    await Promise.resolve()

    expect(dark.value).toBe(false)
  })
})
