#!/usr/bin/env node
/**
 * Generate `firebase.test.json` — the same project, on a second set of ports.
 *
 * Without it, running the suite kills a development session: `npm run dev`
 * holds 9099, 8080 and 5001, and the emulators refuse to start a second time on
 * the same ports. That turned "run the tests" into "stop what you are doing
 * first", which is a bad trade several times an hour.
 *
 * **Generated rather than committed, on purpose.** A hand-maintained second
 * config drifts: someone edits `firestore.rules`' path, or the functions
 * codebase, or adds an emulator, and the copy silently keeps testing the old
 * shape. Deriving it means the only difference from `firebase.json` is the port
 * numbers, by construction.
 *
 * Ports are the defaults plus 100, which keeps them mentally adjacent (5001 →
 * 5101) and clear of anything else on the machine.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The default band. A second checkout of this repo — an autopilot track running
 * its own slice on the same machine — needs a different one, because the ports
 * are the only thing two clones genuinely share and a constant here made them
 * share by construction: the second suite to start dies with "Could not start
 * emulator hub, port taken", which reads as a red suite and says nothing about
 * the code. `EMULATOR_PORT_OFFSET` moves the whole band; the settings below move
 * the two ports that sit outside it.
 */
export const OFFSET = Number(process.env['EMULATOR_PORT_OFFSET'] ?? 100)

/**
 * The hub and the logging emulator are started by the CLI whether or not
 * firebase.json mentions them, so they need moving too — and not by OFFSET.
 * Their defaults are 4400 and 4500, so a +100 shift would put the hub on the
 * logging emulator's port and collide with the very session this exists to
 * avoid. They get their own range, and it is stated rather than derived: a
 * formula that looked tidy would eventually walk one checkout's band onto
 * another's, which is the exact failure this whole mechanism exists to prevent.
 */
export const HUB_PORT = Number(process.env['EMULATOR_HUB_PORT'] ?? 4700)
export const LOGGING_PORT = Number(process.env['EMULATOR_LOGGING_PORT'] ?? 4800)

/**
 * Firestore serves its long-poll channel on a second socket, whose port
 * `firebase.json` does not have to declare — the CLI defaults it to 9150. That
 * default is the one port a `+100 on everything declared` rule cannot reach,
 * so the suite kept sharing it with a development session. The CLI will hunt
 * for a free port when the value is left implicit, but that hunt races: it
 * probes, finds the neighbouring port free, and hands it to a Firestore process
 * that then cannot bind it, killing the whole emulator set at startup. Naming
 * the port makes it fixed and moves it out of the dev session's way.
 */
export const DEFAULT_FIRESTORE_WEBSOCKET_PORT = 9150

/**
 * Return `config` with every emulator port moved into the test range. Pure —
 * the config passed in is not touched.
 */
export function shiftPorts(config, options = {}) {
  const { offset = OFFSET, hubPort = HUB_PORT, loggingPort = LOGGING_PORT } = options
  const emulators = { ...(config.emulators ?? {}) }

  for (const [name, block] of Object.entries(emulators)) {
    if (block !== null && typeof block === 'object' && typeof block.port === 'number') {
      emulators[name] = { ...block, port: block.port + offset }
    }
  }

  emulators.firestore = {
    ...emulators.firestore,
    websocketPort:
      (config.emulators?.firestore?.websocketPort ?? DEFAULT_FIRESTORE_WEBSOCKET_PORT) + offset,
  }

  emulators.hub = { port: hubPort }
  emulators.logging = { port: loggingPort }

  return { ...config, emulators }
}

// Guarded so importing this module from the spec does not rewrite the config.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const source = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'))
  const config = shiftPorts(source)

  writeFileSync(join(ROOT, 'firebase.test.json'), JSON.stringify(config, null, 2) + '\n')

  const ports = Object.entries(config.emulators)
    .filter(([, block]) => typeof block?.port === 'number')
    .flatMap(([name, block]) =>
      typeof block.websocketPort === 'number'
        ? [`${name}:${block.port}`, `${name}-ws:${block.websocketPort}`]
        : [`${name}:${block.port}`],
    )
    .join(' ')
  console.log(`firebase.test.json written — ${ports}`)
}
