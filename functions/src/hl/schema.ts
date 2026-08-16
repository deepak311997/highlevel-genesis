import { z } from 'zod'

/**
 * Boundary schemas for everything HighLevel sends us.
 *
 * Parse, don't validate: each of these turns an `unknown` response body into a
 * typed value or throws, so nothing downstream branches on a field it has not
 * proved exists. All three were written against **recorded** responses from the
 * sandbox rather than from the documentation, which matters more than it
 * sounds — two of the shapes below are not what the docs imply.
 */

/** Fields both token shapes carry. */
const tokenBase = {
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().min(1),
  scope: z.string(),
  companyId: z.string().min(1),
  userId: z.string().optional(),
}

/**
 * The shape we want: scoped to one sub-account, and carrying the id of it.
 *
 * `locationId` is required here rather than optional, which is what makes the
 * discriminated union below useful — a "Location" token without a location is
 * not a thing we can act on, and failing at the boundary beats discovering it
 * three calls later.
 */
export const locationTokenSchema = z.object({
  ...tokenBase,
  userType: z.literal('Location'),
  locationId: z.string().min(1),
})

/**
 * An agency-level token, which is what the marketplace's own install button
 * produces — `isBulkInstallation: true`, and **no `locationId` at all**.
 *
 * Not an error in itself: it can be exchanged for a location token through
 * `/oauth/locationToken`. But it cannot read a contact, because contacts do not
 * exist at the agency level.
 */
export const companyTokenSchema = z.object({
  ...tokenBase,
  userType: z.literal('Company'),
  isBulkInstallation: z.boolean().optional(),
  approveAllLocations: z.boolean().optional(),
})

export const tokenResponseSchema = z.discriminatedUnion('userType', [
  locationTokenSchema,
  companyTokenSchema,
])

/**
 * `GET /locations/{locationId}`.
 *
 * **The response is wrapped.** It is `{ location: { … }, traceId }`, not a bare
 * location object — so reading `.name` off the body yields `undefined`, and the
 * connection panel quietly renders a raw id where a name should be. Nothing
 * errors; the only symptom is a worse-looking screen. Requiring the wrapper here
 * turns that into a parse failure instead.
 */
export const locationDetailSchema = z.object({
  location: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
})

/**
 * `GET /oauth/installedLocations` — the sub-accounts an agency-wide install
 * actually covers. `_id`, not `id`, on these.
 */
export const installedLocationsSchema = z.object({
  locations: z.array(
    z.object({
      _id: z.string().min(1),
      name: z.string().optional(),
      isInstalled: z.boolean().optional(),
    }),
  ),
})

export type TokenResponse = z.infer<typeof tokenResponseSchema>
export type LocationToken = z.infer<typeof locationTokenSchema>
export type LocationDetail = z.infer<typeof locationDetailSchema>
export type InstalledLocations = z.infer<typeof installedLocationsSchema>
