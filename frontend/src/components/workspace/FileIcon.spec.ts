import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import FileIcon from './FileIcon.vue'

/**
 * One glyph per kind, decided once.
 *
 * The tree and the tab strip both name files, and before this they named them in two different
 * ways. A shared component is what keeps a `.css` row and a `.css` tab looking like the same
 * file — and what makes "which icon is a script?" a question with one answer rather than one per
 * surface.
 */

const iconFor = (path: string): string[] =>
  mount(FileIcon, { props: { path } }).find('svg').classes()

describe('FileIcon', () => {
  it('draws a different glyph for each kind', () => {
    expect(iconFor('index.html')).toContain('lucide-code-xml')
    expect(iconFor('styles.css')).toContain('lucide-palette')
    expect(iconFor('app.js')).toContain('lucide-braces')
    expect(iconFor('data.json')).toContain('lucide-brackets')
    expect(iconFor('readme.md')).toContain('lucide-file-text')
  })

  /* An extension the allowlist never sees still renders, as a plain file. */
  it('falls back to a generic file for an unmapped extension', () => {
    expect(iconFor('app.ts')).toContain('lucide-file')
  })

  /**
   * Decorative, always. The row and the tab beside it already say the filename;
   * an icon that announced "code" before every path would double every label a
   * screen reader reads out of the tree.
   */
  it('is hidden from the accessibility tree', () => {
    const wrapper = mount(FileIcon, { props: { path: 'index.html' } })

    expect(wrapper.find('svg').attributes('aria-hidden')).toBe('true')
  })

  /* The caller sizes and colours it — the tabs dim an inactive file's glyph. */
  it('takes the class its caller gives it', () => {
    const wrapper = mount(FileIcon, { props: { path: 'index.html' }, attrs: { class: 'size-3' } })

    expect(wrapper.find('svg').classes()).toContain('size-3')
  })
})
