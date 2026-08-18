import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import { Toaster } from './index'

/**
 * The one toast region. Two things are asserted and neither is decorative.
 *
 * It **mounts** — `vue-sonner`'s `Toaster` is the runtime behind the primitive, and a component
 * that throws under jsdom would take `App.spec.ts` with it.
 *
 * It **follows the document's `dark` class** rather than deriving the theme a second time.
 * Upstream's shadcn-vue template themes off `@vueuse/core`'s `useColorMode`; this project
 * already owns `useDarkClass()`, which observes the class that `useTheme` and the pre-paint
 * script in `index.html` both write. A second derivation of the theme is exactly what
 * `useDarkClass`'s own doc comment exists to prevent — it is how an editor ends up light inside
 * a dark workspace with no error attached.
 */
describe('Toaster', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark')
  })

  it('mounts a toaster region', () => {
    expect(() => mount(Toaster)).not.toThrow()
  })

  it('follows the document’s dark class', async () => {
    document.documentElement.classList.add('dark')
    const dark = mount(Toaster)
    await dark.vm.$nextTick()
    expect(dark.findComponent({ name: 'Toaster' }).props('theme')).toBe('dark')

    document.documentElement.classList.remove('dark')
    const light = mount(Toaster)
    await light.vm.$nextTick()
    expect(light.findComponent({ name: 'Toaster' }).props('theme')).toBe('light')
  })
})
