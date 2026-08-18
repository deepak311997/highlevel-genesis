import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleConnect } from './connect'

/**
 * The line the install starts with.
 *
 * Half of what makes an OAuth failure hard to place is that the two ends of the flow read
 * their configuration separately: this handler builds the authorize URL, and the callback —
 * a different request, minutes later — sends a `redirect_uri` to the token endpoint. If those
 * two strings ever differ, HighLevel refuses the exchange and the user is told to try again,
 * which they can do forever. So both ends log the value they used, and the pair of lines
 * settles the question the redirect never could.
 */

const REDIRECT = 'https://genesis.test/api/oauth/callback'
const UID = 'PZ9kQxLm3nR7vB2t'

let info: ReturnType<typeof vi.fn>
let json: ReturnType<typeof vi.fn>

function line(): Record<string, unknown> {
  return JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
}

beforeEach(() => {
  process.env['HL_CLIENT_ID'] = 'test-client-id-1234'
  process.env['HL_VERSION_ID'] = 'test-version-id-5678'
  process.env['HL_REDIRECT_URI'] = REDIRECT
  process.env['OAUTH_STATE_SECRET'] = 'test-secret-not-a-real-key-0123456789'

  info = vi.fn()
  json = vi.fn()
  vi.stubGlobal('console', { ...console, info, error: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of ['HL_CLIENT_ID', 'HL_VERSION_ID', 'HL_REDIRECT_URI', 'OAUTH_STATE_SECRET']) {
    Reflect.deleteProperty(process.env, key)
  }
})

async function connect(): Promise<void> {
  await handleConnect({} as Request, { json } as unknown as Response, UID)
}

describe('handleConnect', () => {
  it('still answers with the authorize URL', async () => {
    await connect()

    const { authorizeUrl } = json.mock.calls[0]?.[0] as { authorizeUrl: string }
    expect(authorizeUrl).toContain('/v2/oauth/chooselocation')
  })

  it('records the redirect URI the flow is starting with', async () => {
    await connect()

    expect(line()['event']).toBe('hl.connect.start')
    expect(line()['redirectUri']).toBe(REDIRECT)
  })

  it('records neither the state it sealed nor the uid it sealed into it', async () => {
    await connect()

    const { authorizeUrl } = json.mock.calls[0]?.[0] as { authorizeUrl: string }
    const state = new URL(authorizeUrl).searchParams.get('state') ?? 'no-state'

    expect(String(info.mock.calls[0]?.[0])).not.toContain(state)
    expect(String(info.mock.calls[0]?.[0])).not.toContain(UID)
  })
})
