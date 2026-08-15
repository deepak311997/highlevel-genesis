import { setGlobalOptions } from 'firebase-functions/v2'
import { onRequest } from 'firebase-functions/v2/https'

import { createApiApp } from './api'

setGlobalOptions({ region: 'asia-south1', maxInstances: 10 })

/**
 * Short-lived request/response endpoints: OAuth callback, HighLevel proxy,
 * anything security rules cannot express. Fast cold start, small memory.
 */
export const api = onRequest({ timeoutSeconds: 60, memory: '256MiB' }, createApiApp())

/**
 * The streaming endpoint lives in its own function so it can carry a long
 * timeout and a warm instance without the CRUD endpoints paying for either.
 */
export { generate } from './generate'
