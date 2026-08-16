import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './index'

/**
 * The card parts are thin presentational wrappers, so these tests are
 * correspondingly thin. They exist for two reasons that are not thin:
 * `CardTitle` must stay a heading, because every auth screen hangs its
 * accessible name off it, and `cn()` must keep merging caller classes rather
 * than replacing the component's own.
 */
describe('Card', () => {
  it('renders a title as a heading, not a styled div', () => {
    // The auth screens have no other <h*>, so this element is the page's
    // accessible name. A div here would leave every one of them unlabelled.
    const wrapper = mount(CardTitle, { slots: { default: 'Sign in' } })

    expect(wrapper.element.tagName).toMatch(/^H[1-6]$/)
    expect(wrapper.text()).toBe('Sign in')
  })

  it.each([
    ['Card', Card],
    ['CardHeader', CardHeader],
    ['CardContent', CardContent],
    ['CardFooter', CardFooter],
    ['CardDescription', CardDescription],
  ])('%s renders its slot', (_name, component) => {
    expect(mount(component, { slots: { default: 'content' } }).text()).toBe('content')
  })

  it('merges a caller class with the component default rather than replacing it', () => {
    const classes = mount(Card, {
      props: { class: 'w-96' },
      slots: { default: 'x' },
    }).attributes('class')

    expect(classes).toContain('w-96')
    expect(classes).toContain('rounded')
  })

  it('composes into the shape the auth screens use', () => {
    const wrapper = mount(Card, {
      slots: {
        default: `
          <div>
            <h3>Create an account</h3>
            <p>It takes a minute.</p>
          </div>
          <form>fields</form>
          <div>footer</div>
        `,
      },
    })

    expect(wrapper.text()).toContain('Create an account')
    expect(wrapper.text()).toContain('It takes a minute.')
    expect(wrapper.text()).toContain('footer')
  })
})
