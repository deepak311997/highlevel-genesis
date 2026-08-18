/**
 * Post-sign-in redirect targets.
 *
 * A `?redirect=` parameter is attacker-controllable: anyone can hand a user a
 * link to our own sign-in page carrying someone else's destination. Navigating
 * to it unchecked is an open redirect, and it is worth more to an attacker here
 * than on most pages because the user arrives at it having *just* authenticated.
 *
 * Two traps this closes that a `startsWith('/')` check does not:
 *
 *   //evil.com   — protocol-relative; the browser reads it as https://evil.com
 *   /\evil.com   — backslash, which several URL parsers normalise to a slash
 *
 * So the rule is deliberately narrow: a single leading slash, only characters
 * that legitimately appear in a URL path, and a path the router actually
 * registers. Anything else is not "sanitised" — it is discarded for the default.
 */

export const DEFAULT_REDIRECT = '/dashboard'
export const REDIRECT_STORAGE_KEY = 'genesis:redirect'

/**
 * Allowlist, not denylist: unreserved characters, sub-delimiters, and the few
 * separators a path may carry.
 *
 * Stated positively on purpose. A denylist has to anticipate every dangerous
 * character — backslash, tab, newline, the C0 range — and one omission is a
 * bypass. This way anything unanticipated is rejected by default, and control
 * characters never need to appear in this file to be excluded.
 */
const SAFE_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%?#]*$/

/**
 * Shape check, independent of which routes exist.
 *
 * Split out because storage happens before the router's path list is
 * necessarily to hand, and storing a hostile value at all is worth refusing.
 */
function hasSafeShape(value: string): boolean {
  if (!SAFE_PATH.test(value)) return false
  // Protocol-relative. `//evil.com` and `///` both pass the allowlist above,
  // and both are read by the browser as a different origin.
  if (value.startsWith('//')) return false
  return true
}

/** The part before any query or hash — what a route is matched on. */
function pathnameOf(value: string): string {
  const cut = value.search(/[?#]/)
  return cut === -1 ? value : value.slice(0, cut)
}

/** Everything with a meaning inside a regular expression. */
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g

/**
 * A matcher for one route *pattern*, or `null` if the pattern is not one this
 * allowlist can safely honour.
 *
 * `null` is returned for any pattern containing `(`, `*`, `?` or `+` — which in
 * this router is exactly the catch-all, `/:pathMatch(.*)*`. It matches every
 * path there is, so honouring it would make the allowlist a no-op: every
 * unknown, and every hostile, path would be "registered". A custom-regex or
 * repeatable param added later lands in the same bucket and is skipped for the
 * same reason; the cost is one redirect to the dashboard, and the alternative
 * is deciding an open-redirect question with a regex someone else wrote.
 *
 * Otherwise the pattern is compiled segment by segment: a `:param` becomes
 * `[^/]+` — **one** segment, never the rest of the path — and everything else
 * is escaped and matched literally. Anchored at both ends.
 */
function matcherFor(pattern: string): RegExp | null {
  if (/[(*?+]/.test(pattern)) return null

  const source = pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(REGEXP_SPECIAL, '\\$&')))
    .join('/')

  return new RegExp(`^${source}$`)
}

/**
 * Resolve a candidate target to something safe to navigate to.
 *
 * Returns {@link DEFAULT_REDIRECT} rather than throwing: a bad target is a
 * routine consequence of a stale or tampered link, not an error the user can
 * act on.
 *
 * **`knownPaths` holds patterns, not paths.** `router.getRoutes()` reports what
 * was registered — `/projects/:projectId`, never `/projects/abc123` — so the
 * membership test this once used could only ever pass for the static routes,
 * and returned anyone deep-linked to a workspace to the dashboard instead. The
 * enumeration of concrete paths does not exist and cannot: the id comes from
 * the user. So each pattern is compiled and the pathname is *matched*, which is
 * the same question the router itself answers.
 */
export function safeRedirect(
  raw: string | null | undefined,
  knownPaths: readonly string[],
): string {
  if (typeof raw !== 'string' || !hasSafeShape(raw)) return DEFAULT_REDIRECT

  const pathname = pathnameOf(raw)
  const known = knownPaths.some((pattern) => matcherFor(pattern)?.test(pathname) === true)
  if (!known) return DEFAULT_REDIRECT

  return raw
}

/**
 * Hold a target across a full page navigation.
 *
 * The verification link leaves the SPA entirely and comes back on
 * `/auth/action`, so a target living only in the query string is lost whenever
 * the user verifies in the same tab they signed in from.
 */
export function storeRedirect(target: string): void {
  if (!hasSafeShape(target)) return
  try {
    sessionStorage.setItem(REDIRECT_STORAGE_KEY, target)
  } catch {
    // Private browsing and some embedded webviews throw. Losing the target
    // costs the user one navigation; refusing to sign them in would cost more.
  }
}

/**
 * Read and clear the stored target.
 *
 * Validated again on the way out, not only on the way in — `sessionStorage` is
 * writable by any script on the origin, so what went in is not necessarily what
 * comes back.
 */
export function consumeRedirect(knownPaths: readonly string[]): string {
  try {
    const raw = sessionStorage.getItem(REDIRECT_STORAGE_KEY)
    sessionStorage.removeItem(REDIRECT_STORAGE_KEY)
    return safeRedirect(raw, knownPaths)
  } catch {
    return DEFAULT_REDIRECT
  }
}
