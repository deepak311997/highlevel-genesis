import { z } from 'zod'

/**
 * Boundary schemas for everything HighLevel sends us.
 *
 * Parse, don't validate: each turns an `unknown` body into a typed value or
 * throws. All three were written against **recorded** sandbox responses rather
 * than the documentation — two of the shapes below are not what the docs imply.
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
 * The shape we want: scoped to one sub-account, and carrying its id. `locationId`
 * is required rather than optional, which is what makes the union useful — a
 * "Location" token without a location is not something we can act on.
 */
export const locationTokenSchema = z.object({
  ...tokenBase,
  userType: z.literal('Location'),
  locationId: z.string().min(1),
})

/**
 * An agency-level token, which the marketplace's own install button produces —
 * **no `locationId` at all**. Not an error in itself: it can be exchanged for a
 * location token. But it cannot read a contact, because contacts do not exist at
 * the agency level.
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
 * `GET /locations/{locationId}` — and **the response is wrapped**: `{ location,
 * traceId }`, not a bare location. Reading `.name` off the body yields `undefined`
 * and the panel renders a raw id where a name should be, with nothing erroring.
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
