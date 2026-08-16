import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PasswordField from './PasswordField.vue'

function mountField(modelValue = '', showRules = true) {
  return mount(PasswordField, {
    props: { modelValue, id: 'pw', label: 'Password', autocomplete: 'new-password', showRules },
  })
}

describe('PasswordField', () => {
  it('masks the value by default', () => {
    expect(mountField('secret').find('input').attributes('type')).toBe('password')
  })

  /**
   * A policy needing four character classes is fiddly to type blind, and every
   * mistyped attempt costs a full submit-and-read-the-error cycle.
   */
  it('reveals and re-masks on request', async () => {
    const wrapper = mountField('secret')

    await wrapper.find('[data-testid="password-reveal"]').trigger('click')
    expect(wrapper.find('input').attributes('type')).toBe('text')

    await wrapper.find('[data-testid="password-reveal"]').trigger('click')
    expect(wrapper.find('input').attributes('type')).toBe('password')
  })

  it('reports its pressed state to assistive technology', async () => {
    const wrapper = mountField('secret')
    const toggle = wrapper.find('[data-testid="password-reveal"]')

    expect(toggle.attributes('aria-pressed')).toBe('false')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-pressed')).toBe('true')
  })

  // Guidance, not nagging: an untouched field shows no failures.
  it('hides the checklist until typing starts', () => {
    expect(mountField('').find('[data-testid="password-rules"]').exists()).toBe(false)
    expect(mountField('a').find('[data-testid="password-rules"]').exists()).toBe(true)
  })

  it('marks each rule as it is satisfied', () => {
    const wrapper = mountField('Correct-Horse-9')
    const met = wrapper
      .findAll('[data-testid="password-rules"] li')
      .map((li) => li.attributes('data-met'))

    expect(met).toEqual(['true', 'true', 'true', 'true', 'true'])
  })

  it('shows which rules are still outstanding', () => {
    const wrapper = mountField('correcthorse')
    const items = wrapper.findAll('[data-testid="password-rules"] li')
    const unmet = items.filter((li) => li.attributes('data-met') === 'false').map((li) => li.text())

    expect(unmet.join(' ')).toContain('uppercase')
    expect(unmet.join(' ')).toContain('number')
    expect(unmet.join(' ')).toContain('symbol')
  })

  it('never renders the checklist when rules are not requested', () => {
    expect(mountField('abc', false).find('[data-testid="password-rules"]').exists()).toBe(false)
  })
})
