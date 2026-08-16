import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { Button } from './index'

describe('Button', () => {
  it('renders a real button by default', () => {
    expect(mount(Button, { slots: { default: 'Go' } }).element.tagName).toBe('BUTTON')
  })

  /**
   * `<RouterLink><Button/></RouterLink>` renders `<a><button>`, which is
   * invalid: an anchor may not contain interactive content. Screen readers
   * announce it inconsistently and the click target is ambiguous. `as-child`
   * merges the styling onto the link instead, leaving a single element.
   */
  it('merges into its child so a link-button is one element, not two', () => {
    const wrapper = mount(Button, {
      props: { asChild: true },
      slots: { default: '<a href="/signin">Sign in</a>' },
    })

    expect(wrapper.element.tagName).toBe('A')
    expect(wrapper.find('button').exists()).toBe(false)
    // The styling still lands on the anchor.
    expect(wrapper.attributes('class')).toContain('inline-flex')
  })

  it('can render as another element outright', () => {
    expect(mount(Button, { props: { as: 'a' }, slots: { default: 'x' } }).element.tagName).toBe('A')
  })

  it('applies variant and size classes', () => {
    const wrapper = mount(Button, {
      props: { variant: 'outline', size: 'sm' },
      slots: { default: 'x' },
    })

    expect(wrapper.attributes('class')).toContain('border-border-strong')
    expect(wrapper.attributes('class')).toContain('h-8')
  })
})
