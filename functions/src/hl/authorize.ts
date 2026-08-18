import { HL_SCOPES, hlAuthorizeBase, hlClientId, hlRedirectUri, hlVersionId } from './config'

/**
 * The HighLevel authorize URL the Connect button navigates to.
 *
 * **The path is `/v2/oauth/chooselocation`, and `version_id` is required.**
 * `HIGHLEVEL_PLATFORM.md` §2 Step 4 documents the v1 form; against a live app
 * that form answers `No integration found with the id: <app id>` — a message
 * that names the app id and so reads like a bad client id, which sends you off
 * regenerating client keys that were never at fault. The developer portal's own
 * generated install link is what settles it. The doc has been corrected.
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
    ['version_id', hlVersionId()],
    ['scope', HL_SCOPES.join(' ')],
    // Log in in the same tab. The default opens a new window, which is
    // disorienting mid-flow and impossible to follow in a recorded demo.
    ['loginWindowOpenMode', 'self'],
    ['state', state],
  ]
    .map(([key, value]) => `${encodeURIComponent(key ?? '')}=${encodeURIComponent(value ?? '')}`)
    .join('&')

  return `${hlAuthorizeBase()}/v2/oauth/chooselocation?${query}`
}
