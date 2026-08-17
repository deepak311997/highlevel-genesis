import { onScopeDispose, readonly, ref, type Ref } from 'vue'

/**
 * Theme preference and resolution.
 *
 * Three states, not two: `light` and `dark` are explicit choices, `system`
 * defers to the OS and keeps following it as it changes. Anything that only
 * supports a boolean toggle strands the user who wants to track their OS.
 *
 * NOTE: the storage key and the `dark` class name are duplicated by the inline
 * script in index.html, which runs before paint to avoid a flash of the wrong
 * theme, and the class name again by `useDarkClass.ts`, which observes it rather
 * than calling this a second time (P2 — this composable builds fresh state per
 * call, so a second instance would never hear the first one's change). Change
 * them in all three places.
 */

export const THEME_STORAGE_KEY = 'genesis:theme'
const DARK_CLASS = 'dark'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'] as const

function isPreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (PREFERENCES as readonly string[]).includes(value)
}

/** What a preference means once the OS setting is known. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

/** Stored preference, falling back to `system` for anything unrecognised. */
export function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    return isPreference(raw) ? raw : 'system'
  } catch {
    // Private browsing and some embedded webviews throw on localStorage.
    return 'system'
  }
}

/** Put the resolved theme on the document. */
export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle(DARK_CLASS, resolved === 'dark')
}

export interface UseTheme {
  preference: Readonly<Ref<ThemePreference>>
  resolved: Readonly<Ref<ResolvedTheme>>
  setPreference: (next: ThemePreference) => void
  cycle: () => void
}

export function useTheme(): UseTheme {
  const media = window.matchMedia(DARK_QUERY)
  const preference = ref<ThemePreference>(readStoredPreference())
  const resolved = ref<ResolvedTheme>(resolveTheme(preference.value, media.matches))

  function sync(): void {
    resolved.value = resolveTheme(preference.value, media.matches)
    applyTheme(resolved.value)
  }

  function setPreference(next: ThemePreference): void {
    preference.value = next
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Not being able to persist is not a reason to refuse to switch.
    }
    sync()
  }

  function cycle(): void {
    const index = PREFERENCES.indexOf(preference.value)
    setPreference(PREFERENCES[(index + 1) % PREFERENCES.length] ?? 'system')
  }

  // Only meaningful while the preference is `system`; sync() re-reads the
  // preference each time, so an explicit choice simply ignores this.
  const onSystemChange = (): void => {
    sync()
  }
  media.addEventListener('change', onSystemChange)
  onScopeDispose(() => {
    media.removeEventListener('change', onSystemChange)
  })

  sync()

  return {
    preference: readonly(preference),
    resolved: readonly(resolved),
    setPreference,
    cycle,
  }
}
