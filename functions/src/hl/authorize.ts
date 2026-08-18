import { HL_SCOPES, hlAuthorizeBase, hlClientId, hlRedirectUri, hlVersionId } from './config'

/**
 * The HighLevel authorize URL the Connect button navigates to.
 *
 * **The path is `/v2/oauth/chooselocation`, and `version_id` is required.** The v1
 * form answers `No integration found with the id: <app id>` against a live app —
 * a message that names the app id and so reads like a bad client id, sending you
 * off regenerating keys that were never at fault.
 *
 * Built by hand rather than with `URLSearchParams`, which serialises a space as
 * `+`: right for a form body, wrong here. HighLevel documents `scope` as
 * space-separated and URL-encoded, so a `+` is read as a literal character and the
 * consent screen grants a scope set that quietly differs from the one asked for.
 */
export function buildAuthorizeUrl(state: string): string {
  const query = [
    ['response_type', 'code'],
    ['redirect_uri', hlRedirectUri()],
    ['client_id', hlClientId()],
    ['version_id', hlVersionId()],
    ['scope', HL_SCOPES.join(' ')],
    // Log in in the same tab: the default opens a new window, which is
    // disorienting mid-flow and impossible to follow in a recorded demo.
    ['loginWindowOpenMode', 'self'],
    ['state', state],
  ]
    .map(([key, value]) => `${encodeURIComponent(key ?? '')}=${encodeURIComponent(value ?? '')}`)
    .join('&')

  return `${hlAuthorizeBase()}/v2/oauth/chooselocation?${query}`
}
