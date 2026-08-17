import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_FIRESTORE_WEBSOCKET_PORT,
  OFFSET,
  shiftPorts,
} from './test-emulator-config.mjs'

/**
 * The generated config's whole job is to be reachable while a `npm run dev`
 * session holds the default ports. A port the generator forgets is a port the
 * suite shares with that session — which surfaces as an emulator dying at
 * startup, a long way from the omission that caused it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const firebaseJson = () => ({
  firestore: { database: 'hl-genesis', rules: 'firestore.rules' },
  emulators: {
    _comment: 'Test-only.',
    auth: { port: 9099 },
    functions: { port: 5001 },
    firestore: { port: 8080 },
    ui: { enabled: true, port: 4000 },
    singleProjectMode: true,
  },
})

/** Every port the generated config names, whatever its key. */
function allPorts(emulators) {
  return Object.values(emulators).flatMap((block) =>
    block !== null && typeof block === 'object'
      ? Object.entries(block)
          .filter(([key, value]) => /[Pp]ort$/.test(key) && typeof value === 'number')
          .map(([, value]) => value)
      : [],
  )
}

describe('shiftPorts', () => {
  it('moves every declared emulator port by the offset', () => {
    const { emulators } = shiftPorts(firebaseJson())

    expect(emulators.auth.port).toBe(9199)
    expect(emulators.functions.port).toBe(5101)
    expect(emulators.firestore.port).toBe(8180)
    expect(emulators.ui.port).toBe(4100)
  })

  it('keeps the settings that are not ports', () => {
    const { emulators, firestore } = shiftPorts(firebaseJson())

    expect(emulators.ui.enabled).toBe(true)
    expect(emulators.singleProjectMode).toBe(true)
    expect(emulators._comment).toBe('Test-only.')
    expect(firestore.rules).toBe('firestore.rules')
  })

  it('gives the hub and the logging emulator their own range', () => {
    const { emulators } = shiftPorts(firebaseJson())

    expect(emulators.hub.port).toBe(4700)
    expect(emulators.logging.port).toBe(4800)
  })

  it("moves Firestore's websocket port, which firebase.json never declares", () => {
    const { emulators } = shiftPorts(firebaseJson())

    expect(emulators.firestore.websocketPort).toBe(DEFAULT_FIRESTORE_WEBSOCKET_PORT + OFFSET)
  })

  it('moves a websocket port that firebase.json does declare, from that value', () => {
    const source = firebaseJson()
    source.emulators.firestore.websocketPort = 9300

    expect(shiftPorts(source).emulators.firestore.websocketPort).toBe(9400)
  })

  it('leaves the config it was given untouched', () => {
    const source = firebaseJson()
    shiftPorts(source)

    expect(source.emulators.firestore).toEqual({ port: 8080 })
    expect(source.emulators.hub).toBeUndefined()
  })

  it("gives the repo's own firebase.json a distinct port for every emulator", () => {
    const source = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'))
    const ports = allPorts(shiftPorts(source).emulators)

    expect(ports.length).toBeGreaterThan(0)
    expect(new Set(ports).size).toBe(ports.length)
  })
})

/**
 * A second checkout of this repo runs its own suite on the same machine — two
 * autopilot tracks, one slice each. Ports are the only thing two clones
 * genuinely share, and they shared them by construction: the offset was a
 * constant, so every checkout computed the identical set and the second run to
 * start died with "Could not start emulator hub, port taken". That reads as a
 * red suite and says nothing about the code.
 *
 * The band is therefore selectable per checkout. Hub and logging are settings
 * rather than arithmetic: their defaults were picked to clear a `npm run dev`
 * session, and a tidy-looking formula would walk one band onto another's.
 */
describe('a second checkout gets its own band', () => {
  it('shifts every declared port by the offset it is given', () => {
    const { emulators } = shiftPorts(firebaseJson(), { offset: 300 })

    expect(emulators.auth.port).toBe(9399)
    expect(emulators.functions.port).toBe(5301)
    expect(emulators.firestore.port).toBe(8380)
    expect(emulators.ui.port).toBe(4300)
    expect(emulators.firestore.websocketPort).toBe(DEFAULT_FIRESTORE_WEBSOCKET_PORT + 300)
  })

  it('takes hub and logging as their own settings', () => {
    const { emulators } = shiftPorts(firebaseJson(), { hubPort: 4900, loggingPort: 5000 })

    expect(emulators.hub.port).toBe(4900)
    expect(emulators.logging.port).toBe(5000)
  })

  it('keeps the committed defaults when given nothing', () => {
    const { emulators } = shiftPorts(firebaseJson())

    expect(emulators.auth.port).toBe(9099 + OFFSET)
    expect(emulators.hub.port).toBe(4700)
    expect(emulators.logging.port).toBe(4800)
  })

  it('shares no port between two checkouts on different bands', () => {
    const source = () => JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'))

    const first = allPorts(shiftPorts(source()).emulators)
    const second = allPorts(
      shiftPorts(source(), { offset: 300, hubPort: 4900, loggingPort: 5000 }).emulators,
    )

    expect(first).not.toHaveLength(0)
    expect(second).not.toHaveLength(0)
    expect(first.filter((port) => second.includes(port))).toEqual([])
  })
})
