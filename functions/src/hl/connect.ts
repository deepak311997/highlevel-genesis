import type { Request, Response } from 'express'

import { buildAuthorizeUrl } from './authorize'
import { sealState } from './state'

/**
 * `POST /api/hl/connect` — hand the browser somewhere to go.
 *
 * The response is one URL, which makes this look like a trivial endpoint. It is
 * not: the URL carries a `state` binding this caller's uid, and the callback
 * will write a HighLevel connection against whatever uid that state names. So
 * the authorisation performed *before* this runs is the whole point of the
 * endpoint, and it is why the route is wrapped in `withVerifiedUser` rather
 * than reading a uid from the request body.
 *
 * The uid is a parameter rather than something this function looks up, so
 * there is no version of it that runs without having been authorised.
 */
export function handleConnect(_req: Request, res: Response, uid: string): Promise<void> {
  res.json({ authorizeUrl: buildAuthorizeUrl(sealState(uid)) })
  return Promise.resolve()
}
