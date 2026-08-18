import type { Request, Response } from 'express'

import { buildAuthorizeUrl } from './authorize'
import { hlRedirectUri } from './config'
import { logHlOAuthEvent } from '../lib/log'
import { sealState } from './state'

/**
 * `POST /api/hl/connect` — hand the browser somewhere to go.
 *
 * One URL, which makes this look trivial. It is not: the URL carries a `state`
 * binding this caller's uid, and the callback will write a HighLevel connection
 * against whatever uid that state names. The uid is a parameter rather than
 * something this function looks up, so there is no version of it that runs without
 * having been authorised.
 *
 * The line it logs pairs with `hl.callback.received`'s. This end builds the
 * `redirect_uri` for the authorize URL; the callback, a separate request minutes
 * later, sends one to the token endpoint — and if the two ever differ, HighLevel
 * refuses the exchange with a message the user never sees. Two lines carrying the
 * value each end actually used answer that in the log rather than by deduction.
 */
export function handleConnect(_req: Request, res: Response, uid: string): Promise<void> {
  const authorizeUrl = buildAuthorizeUrl(sealState(uid))

  logHlOAuthEvent('hl.connect.start', {
    step: 'connect',
    outcome: 'ok',
    endpoint: '/v2/oauth/chooselocation',
    redirectUri: hlRedirectUri(),
  })

  res.json({ authorizeUrl })
  return Promise.resolve()
}
