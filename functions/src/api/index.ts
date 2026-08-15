import cors from 'cors'
import express, { type Express } from 'express'

import { errorHandler } from '../lib/errors'
import { healthRouter } from './health'

export function createApiApp(): Express {
  const app = express()

  app.use(cors({ origin: true }))
  app.use(express.json({ limit: '1mb' }))

  // Mounted at both prefixes on purpose. The functions emulator strips the
  // function name, so the app sees `/health`; a Hosting rewrite of `/api/**`
  // forwards the original path, so the app sees `/api/health`.
  app.use('/', healthRouter)
  app.use('/api', healthRouter)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'not_found' })
  })

  app.use(errorHandler)

  return app
}
