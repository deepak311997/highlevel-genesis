import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { THEME_STORAGE_KEY } from '@/composables/useTheme'

import ThemeToggle from './ThemeToggle.vue'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ThemeToggle', () => {
  it('names the current theme so the state is announced, not just the control', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const wrapper = mount(ThemeToggle)

    expect(wrapper.get('[data-testid="theme-toggle"]').attributes('aria-label')).toContain('dark')
  })

  it('switches the document to dark when cycled from light', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const wrapper = mount(ThemeToggle)

    await wrapper.get('[data-testid="theme-toggle"]').trigger('click')

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('reaches system on the third step, back where it started', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const wrapper = mount(ThemeToggle)
    const btn = wrapper.get('[data-testid="theme-toggle"]')

    await btn.trigger('click')
    await btn.trigger('click')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')

    await btn.trigger('click')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })
})
