import { readFileSync } from 'node:fs'

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

let env: RulesTestEnvironment

/**
 * The suite's own emulator, not the development one.
 *
 * `npm run test:rules` starts Firestore on firebase.test.json's port; this has
 * to follow it there. The default is that same test port rather than the dev
 * default of 8080, because the failure mode is asymmetric: pointed at a dev
 * emulator this file loads its rules over that session's and then calls
 * `clearFirestore()` on it, wiping the data. Refusing to connect is a far
 * better outcome, and that is what the wrong port now gets you.
 */
const FIRESTORE_PORT = Number(process.env['FIRESTORE_EMULATOR_PORT_CLIENT'] ?? '8180')

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-genesis',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: FIRESTORE_PORT,
    },
  })
})

beforeEach(async () => {
  await env.clearFirestore()
})

afterAll(async () => {
  await env?.cleanup()
})

/**
 * `@firebase/rules-unit-testing` hands back a v8-compat Firestore instance.
 * The modular `doc()` and friends accept it at runtime but not at the type
 * level, so the bridge is asserted once here rather than at every call site.
 */
function asModular(db: unknown): Firestore {
  return db as Firestore
}

/**
 * A signed-in user who has confirmed their address.
 *
 * `email_verified` is a token claim, so the rules can enforce the verification
 * gate rather than trusting the router to. Note the default below: an
 * `authenticatedContext` with no claims is *unverified*, which is exactly the
 * state a freshly signed-up attacker is in.
 */
function verified(uid: string): Firestore {
  return asModular(env.authenticatedContext(uid, { email_verified: true }).firestore())
}

function unverified(uid: string): Firestore {
  return asModular(env.authenticatedContext(uid, { email_verified: false }).firestore())
}

/** A complete, valid profile document. */
function profile() {
  return {
    email: 'alice@example.test',
    displayName: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}

/** Seed a document past the rules, so update and delete have something to act on. */
async function seedProfile(uid = 'alice'): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(asModular(ctx.firestore()), `users/${uid}`), {
      email: 'alice@example.test',
      displayName: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })
}

describe('users/{uid} — the owner', () => {
  it('lets a verified owner create their profile', async () => {
    await assertSucceeds(setDoc(doc(verified('alice'), 'users/alice'), profile()))
  })

  it('lets a verified owner read their profile', async () => {
    await seedProfile()

    await assertSucceeds(getDoc(doc(verified('alice'), 'users/alice')))
  })

  it('lets a verified owner change their display name', async () => {
    await seedProfile()

    await assertSucceeds(
      updateDoc(doc(verified('alice'), 'users/alice'), {
        displayName: 'Alice',
        updatedAt: serverTimestamp(),
      }),
    )
  })
})

// The denial cases are the ones that matter — an allow test passes even when
// the rules are wide open.
describe('users/{uid} — denials', () => {
  it('denies a different signed-in user, however verified they are', async () => {
    await seedProfile()
    const mallory = verified('mallory')

    await assertFails(getDoc(doc(mallory, 'users/alice')))
    await assertFails(setDoc(doc(mallory, 'users/alice'), profile()))
  })

  it('denies an unauthenticated caller', async () => {
    await seedProfile()
    const anon = asModular(env.unauthenticatedContext().firestore())

    await assertFails(getDoc(doc(anon, 'users/alice')))
    await assertFails(setDoc(doc(anon, 'users/alice'), profile()))
  })

  /**
   * The gate that makes the router's blocking screen more than a courtesy. A
   * pre-hijacked account — one an attacker registered at someone else's address
   * — sits in exactly this state, and it can reach nothing.
   */
  it('denies the owner while their address is unverified', async () => {
    await seedProfile()
    const alice = unverified('alice')

    await assertFails(getDoc(doc(alice, 'users/alice')))
    await assertFails(setDoc(doc(alice, 'users/alice'), profile()))
  })

  it('denies a create carrying a key outside the allowlist', async () => {
    await assertFails(
      setDoc(doc(verified('alice'), 'users/alice'), { ...profile(), role: 'admin' }),
    )
  })

  it('denies a create that backdates createdAt', async () => {
    await assertFails(
      setDoc(doc(verified('alice'), 'users/alice'), {
        ...profile(),
        createdAt: new Date('2000-01-01'),
      }),
    )
  })

  it('denies an update that rewrites the email', async () => {
    await seedProfile()

    await assertFails(
      updateDoc(doc(verified('alice'), 'users/alice'), {
        email: 'attacker@example.test',
        updatedAt: serverTimestamp(),
      }),
    )
  })

  it('denies an update that rewrites createdAt', async () => {
    await seedProfile()

    await assertFails(
      updateDoc(doc(verified('alice'), 'users/alice'), {
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })

  it('denies an update that adds an unknown key', async () => {
    await seedProfile()

    await assertFails(
      updateDoc(doc(verified('alice'), 'users/alice'), {
        plan: 'enterprise',
        updatedAt: serverTimestamp(),
      }),
    )
  })

  it('denies an update that skips updatedAt, so writes are always stamped', async () => {
    await seedProfile()

    await assertFails(updateDoc(doc(verified('alice'), 'users/alice'), { displayName: 'Alice' }))
  })

  it('denies the owner deleting their own profile', async () => {
    await seedProfile()

    await assertFails(deleteDoc(doc(verified('alice'), 'users/alice')))
  })
})

describe('server-only collections', () => {
  /*
   * Re-asserted in Slice 2, because this is the slice where the document stops
   * being hypothetical: it now holds a live HighLevel access token and a
   * refresh token, scoped to a whole CRM location.
   *
   * The owner case is the one that matters and the one people skip. It is
   * tempting to let a user read their own connection — but a token readable by
   * the browser is a token readable by anyone who opens devtools, and this
   * denial is what makes `GET /api/hl/connection` the only window onto it.
   */
  it('denies even a verified owner reading their own HighLevel tokens', async () => {
    const alice = verified('alice')

    await assertFails(getDoc(doc(alice, 'hlConnections/alice')))
  })

  it('denies a verified owner writing their own connection', async () => {
    const alice = verified('alice')

    await assertFails(
      setDoc(doc(alice, 'hlConnections/alice'), {
        accessToken: 'live-access-token',
        refreshToken: 'live-refresh-token',
        locationId: 'lUanVn0CtZJTlymH8ySo',
        needsReconnect: false,
      }),
    )
  })

  it('denies a stranger and an anonymous client alike', async () => {
    const bob = verified('bob')
    const anon = asModular(env.unauthenticatedContext().firestore())

    await assertFails(getDoc(doc(bob, 'hlConnections/alice')))
    await assertFails(setDoc(doc(bob, 'hlConnections/alice'), { accessToken: 'x' }))
    await assertFails(getDoc(doc(anon, 'hlConnections/alice')))
  })

  it('denies deleting a connection — disconnect goes through the endpoint', async () => {
    await assertFails(deleteDoc(doc(verified('alice'), 'hlConnections/alice')))
  })

  it('denies every client the throttle counters', async () => {
    const alice = verified('alice')
    const anon = asModular(env.unauthenticatedContext().firestore())

    await assertFails(getDoc(doc(alice, 'authThrottle/email:abc')))
    await assertFails(setDoc(doc(alice, 'authThrottle/email:abc'), { count: 0 }))
    await assertFails(getDoc(doc(anon, 'authThrottle/email:abc')))
  })
})

describe('unknown collections', () => {
  it('denies anything without an explicit rule', async () => {
    const alice = verified('alice')

    await assertFails(getDoc(doc(alice, 'projects/anything')))
    await assertFails(setDoc(doc(alice, 'somethingNew/doc'), { a: 1 }))
  })
})
