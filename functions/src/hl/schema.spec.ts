import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  installedLocationsSchema,
  locationDetailSchema,
  tokenResponseSchema,
} from './schema'

/**
 * Parsing what HighLevel actually sends.
 *
 * Every fixture here was recorded from the live sandbox, not written from the
 * docs. That distinction is the whole point: a hand-written fixture encodes our
 * *assumption* about a response, so tests built on it pass while the real
 * integration fails. Two of the shapes below were genuinely surprising.
 */

const FIXTURES = join(__dirname, '../../../tests/fixtures/highlevel')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
}

describe('tokenResponseSchema', () => {
  it('accepts a real Location token response', () => {
    const parsed = tokenResponseSchema.parse(fixture('token-response-location'))

    expect(parsed.userType).toBe('Location')
    expect(parsed.userType === 'Location' && parsed.locationId).toBe('lUanVn0CtZJTlymH8ySo')
    expect(parsed.expires_in).toBeGreaterThan(0)
  })

  /*
   * Recorded from an agency-wide install — the shape the marketplace's own
   * install button produces. It carries no `locationId` at all, which is the
   * detail the callback branches on.
   */
  it('accepts a real Company token response and reports no location', () => {
    const parsed = tokenResponseSchema.parse(fixture('token-response-company'))

    expect(parsed.userType).toBe('Company')
    expect(parsed).not.toHaveProperty('locationId')
    expect(parsed.userType === 'Company' && parsed.isBulkInstallation).toBe(true)
  })

  it('accepts the response a refresh returns', () => {
    expect(() => tokenResponseSchema.parse(fixture('refresh-response'))).not.toThrow()
  })

  it('rejects a Location token with no locationId, which we could not use', () => {
    const broken = { ...(fixture('token-response-location') as object), locationId: undefined }

    expect(() => tokenResponseSchema.parse(broken)).toThrow()
  })

  it.each(['access_token', 'refresh_token', 'expires_in'])(
    'rejects a response missing %s',
    (field) => {
      const broken: Record<string, unknown> = { ...(fixture('token-response-location') as object) }
      // Reflect, because the lint rule against dynamically computed deletes is
      // on and `field` comes from the it.each table.
      Reflect.deleteProperty(broken, field)

      expect(() => tokenResponseSchema.parse(broken)).toThrow()
    },
  )

  it('rejects an error body, which arrives with the same content type', () => {
    expect(() => tokenResponseSchema.parse(fixture('refresh-invalid-grant'))).toThrow()
  })

  /*
   * HighLevel adds fields over time — `appId` and `versionId` appear on the
   * location response and not the company one. Unknown keys are dropped rather
   * than rejected, so a new field is not an outage.
   */
  it('drops unknown fields instead of failing on them', () => {
    const withExtra = { ...(fixture('token-response-location') as object), somethingNew: true }

    expect(tokenResponseSchema.parse(withExtra)).not.toHaveProperty('somethingNew')
  })
})

describe('locationDetailSchema', () => {
  /*
   * The surprise: `GET /locations/{id}` does **not** return a bare location.
   * It wraps it — `{ location: {...}, traceId }` — so reading `.name` off the
   * response body yields undefined and the connection panel silently shows an
   * id instead of a name.
   */
  it('reads the name out of the wrapper HighLevel actually sends', () => {
    const parsed = locationDetailSchema.parse(fixture('location'))

    expect(parsed.location.name).toBe('India Square')
    expect(parsed.location.id).toBe('lUanVn0CtZJTlymH8ySo')
  })

  it('rejects an unwrapped location, so the wrapper cannot regress unnoticed', () => {
    expect(() => locationDetailSchema.parse({ id: 'x', name: 'y' })).toThrow()
  })
})

describe('installedLocationsSchema', () => {
  it('lists the sub-accounts an agency-wide install covers', () => {
    const parsed = installedLocationsSchema.parse({
      locations: [{ _id: 'lUanVn0CtZJTlymH8ySo', name: 'India Square', isInstalled: true }],
      count: 1,
    })

    expect(parsed.locations).toHaveLength(1)
    expect(parsed.locations[0]?._id).toBe('lUanVn0CtZJTlymH8ySo')
  })

  it('accepts an empty list, which means the install covers nothing usable', () => {
    expect(installedLocationsSchema.parse({ locations: [] }).locations).toHaveLength(0)
  })
})
