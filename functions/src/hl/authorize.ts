import { HL_SCOPES, hlAuthorizeBase, hlClientId, hlRedirectUri } from './config'

/**
 * The HighLevel authorize URL the Connect button navigates to.
 *
 * Built by hand rather than with `URLSearchParams`, and that is not stylistic:
 * `URLSearchParams` serialises a space as `+`, which is right for a form body
 * and wrong for this parameter. HighLevel documents `scope` as space separated
 * and URL encoded — `%20`. A `+` there is read as a literal character, so the
 * consent screen grants a scope set that quietly differs from the one asked
 * for, and the failure only shows up much later as a 401 on an endpoint that
 * should have worked.
 */
export function buildAuthorizeUrl(state: string): string {
  const query = [
    ['response_type', 'code'],
    ['redirect_uri', hlRedirectUri()],
    ['client_id', hlClientId()],
    ['scope', HL_SCOPES.join(' ')],
    // Log in in the same tab. The default opens a new window, which is
    // disorienting mid-flow and impossible to follow in a recorded demo.
    ['loginWindowOpenMode', 'self'],
    ['state', state],
  ]
    .map(([key, value]) => `${encodeURIComponent(key ?? '')}=${encodeURIComponent(value ?? '')}`)
    .join('&')

  return `${hlAuthorizeBase()}/oauth/chooselocation?${query}`
}
