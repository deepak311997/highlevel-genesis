import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyTheme,
  readStoredPreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  useTheme,
  type ThemePreference,
} from './useTheme'

function stubMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    dispatch(next: boolean) {
      mql.matches = next
      listeners.forEach((fn) => {
        fn({ matches: next } as MediaQueryListEvent)
      })
    },
  }
  vi.stubGlobal('matchMedia', () => mql)
  return mql
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveTheme', () => {
  it('honours an explicit preference regardless of the system setting', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('follows the system setting when the preference is "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('readStoredPreference', () => {
  it('returns the stored value when it is one we recognise', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(readStoredPreference()).toBe('dark')
  })

  // Anything unrecognised means someone hand-edited storage or we changed the
  // format — falling back to "system" is safer than throwing on boot.
  it('falls back to "system" for a missing or unrecognised value', () => {
    expect(readStoredPreference()).toBe('system')
    localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse')
    expect(readStoredPreference()).toBe('system')
  })
})

describe('applyTheme', () => {
  it('adds the dark class for dark and removes it for light', () => {
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    applyTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

describe('useTheme', () => {
  it('starts from the stored preference and applies it', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    stubMatchMedia(false)

    const { preference, resolved } = useTheme()

    expect(preference.value).toBe('dark')
    expect(resolved.value).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('persists a new preference and applies it immediately', () => {
    stubMatchMedia(false)
    const { setPreference, resolved } = useTheme()

    setPreference('dark')

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(resolved.value).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('follows the OS when the preference is "system"', () => {
    const mql = stubMatchMedia(false)
    const { setPreference, resolved } = useTheme()
    setPreference('system')

    expect(resolved.value).toBe('light')

    mql.dispatch(true)
    expect(resolved.value).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('stops following the OS once an explicit choice is made', () => {
    const mql = stubMatchMedia(false)
    const { setPreference, resolved } = useTheme()
    setPreference('light')

    mql.dispatch(true)

    expect(resolved.value).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('cycles light → dark → system → light', () => {
    stubMatchMedia(false)
    const { preference, setPreference, cycle } = useTheme()
    setPreference('light')

    const seen: ThemePreference[] = []
    for (let i = 0; i < 3; i++) {
      cycle()
      seen.push(preference.value)
    }

    expect(seen).toEqual(['dark', 'system', 'light'])
  })
})
