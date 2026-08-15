#!/usr/bin/env node
/**
 * Flip a user's `emailVerified` flag, for exercising the verification gate.
 *
 *   node scripts/set-verified.mjs alice@example.test false
 *   node scripts/set-verified.mjs alice@example.test true
 *   node scripts/set-verified.mjs alice@example.test false --live   # real project
 *
 * Defaults to the emulator and requires `--live` to touch the real project,
 * for the same reason the rest of this repo does: the destructive-by-accident
 * direction should be the one you have to ask for. `--live` also needs
 * application-default credentials (`gcloud auth application-default login`).
 *
 * Plain .mjs rather than .ts so it runs with no build step and no runner. It
 * is a developer tool, not shipped code, and is outside the typechecked tree.
 */
import { readFileSync } from 'node:fs'

import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

const [email, rawValue, ...flags] = process.argv.slice(2)
const live = flags.includes('--live')

if (!email || (rawValue !== 'true' && rawValue !== 'false')) {
  console.error('usage: node scripts/set-verified.mjs <email> <true|false> [--live]')
  process.exit(1)
}

const emailVerified = rawValue === 'true'

const projectId = live
  ? JSON.parse(readFileSync(new URL('../.firebaserc', import.meta.url), 'utf8')).projects.default
  : 'demo-genesis'

if (!live) {
  // Set before the Admin SDK initialises, or it reaches for real credentials.
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099'
} else if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error(
    'FIREBASE_AUTH_EMULATOR_HOST is set, so --live would still hit the emulator. Unset it.',
  )
  process.exit(1)
}

initializeApp({ projectId })
const auth = getAuth()

try {
  const user = await auth.getUserByEmail(email)
  if (user.emailVerified === emailVerified) {
    console.log(`${email} is already emailVerified=${String(emailVerified)} — nothing to do.`)
    process.exit(0)
  }

  await auth.updateUser(user.uid, { emailVerified })
  console.log(
    `${live ? 'LIVE' : 'emulator'} · ${email} · emailVerified: ` +
      `${String(user.emailVerified)} → ${String(emailVerified)}`,
  )

  if (!emailVerified) {
    // `email_verified` travels inside the ID token, and Firestore rules read it
    // from there. A browser already holding a token keeps the old claim until
    // it refreshes — up to an hour — so the app will not notice on its own.
    await auth.revokeRefreshTokens(user.uid)
    console.log('  refresh tokens revoked — sign out and back in to see the gate')
  }
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : ''
  if (code === 'auth/user-not-found') {
    console.error(`no account for ${email} on ${live ? projectId : 'the emulator'}`)
  } else {
    console.error(err instanceof Error ? err.message : String(err))
  }
  process.exit(1)
}
