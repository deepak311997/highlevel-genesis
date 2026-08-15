import { Router } from 'express'

import { asyncHandler, HttpError } from '../lib/errors'
import { getDb } from '../lib/firebase'

export const healthRouter: Router = Router()

/**
 * Vertical proof for Slice 0: browser → function → Firestore → back.
 *
 * Writes a throwaway document, reads it back, deletes it, and reports the
 * timings. Anything that breaks the wiring — wrong project id, emulator not
 * running, Admin SDK misconfigured — fails here rather than three slices later.
 */
healthRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const started = Date.now()
    const ref = getDb().collection('_health').doc()

    const writeStarted = Date.now()
    await ref.set({ createdAt: new Date().toISOString() })
    const writeMs = Date.now() - writeStarted

    const readStarted = Date.now()
    const snapshot = await ref.get()
    const readMs = Date.now() - readStarted

    await ref.delete()

    if (!snapshot.exists) {
      throw new HttpError(
        500,
        'Wrote a health document but could not read it back',
        'read_after_write',
      )
    }

    res.json({
      ok: true,
      docId: ref.id,
      writeMs,
      readMs,
      roundTripMs: Date.now() - started,
      serverTime: new Date().toISOString(),
    })
  }),
)
