import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { Skeleton } from './index'

/**
 * The one placeholder primitive. Before this component the app had nineteen
 * hand-rolled copies of the same three utilities, drifting in radius and
 * colour; `no-pulse.spec.ts` is what keeps a twentieth from appearing.
 *
 * Two things are load-bearing and so are pinned here. The `data-slot`
 * attribute is how every component spec asserts "this loading state is the
 * shared placeholder" without reaching for a class name. And a caller's own
 * `class` has to win a Tailwind conflict, because five of the sites this
 * replaces use `rounded` rather than `rounded-md` and must keep their shape.
 */
describe('Skeleton', () => {
  it('renders a pulsing placeholder carrying the slot attribute', () => {
    const wrapper = mount(Skeleton)

    expect(wrapper.attributes('data-slot')).toBe('skeleton')

    const classes = wrapper.attributes('class') ?? ''
    expect(classes).toContain('animate-pulse')
    expect(classes).toContain('rounded-md')
    expect(classes).toContain('bg-secondary')
  })

  it('lets a caller override the radius', () => {
    const classes = mount(Skeleton, { props: { class: 'rounded' } }).attributes('class') ?? ''

    expect(classes).toContain('rounded')
    expect(classes).not.toContain('rounded-md')
    // The rest of the base survives the merge — only the conflict resolves.
    expect(classes).toContain('animate-pulse')
    expect(classes).toContain('bg-secondary')
  })

  it('keeps the caller sizing utilities the call sites carry', () => {
    const classes = mount(Skeleton, { props: { class: 'h-5 w-48' } }).attributes('class') ?? ''

    expect(classes).toContain('h-5')
    expect(classes).toContain('w-48')
  })
})
