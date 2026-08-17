import type { DocumentSnapshot } from 'firebase-admin/firestore'
import { Timestamp } from 'firebase-admin/firestore'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseStored } from './handlers'

/**
 * The parse-or-log-and-drop step, on its own.
 *
 * Every route that reads a project goes through this, and the three outcomes it
 * has to keep apart are easy to conflate: an absent document is *not*
 * corruption, a document that fails to parse is, and a usable one is neither.
 *
 * The log line is the part worth a test of its own. AC-20 asks for a
 * `project.unreadable` event, and a corrupt project is otherwise **silent** by
 * design — it is omitted from the list and 404 by id, which from the outside is
 * indistinguishable from one that was deleted. The log line is the only thing
 * that says a document is broken rather than gone, so it is the only warning
 * anybody will ever get.
 */

const complete = {
  name: 'Contact dashboard',
  description: null,
  locationId: null,
  createdAt: Timestamp.fromMillis(1_700_000_000_000),
  updatedAt: Timestamp.fromMillis(1_700_000_500_000),
  deletedAt: null,
}

/** Only the three members `parseStored` touches. */
function snapshot(exists: boolean, data: unknown): DocumentSnapshot {
  return { exists, id: 'proj-1', data: () => data } as unknown as DocumentSnapshot
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseStored', () => {
  it('returns the parsed document when it is usable', () => {
    const parsed = parseStored(snapshot(true, complete))

    expect(parsed?.name).toBe('Contact dashboard')
  })

  /** AC-20's third clause. */
  it('logs project.unreadable and returns null for a document that cannot be parsed', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseStored(snapshot(true, { description: 'no name here' }))).toBeNull()

    expect(info).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(logged['event']).toBe('project.unreadable')
    expect(logged['outcome']).toBe('invalid')
  })

  /*
   * No field of the document reaches the log line. The names are the user's
   * words and the description may be anything they typed; a log sink is a
   * disclosure channel like any other.
   */
  it('puts no field of the document in the log line', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    parseStored(snapshot(true, { description: 'a secret the user typed', locationId: 'loc_123' }))

    const line = String(info.mock.calls[0]?.[0])
    expect(line).not.toContain('a secret the user typed')
    expect(line).not.toContain('loc_123')
  })

  /* An absent document is not corruption, and logging it as such would fill the
   * sink with every 404 a probing client can produce. */
  it('returns null without logging for an absent document', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(parseStored(snapshot(false, undefined))).toBeNull()

    expect(info).not.toHaveBeenCalled()
  })
})
