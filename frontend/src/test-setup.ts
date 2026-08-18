import { vi } from 'vitest'

/**
 * The jsdom gaps the suite has to fill, in one place.
 *
 * **`scrollIntoView` does not exist in jsdom**, because jsdom computes no
 * layout: there is no viewport to scroll and no box to scroll into it. Every
 * component that keeps something on screen — the tab strip, when a file is
 * opened from the tree — therefore calls a method that is missing rather than
 * inert, and the call rejects inside a watcher where nothing catches it.
 *
 * Stubbed here rather than guarded in the components. A `typeof x === 'function'`
 * check in production code would be a runtime test of a method every browser has
 * had for a decade, written to satisfy a test environment — which is the
 * environment adapting the product instead of the other way round, and which
 * type-aware lint rejects anyway as a condition that cannot be false.
 */
Element.prototype.scrollIntoView = vi.fn()
