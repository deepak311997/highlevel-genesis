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
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OFFSET = 100

const config = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'))

const emulators = config.emulators ?? {}
for (const [name, block] of Object.entries(emulators)) {
  if (block !== null && typeof block === 'object' && typeof block.port === 'number') {
    emulators[name] = { ...block, port: block.port + OFFSET }
  }
}

/*
 * The hub and the logging emulator are started by the CLI whether or not
 * firebase.json mentions them, so they need moving too — and not by OFFSET.
 * Their defaults are 4400 and 4500, so a +100 shift would put the hub on the
 * logging emulator's port and collide with the very session this exists to
 * avoid. They get their own range instead.
 */
emulators.hub = { port: 4700 }
emulators.logging = { port: 4800 }
config.emulators = emulators

writeFileSync(join(ROOT, 'firebase.test.json'), JSON.stringify(config, null, 2) + '\n')

const ports = Object.entries(emulators)
  .filter(([, block]) => typeof block?.port === 'number')
  .map(([name, block]) => `${name}:${block.port}`)
  .join(' ')
console.log(`firebase.test.json written — ${ports}`)
