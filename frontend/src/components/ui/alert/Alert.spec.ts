import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { Alert, AlertDescription, AlertTitle } from './index'

describe('Alert', () => {
  /**
   * The role follows the variant, which is the one place this component deliberately departs
   * from upstream.
   */
  it.each([
    ['destructive', 'alert'],
    ['success', 'status'],
    ['default', 'status'],
  ] as const)('announces a %s alert with role=%s', (variant, role) => {
    const wrapper = mount(Alert, { props: { variant }, slots: { default: 'x' } })

    expect(wrapper.attributes('role')).toBe(role)
  })

  it('defaults to the polite role when no variant is given', () => {
    expect(mount(Alert, { slots: { default: 'x' } }).attributes('role')).toBe('status')
  })

  /**
   * `--accent` is reserved. style.css states it in a comment — the ember accent marks the one
   * element per view that is *live*, "never success, never a decorative highlight" — and defines
   * `--good` for semantic success.
   */
  it('paints success with the semantic token, not the reserved accent', () => {
    const classes = mount(Alert, {
      props: { variant: 'success' },
      slots: { default: 'x' },
    }).attributes('class')

    expect(classes).toContain('text-good')
    expect(classes).not.toContain('accent')
  })

  it('keeps destructive on its own token', () => {
    const classes = mount(Alert, {
      props: { variant: 'destructive' },
      slots: { default: 'x' },
    }).attributes('class')

    expect(classes).toContain('text-destructive')
  })

  it('composes a title and a description', () => {
    const wrapper = mount(Alert, {
      slots: {
        default: '<h5>Check your inbox</h5><p>We sent a link.</p>',
      },
    })

    expect(wrapper.text()).toContain('Check your inbox')
    expect(wrapper.text()).toContain('We sent a link.')
  })

  it('renders AlertTitle and AlertDescription as distinct elements', () => {
    expect(mount(AlertTitle, { slots: { default: 'T' } }).text()).toBe('T')
    expect(mount(AlertDescription, { slots: { default: 'D' } }).text()).toBe('D')
  })

  it('lets a caller add classes without losing the variant styling', () => {
    const classes = mount(Alert, {
      props: { variant: 'destructive', class: 'mt-4' },
      slots: { default: 'x' },
    }).attributes('class')

    expect(classes).toContain('mt-4')
    expect(classes).toContain('text-destructive')
  })
})
