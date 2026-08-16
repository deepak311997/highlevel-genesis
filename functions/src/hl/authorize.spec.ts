import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildAuthorizeUrl } from './authorize'
import { HL_SCOPES } from './config'

/**
 * The URL the Connect button sends the user to.
 *
 * Composed here rather than in the browser so `client_id` and the scope list
 * never ship in the bundle, and so the uid bound into the state is one the
 * server established rather than one a client asserted (PRD D2).
 *
 * The assertions that matter are the two that fail silently in production:
 * `redirect_uri` must match the marketplace app byte for byte, and the scope
 * separator must be `%20` rather than the `+` that `URLSearchParams` emits.
 */

const REDIRECT = 'https://hl-genesis-app.web.app/api/oauth/callback'
const CLIENT_ID = 'test-client-id-1234'
const VERSION_ID = 'test-version-id-5678'
const STATE = 'sealed-state-token'

const saved: Record<string, string | undefined> = {}
const KEYS = ['HL_CLIENT_ID', 'HL_VERSION_ID', 'HL_REDIRECT_URI', 'HL_AUTHORIZE_BASE'] as const

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key]
  process.env['HL_CLIENT_ID'] = CLIENT_ID
  process.env['HL_VERSION_ID'] = VERSION_ID
  process.env['HL_REDIRECT_URI'] = REDIRECT
  delete process.env['HL_AUTHORIZE_BASE']
})

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key]
    // Reflect rather than `delete process.env[key]`: the lint rule against
    // dynamically computed deletes is on, and it is right — this is the one
    // place the key is not a literal.
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

describe('buildAuthorizeUrl', () => {
  /*
   * The **v2** path, and this is not cosmetic. HIGHLEVEL_PLATFORM.md §2 Step 4
   * documented `/oauth/chooselocation`, which is what this file originally
   * asserted — and against a live app that path answers
   * `No integration found with the id: …`, naming the app id it could not
   * resolve. The developer portal's own generated install link uses
   * `/v2/oauth/chooselocation` with a `version_id`. The doc is stale; the
   * portal is authoritative, and this test is the record of that.
   */
  it('targets the v2 chooselocation endpoint', () => {
    expect(buildAuthorizeUrl(STATE)).toMatch(
      /^https:\/\/marketplace\.gohighlevel\.com\/v2\/oauth\/chooselocation\?/,
    )
  })

  it('honours HL_AUTHORIZE_BASE, which is how the emulator reaches the fake', () => {
    process.env['HL_AUTHORIZE_BASE'] = 'http://127.0.0.1:5001/demo/asia-south1/api/__fake-hl'
    expect(buildAuthorizeUrl(STATE)).toMatch(
      /^http:\/\/127\.0\.0\.1:5001\/demo\/asia-south1\/api\/__fake-hl\/v2\/oauth\/chooselocation\?/,
    )
  })

  it('carries the parameters HighLevel requires', () => {
    const params = new URL(buildAuthorizeUrl(STATE)).searchParams
    expect(params.get('response_type')).toBe('code')
    expect(params.get('client_id')).toBe(CLIENT_ID)
    expect(params.get('state')).toBe(STATE)
    // Same tab rather than a new one — the default popup is confusing in a demo.
    expect(params.get('loginWindowOpenMode')).toBe('self')
  })

  /*
   * `version_id` identifies the app version whose scope list and redirect URL
   * the consent screen should honour. Without it the v2 endpoint cannot resolve
   * the app at all — this is the parameter whose absence produced the
   * "No integration found" failure.
   */
  it('identifies the app version, without which v2 cannot resolve the app', () => {
    expect(new URL(buildAuthorizeUrl(STATE)).searchParams.get('version_id')).toBe(VERSION_ID)
  })

  it('fails loudly when the version id is not configured', () => {
    Reflect.deleteProperty(process.env, 'HL_VERSION_ID')
    expect(() => buildAuthorizeUrl(STATE)).toThrow(/HL_VERSION_ID/)
  })

  it('sends redirect_uri byte for byte, since HighLevel matches it exactly', () => {
    expect(new URL(buildAuthorizeUrl(STATE)).searchParams.get('redirect_uri')).toBe(REDIRECT)
  })

  it('requests every scope, space separated', () => {
    const scope = new URL(buildAuthorizeUrl(STATE)).searchParams.get('scope')
    expect(scope?.split(' ')).toEqual([...HL_SCOPES])
  })

  /*
   * URLSearchParams encodes a space as `+`, which is correct for form bodies
   * and wrong here: the scope parameter is documented as space separated and
   * URL encoded, meaning %20. Getting this wrong yields an authorization page
   * that silently grants a subset of the scopes asked for.
   */
  it('encodes scope separators as %20, not +', () => {
    const raw = buildAuthorizeUrl(STATE)
    const scope = /[?&]scope=([^&]*)/.exec(raw)?.[1]
    expect(scope).toBeDefined()
    expect(scope).toContain('%20')
    expect(scope).not.toContain('+')
  })

  it('fails loudly when the redirect URI is not configured', () => {
    delete process.env['HL_REDIRECT_URI']
    expect(() => buildAuthorizeUrl(STATE)).toThrow(/HL_REDIRECT_URI/)
  })
})

describe('HL_SCOPES', () => {
  /*
   * Adding a scope later forces every existing install to re-authorise, so the
   * list is taken in full up front (PRD D18). This test is the tripwire: it
   * fails if someone edits the constant, which is the moment to also update the
   * marketplace app — the other half of a contract this repo cannot see.
   */
  it('is the full list agreed with the marketplace app', () => {
    expect([...HL_SCOPES]).toEqual([
      'locations.readonly',
      'contacts.readonly',
      'contacts.write',
      'conversations.readonly',
      'conversations.write',
      'conversations/message.readonly',
      'conversations/message.write',
      'calendars.readonly',
      'calendars/events.readonly',
      'calendars/events.write',
      'users.readonly',
      'opportunities.readonly',
      'locations/customFields.readonly',
      'locations/tags.readonly',
    ])
  })
})
