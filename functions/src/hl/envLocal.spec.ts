import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * What a fresh clone gets.
 *
 * `functions/.env.local` is committed so `npm run dev` and the emulator suites work with no
 * setup, and it carries two modes: a stubbed HighLevel that runs offline, and a real one reached
 * through an HTTPS tunnel. Switching to the real one is a local, temporary act — and committing
 * it by accident is easy, because **nothing else notices**: the test suites set `HL_TEST_*`
 * overrides and pass either way, so the first symptom is a fresh clone that cannot run.
 */

const ENV_LOCAL = readFileSync(join(__dirname, '../../.env.local'), 'utf8')

/** Lines that actually take effect: not blank, not a comment. */
const active = ENV_LOCAL.split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))

function valueOf(key: string): string | undefined {
  return active.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1)
}

describe('the committed functions/.env.local', () => {
  it('selects the stubbed HighLevel, so a fresh clone runs offline', () => {
    expect(valueOf('HL_AUTHORIZE_BASE')).toContain('__fake-hl')
    expect(valueOf('HL_API_BASE')).toContain('__fake-hl')
  })

  it('points the callback at the local dev server, not at a tunnel or a deploy', () => {
    expect(valueOf('HL_REDIRECT_URI')).toBe('http://localhost:5173/api/oauth/callback')
  })

  /*
   * A tunnel hostname is personal and ephemeral — it belongs to whoever ran ngrok that day and
   * stops resolving afterwards.
   */
  it('carries no tunnel hostname on an active line', () => {
    for (const line of active) {
      expect(line).not.toMatch(/ngrok|trycloudflare|loca\.lt/)
    }
  })

  /*
   * The real credentials are deliberately *absent*, so they fall through to `functions/.env`,
   * which is gitignored.
   */
  it('defines no HighLevel credentials, so the real ones stay out of git', () => {
    for (const key of ['HL_CLIENT_SECRET', 'HL_CLIENT_ID', 'HL_VERSION_ID']) {
      const value = valueOf(key)
      if (value !== undefined) expect(value).toMatch(/^emulator-/)
    }
  })

  it('uses a state secret that is obviously not the real one', () => {
    expect(valueOf('OAUTH_STATE_SECRET')).toMatch(/emulator-only/)
  })
})
