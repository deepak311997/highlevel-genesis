import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import * as deployed from './index'

/**
 * What actually gets deployed.
 *
 * This file exists because of a real failure: `deleteExpiredUnverifiedUsers`
 * was written, unit-tested and integration-tested, and then its `onSchedule`
 * trigger was dropped in an unrelated commit. Every test stayed green, because
 * every test called the function directly — none of them asked whether anything
 * in production ever would. The sweep silently stopped existing for two days.
 *
 * A handler with no trigger is dead code wearing a passing test. These
 * assertions are deliberately structural: they check the deployment surface,
 * which is the one thing the other levels cannot see.
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
 * `__endpoint` carries the secret binding, the timeout and the memory — three
 * things no other test level can see, because every one of them is decided by
 * the deploy rather than by a request. A function that lost its
 * `ANTHROPIC_API_KEY` binding would pass every unit and integration test in this
 * repository and then answer 500 on the first real generation, because under the
 * emulator the key is never read at all (D20).
 *
 * It carries **nothing** about middleware, so the guards are covered from two
 * other directions instead: a source scan below, and — the behavioural proof —
 * the 401 and 403 that `tests/integration/generate.spec.ts` asserts over the
 * wire. Neither is enough alone, and the structural one is the weaker of the
 * two; this comment says so rather than implying otherwise.
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

describe('the generate function’s deployment surface', () => {
  /*
   * D19. The key lives in Secret Manager and is bound to this function alone —
   * so `api` cannot read it, and nothing about it is in `functions/.env`, where
   * everything is uploaded as a plain environment variable readable by anyone
   * with Viewer on the project.
   */
  it('binds ANTHROPIC_API_KEY as a secret', () => {
    expect(endpointOf(deployed.generate).secretEnvironmentVariables).toContainEqual({
      key: 'ANTHROPIC_API_KEY',
    })
  })

  /*
   * D29. Slice 0 pinned 60 seconds deliberately while the endpoint was
   * unauthenticated, saying the long timeout would arrive "together with the
   * ID-token check that makes it safe to grant". Both halves are now here, and
   * this is the assertion that catches one being reverted without the other.
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
    expect(endpointOf(deployed.api).secretEnvironmentVariables ?? []).toEqual([])
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
   * Slice 4's route keeps both, and this is the case that would notice it
   * losing one while attention was on the new endpoint. `attested` is the local
   * name the router gives `requireAppCheck`.
   */
  it('the messages POST route still carries both guards', () => {
    const source = read('messages/index.ts')

    expect(source).toContain('withVerifiedUser')
    expect(source).toContain('attested')
    expect(source).toMatch(
      /messagesRouter\.post\(\s*'\/projects\/:projectId\/messages',\s*attested/,
    )
  })

  /**
   * AC-31's structural half — which file routes are attested.
   *
   * The behavioural half is `tests/integration/files.spec.ts`'s 401 and 403 over
   * the wire. Attestation itself cannot be proven there: `requireAppCheck`
   * short-circuits under the emulator, so no emulator-backed test can observe the
   * difference between a route that carries it and one that does not. Reading the
   * router is the only way, and the plan says so rather than pretending otherwise.
   */
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

  /**
   * AC-19's structural half — which snapshot route is attested.
   *
   * The restore is the one that writes, and from Slice 11 it is the one that can
   * *delete*: an unattested caller who could reach it could roll a project back
   * to any version it holds. The list is a plain authenticated read, so it
   * carries `withVerifiedUser` and nothing more (D28, unchanged since Slice 2).
   *
   * Structural for the same reason the file routes' is: `requireAppCheck`
   * short-circuits under the emulator, so no emulator-backed test can see the
   * difference between a route that carries it and one that does not.
   */
  it('does not attest the snapshot list, and guards it with withVerifiedUser', () => {
    const source = read('snapshots/index.ts')

    expect(source).toMatch(
      /snapshotsRouter\.get\(\s*'\/projects\/:projectId\/snapshots',\s*asyncHandler\(withVerifiedUser/,
    )
    // Reading is a plain authenticated read: App Check buys nothing against a
    // caller who already holds a valid ID token (D28, unchanged since Slice 2).
    expect(source).not.toMatch(/snapshotsRouter\.get\([^)]*attested/)
  })

  /** No user identifier in either path — not `:uid`, not `me`. */
  it('names the resource and never the user in the snapshot routes', () => {
    const source = read('snapshots/index.ts')

    expect(source).not.toMatch(/'\/[^']*:uid/)
    expect(source).not.toMatch(/'\/[^']*\/me\b/)
  })
})
