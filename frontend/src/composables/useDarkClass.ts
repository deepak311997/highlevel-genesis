import { onScopeDispose, readonly, ref, type Ref } from 'vue'

/**
 * Whether the document is currently in dark mode — read from the class, not
 * recomputed (P2).
 *
 * `useTheme()` owns the *decision*: it reads the stored preference, watches
 * `prefers-color-scheme`, and writes the `dark` class onto
 * `document.documentElement`. It builds fresh state per call, which its own spec
 * depends on — so a second `useTheme()` here would hold a different `preference`
 * ref and never hear `ThemeToggle`'s change, because nothing broadcasts it inside
 * the tab that made it.
 *
 * The class is already the single source of truth. `applyTheme()` writes it, and
 * the pre-paint script in `index.html` writes it before Vue exists. Observing it
 * is therefore reading the answer rather than deriving it a second time — and a
 * second derivation is exactly how an editor ends up light inside a dark
 * workspace with no error attached.
 *
 * NOTE: the `dark` class name is duplicated in `useTheme.ts` and in `index.html`
 * (which cannot import it and still run before paint). This is its third reader.
 */

const DARK_CLASS = 'dark'

export function useDarkClass(): Readonly<Ref<boolean>> {
  const root = document.documentElement
  const dark = ref(root.classList.contains(DARK_CLASS))

  const observer = new MutationObserver(() => {
    dark.value = root.classList.contains(DARK_CLASS)
  })
  observer.observe(root, { attributes: true, attributeFilter: ['class'] })

  // `useTheme.ts`'s cleanup pattern. Without it every editor that is mounted and
  // unmounted — which the `lg` breakpoint does on a window resize — leaves an
  // observer watching the document for a ref nothing reads.
  onScopeDispose(() => {
    observer.disconnect()
  })

  return readonly(dark)
}
