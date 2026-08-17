import cors from 'cors'
import express, { type Express } from 'express'

import { authRouter } from '../auth'
import { filesRouter } from '../files'
import { errorHandler } from '../lib/errors'
import { hlRouter } from '../hl'
import { messagesRouter } from '../messages'
import { projectsRouter } from '../projects'
import { usersRouter } from '../users'
import { healthRouter } from './health'

/** Origins permitted when no ALLOWED_ORIGINS is configured — local dev only. */
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

/**
 * Decide per request, rather than resolving a list once at module scope.
 *
 * `createApiApp()` is called while the module is being loaded, and
 * `firebase deploy` loads and analyses the module *before* injecting
 * functions/.env — the same reason `getDb()` reads its config lazily. Resolving
 * the allowlist here would bake in whatever the environment looked like at
 * analysis time, which is nothing.
 *
 * Exact string match, no prefix or suffix logic: `https://evil-localhost:5173`
 * and `https://localhost:5173.evil.test` both contain the real origin and
 * neither is it.
 */
export function originAllowlist(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  // No Origin header at all — a same-origin request, curl, or a server-to-
  // server call. CORS has nothing to say about these.
  if (origin === undefined) {
    callback(null, true)
    return
  }

  const configured = (process.env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')

  const allowed = configured.length > 0 ? configured : DEFAULT_ORIGINS
  callback(null, allowed.includes(origin))
}

export function createApiApp(): Express {
  const app = express()

  app.use(cors({ origin: originAllowlist, credentials: false }))
  app.use(express.json({ limit: '1mb' }))

  // Mounted at both prefixes on purpose. The functions emulator strips the
  // function name, so the app sees `/health`; a Hosting rewrite of `/api/**`
  // forwards the original path, so the app sees `/api/health`.
  app.use('/', healthRouter)
  app.use('/api', healthRouter)
  app.use('/', authRouter)
  app.use('/api', authRouter)
  app.use('/', hlRouter)
  app.use('/api', hlRouter)
  app.use('/', usersRouter)
  app.use('/api', usersRouter)
  app.use('/', projectsRouter)
  app.use('/api', projectsRouter)
  // After `projectsRouter`, which owns the shorter paths under the same prefix.
  app.use('/', messagesRouter)
  app.use('/api', messagesRouter)
  app.use('/', filesRouter)
  app.use('/api', filesRouter)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'not_found' })
  })

  app.use(errorHandler)

  return app
}
