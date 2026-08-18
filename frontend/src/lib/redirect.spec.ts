import { afterEach, describe, expect, it } from 'vitest'

import {
  consumeRedirect,
  DEFAULT_REDIRECT,
  REDIRECT_STORAGE_KEY,
  safeRedirect,
  storeRedirect,
} from './redirect'

/**
 * Stands in for the router's registered paths.
 *
 * These are the *patterns* `router.getRoutes()` yields, not concrete paths —
 * including the parameterised workspace route and the catch-all, both of which
 * the real router registers.
 */
const KNOWN = [
  '/',
  '/health',
  '/dashboard',
  '/signin',
  '/projects/:projectId',
  '/:pathMatch(.*)*',
] as const

describe('safeRedirect', () => {
  it('returns a known same-origin path unchanged', () => {
    expect(safeRedirect('/dashboard', KNOWN)).toBe('/dashboard')
    expect(safeRedirect('/health', KNOWN)).toBe('/health')
    expect(safeRedirect('/', KNOWN)).toBe('/')
  })

  it('keeps a query string and hash on a known path', () => {
    expect(safeRedirect('/health?run=1#results', KNOWN)).toBe('/health?run=1#results')
  })

  // The whole point of the function. Each of these is a real open-redirect
  // payload, and `//evil.com` in particular defeats a naive startsWith('/').
  it.each([
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with path', '//evil.com/pwn'],
    ['absolute https', 'https://evil.com'],
    ['absolute http', 'http://evil.com'],
    ['backslash after slash', '/\\evil.com'],
    ['double backslash', '\\\\evil.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['triple slash', '///'],
    ['no leading slash', 'dashboard'],
    ['leading whitespace', ' /dashboard'],
    ['embedded newline', '/dash\nboard'],
    ['embedded tab', '/dash\tboard'],
    ['empty string', ''],
  ])('falls back to the default for %s', (_label, payload) => {
    expect(safeRedirect(payload, KNOWN)).toBe(DEFAULT_REDIRECT)
  })

  it('falls back for a path that matches no registered route', () => {
    expect(safeRedirect('/not-a-route', KNOWN)).toBe(DEFAULT_REDIRECT)
  })

  /*
   * The allowlist is over route *patterns*, so a concrete workspace path has to
   * be matched against `/projects/:projectId` rather than looked up in it. A
   * membership test returns a deep-linked user to the dashboard instead of the
   * project they asked for (C2).
   */
  it('returns a concrete path for a parameterised route', () => {
    expect(safeRedirect('/projects/abc123', KNOWN)).toBe('/projects/abc123')
  })

  it('keeps a query and hash on a parameterised path', () => {
    expect(safeRedirect('/projects/abc123?tab=files#top', KNOWN)).toBe(
      '/projects/abc123?tab=files#top',
    )
  })

  /* `/:pathMatch(.*)*` matches everything, so treating it as an entry would
   * make the allowlist mean nothing at all. */
  it('still refuses a path the catch-all would swallow', () => {
    expect(safeRedirect('/not-a-route', KNOWN)).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect('/admin/secrets', KNOWN)).toBe(DEFAULT_REDIRECT)
  })

  /* A `:param` is one segment, never the rest of the path. */
  it('refuses an extra segment', () => {
    expect(safeRedirect('/projects/abc/extra', KNOWN)).toBe(DEFAULT_REDIRECT)
  })

  it('falls back for null and undefined', () => {
    expect(safeRedirect(null, KNOWN)).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect(undefined, KNOWN)).toBe(DEFAULT_REDIRECT)
  })
})

describe('redirect storage', () => {
  afterEach(() => {
    sessionStorage.clear()
  })

  // The gate navigates away to /auth/action, so a target held only in the URL
  // is lost the moment the user verifies in the same tab (AC-27).
  it('round trips a target across a navigation', () => {
    storeRedirect('/health')

    expect(sessionStorage.getItem(REDIRECT_STORAGE_KEY)).toBe('/health')
    expect(consumeRedirect(KNOWN)).toBe('/health')
  })

  it('clears the target once consumed, so it cannot fire twice', () => {
    storeRedirect('/health')
    consumeRedirect(KNOWN)

    expect(consumeRedirect(KNOWN)).toBe(DEFAULT_REDIRECT)
  })

  it('validates on the way out, not only on the way in', () => {
    sessionStorage.setItem(REDIRECT_STORAGE_KEY, '//evil.com')

    expect(consumeRedirect(KNOWN)).toBe(DEFAULT_REDIRECT)
  })

  it('refuses to store a hostile target in the first place', () => {
    storeRedirect('//evil.com')

    expect(sessionStorage.getItem(REDIRECT_STORAGE_KEY)).toBeNull()
  })
})
