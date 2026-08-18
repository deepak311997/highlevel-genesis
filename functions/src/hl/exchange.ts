import { hlApiBase, hlClientId, hlClientSecret, hlRedirectUri, hlUpstreamTimeoutMs } from './config'
import {
  installedLocationsSchema,
  locationDetailSchema,
  tokenResponseSchema,
  type InstalledLocations,
  type TokenResponse,
} from './schema'

/**
 * Every HTTP call we make to HighLevel.
 *
 * Hand-written `fetch` rather than the official SDK, deliberately: the SDK
 * refreshes on 401 by itself, which would put a second, invisible refresh path
 * next to our own. Its `.d.ts` is still the best parameter reference available,
 * which is why it is a devDependency.
 */

/** Contacts and locations. Calendars and conversations use 2021-04-15. */
const VERSION_LOCATIONS = '2021-07-28'

export class HlRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HighLevel responded ${String(status)}`)
    this.name = 'HlRequestError'
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!res.ok) throw new HlRequestError(res.status, text)
  return JSON.parse(text)
}

/**
 * The token endpoint, for both grants. Two documented gotchas: the body must be
 * **form-urlencoded** — JSON is the commonest failure and produces an unhelpful
 * error — and this is the one endpoint that takes no `Version` header.
 */
async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${hlApiBase()}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    /*
     * Bounded, by the same number the proxy uses. This is the one HighLevel call
     * that runs **inside a Firestore transaction**, so how long it takes is how
     * long a document lock is held: left to undici's 300-second default, a
     * HighLevel that accepts the connection and says nothing would hold the
     * document until the function's own timeout, with every other proxied call for
     * that user queued behind it.
     *
     * A timeout is not `invalid_grant`, so it reads as transient: nothing is
     * written and the caller gets `502 hl_unavailable`.
     */
    signal: AbortSignal.timeout(hlUpstreamTimeoutMs()),
    body: new URLSearchParams({
      client_id: hlClientId(),
      client_secret: hlClientSecret(),
      redirect_uri: hlRedirectUri(),
      user_type: 'Location',
      ...params,
    }).toString(),
  })

  return tokenResponseSchema.parse(await readJson(res))
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return postToken({ grant_type: 'authorization_code', code })
}

export function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken })
}

/** Which sub-accounts an agency-wide install actually covers. */
export async function listInstalledLocations(
  accessToken: string,
  companyId: string,
): Promise<InstalledLocations> {
  const url = new URL(`${hlApiBase()}/oauth/installedLocations`)
  url.searchParams.set('companyId', companyId)
  url.searchParams.set('limit', '50')

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: VERSION_LOCATIONS,
      Accept: 'application/json',
    },
  })

  return installedLocationsSchema.parse(await readJson(res))
}

/**
 * Trade an agency token for one scoped to a single sub-account. JSON here, unlike
 * `/oauth/token` — the two endpoints disagree about their body format.
 */
export async function exchangeForLocationToken(
  accessToken: string,
  companyId: string,
  locationId: string,
): Promise<TokenResponse> {
  const res = await fetch(`${hlApiBase()}/oauth/locationToken`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: VERSION_LOCATIONS,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ companyId, locationId }),
  })

  return tokenResponseSchema.parse(await readJson(res))
}

/**
 * The location's display name, or null. Null rather than a throw, because this is
 * cosmetic: it decides whether the panel reads "Connected to India Square" or
 * shows the raw id, and a connection that works is worth more than a name.
 */
export async function fetchLocationName(
  accessToken: string,
  locationId: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${hlApiBase()}/locations/${locationId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: VERSION_LOCATIONS,
        Accept: 'application/json',
      },
    })
    return locationDetailSchema.parse(await readJson(res)).location.name
  } catch {
    return null
  }
}
