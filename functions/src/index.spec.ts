import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import * as deployed from './index'

/**
 * What actually gets deployed.
 *
 * This file exists because of a real failure: `deleteExpiredUnverifiedUsers` was written, unit-
 * tested and integration-tested, and then its `onSchedule` trigger was dropped in an unrelated
 * commit. Every test stayed green, because every test called the function directly — none of
 * them asked whether anything in production ever would. The sweep silently stopped existing for
 * two days.
 */
describe('deployed function surface', () => {
  it.each(['api', 'generate', 'cleanupUnverifiedUsers'])('exports %s', (name) => {
    expect(deployed).toHaveProperty(name)
  })

  it('schedules the unverified-account sweep', () => {
    // D18's fourth mitigation. Without a trigger an account an attacker
    // registered at someone else's address persists indefinitely, and the
    // victim can still be talked into verifying it months later.
    expect(deployed.cleanupUnverifiedUsers).toBeDefined()
  })
})

/**
 * `/generate`'s deployment surface, and the honest limit of what it proves.
 *
 * `__endpoint` carries the secret binding, the timeout and the memory — three things no other
 * test level can see, because every one of them is decided by the deploy rather than by a
 * request. A function that lost its `ANTHROPIC_API_KEY` binding would pass every unit and
 * integration test in this repository and then answer 500 on the first real generation, because
 * under the emulator the key is never read at all.
 */
interface DeployedEndpoint {
  secretEnvironmentVariables?: { key: string }[]
  timeoutSeconds?: number
  availableMemoryMb?: number
}

function endpointOf(fn: unknown): DeployedEndpoint {
  const endpoint = (fn as { __endpoint?: DeployedEndpoint }).__endpoint
  if (endpoint === undefined) throw new Error('no __endpoint on the exported function')
  return endpoint
}

/** The secret names a deployed function is granted, as plain strings. */
function secretsOf(fn: unknown): string[] {
  return (endpointOf(fn).secretEnvironmentVariables ?? []).map((entry) => entry.key)
}

describe('the generate function’s deployment surface', () => {
  /*
   * The key lives in Secret Manager and is bound to this function alone — so `api` cannot read
   * it, and nothing about it is in `functions/.env`, where everything is uploaded as a plain
   * environment variable readable by anyone with Viewer on the project.
   */
  it('binds ANTHROPIC_API_KEY as a secret', () => {
    expect(endpointOf(deployed.generate).secretEnvironmentVariables).toContainEqual({
      key: 'ANTHROPIC_API_KEY',
    })
  })

  /*
   * Slice 0 pinned 60 seconds deliberately while the endpoint was unauthenticated, saying the
   * long timeout would arrive "together with the ID-token check that makes it safe to grant".
   */
  it('allows a nine-minute turn', () => {
    expect(endpointOf(deployed.generate).timeoutSeconds).toBe(540)
  })

  it('has 512 MiB, for the SDK plus an accumulating string', () => {
    expect(endpointOf(deployed.generate).availableMemoryMb).toBe(512)
  })

  /* The CRUD function must not pay for either, which is why they are separate. */
  it('leaves the api function short and small', () => {
    expect(endpointOf(deployed.api).timeoutSeconds).toBe(60)
    expect(endpointOf(deployed.api).availableMemoryMb).toBe(256)
  })

  /*
   * The model key is bound to `generate` and to nothing else. `api` never opens
   * a stream, so granting it the key would widen the blast radius of a bug in
   * any of a dozen CRUD routes to include the one credential that spends money.
   */
  it('does not grant the api function the model key', () => {
    expect(secretsOf(deployed.api)).not.toContain('ANTHROPIC_API_KEY')
  })
})

/**
 * `api`'s two secrets, and why they are secrets rather than environment.
 *
 * Both were read straight from `process.env` until the deploy pipeline was written, which meant
 * both were carried in `functions/.env` — and everything in that file is uploaded as a plain
 * environment variable on the Cloud Run service, readable by anyone holding Viewer on the
 * project. That is the disclosure property D19 rejected for the model key, and neither of these
 * is less sensitive than that one: `HL_CLIENT_SECRET` is half of the marketplace app's
 * credentials and is displayed exactly once at creation, and `OAUTH_STATE_SECRET` is the key the
 * OAuth `state` is sealed under — recover it and the uid a callback carries becomes forgeable.
 */
describe('the api function\u2019s secret bindings', () => {
  it.each([
    'HL_CLIENT_SECRET',
    'OAUTH_STATE_SECRET',
    'HL_CLIENT_ID',
    'HL_VERSION_ID',
    'HL_REDIRECT_URI',
    'ALLOWED_ORIGINS',
  ])('binds %s as a secret', (key) => {
    expect(secretsOf(deployed.api)).toContain(key)
  })

  /*
   * Least privilege in the other direction. `generate` builds the system prompt
   * and streams the model; it never exchanges an authorization code and never
   * seals a state parameter, so it has no business holding either value.
   */
  it.each(['HL_CLIENT_SECRET', 'OAUTH_STATE_SECRET'])(
    'does not grant %s to the generate function',
    (key) => {
      expect(secretsOf(deployed.generate)).not.toContain(key)
    },
  )
})

/**
 * The four that are configuration rather than credentials, and are Secret Manager values anyway.
 *
 * None of them authorises anything — the credential half of the marketplace app is
 * `HL_CLIENT_SECRET`, above. They are here because the alternative is `functions/.env`, and
 * everything in that file becomes a plain environment variable on the Cloud Run service:
 * readable by anyone with Viewer on the project, and printed into the deploy log by whatever
 * writes the file. On a public repository that second one is a published value.
 */
describe('the origin allowlist reaches both functions', () => {
  /*
   * `generate.ts` imports `originAllowlist` from `./api`, so the CORS layer on the streaming
   * endpoint reads the same value the CRUD one does.
   */
  it.each(['api', 'generate'] as const)('binds ALLOWED_ORIGINS on %s', (name) => {
    expect(secretsOf(deployed[name])).toContain('ALLOWED_ORIGINS')
  })

  /* The model key stays where it was: one function, the one that spends money. */
  it('binds ANTHROPIC_API_KEY on generate alone', () => {
    expect(secretsOf(deployed.generate)).toContain('ANTHROPIC_API_KEY')
    expect(secretsOf(deployed.api)).not.toContain('ANTHROPIC_API_KEY')
  })
})

/**
 * AC-25's middleware half — a source scan, because `__endpoint` cannot see it.
 *
 * The same technique `no-firestore.spec.ts` and `params.spec.ts` already use.
 * What it proves is that the two guards are *named* in the file; that they
 * actually run is T9's 401 and 403 over the wire.
 */
describe('the guards on the money-spending routes', () => {
  const read = (path: string): string => readFileSync(join(process.cwd(), 'src', path), 'utf8')

  it.each(['withVerifiedUser', 'requireAppCheck'])('generate.ts carries %s', (guard) => {
    expect(read('generate.ts')).toContain(guard)
  })

  /*
   * The messages router has no write any more: a prompt is stored by `/generate`, inside the
   * request that streams the reply, so the attestation that used to guard the write lives there
   * — asserted by the `generate.ts` case above.
   */
  it('the messages router exposes no write at all', () => {
    const source = read('messages/index.ts')

    expect(source).toContain('withVerifiedUser')
    expect(source).not.toMatch(/messagesRouter\.(post|put|patch|delete)\(/)
  })

  /** AC-31's structural half — which file routes are attested. */
  it('attests the file PUT and neither of the file GETs', () => {
    const source = read('files/index.ts')

    expect(source).toContain('withVerifiedUser')
    expect(source).toMatch(
      /filesRouter\.put\(\s*'\/projects\/:projectId\/files\/:path',\s*attested/,
    )
    // Reading is a plain authenticated read: App Check buys nothing against a
    // caller who already holds a valid ID token (D28, unchanged since Slice 2).
    expect(source).not.toMatch(/filesRouter\.get\([^)]*attested/)
  })

  it('guards all three file routes with withVerifiedUser', () => {
    const source = read('files/index.ts')
    const guarded = source.match(/withVerifiedUser\(/g) ?? []

    expect(guarded).toHaveLength(3)
  })

  /** AC-19's structural half — which snapshot route is attested. */
  it('does not attest the snapshot list, and guards it with withVerifiedUser', () => {
    const source = read('snapshots/index.ts')

    expect(source).toMatch(
      /snapshotsRouter\.get\(\s*'\/projects\/:projectId\/snapshots',\s*asyncHandler\(withVerifiedUser/,
    )
    // Reading is a plain authenticated read: App Check buys nothing against a
    // caller who already holds a valid ID token (D28, unchanged since Slice 2).
    expect(source).not.toMatch(/snapshotsRouter\.get\([^)]*attested/)
  })

  /** AC-19's structural half for the write route. */
  it('attests the snapshot restore', () => {
    const source = read('snapshots/index.ts')

    expect(source).toMatch(
      /snapshotsRouter\.post\(\s*'\/projects\/:projectId\/snapshots\/:snapshotId\/restore',\s*attested/,
    )
  })

  it('guards both snapshot routes with withVerifiedUser', () => {
    const source = read('snapshots/index.ts')
    const guarded = source.match(/withVerifiedUser\(/g) ?? []

    expect(guarded).toHaveLength(2)
  })

  /** No user identifier in either path — not `:uid`, not `me`. */
  it('names the resource and never the user in the snapshot routes', () => {
    const source = read('snapshots/index.ts')

    expect(source).not.toMatch(/'\/[^']*:uid/)
    expect(source).not.toMatch(/'\/[^']*\/me\b/)
  })
})
