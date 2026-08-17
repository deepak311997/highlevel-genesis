import { readFileSync } from 'node:fs'

import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

/**
 * The backstop, and nothing but the backstop.
 *
 * Data access is API-only: every read and write goes through a Cloud Function
 * route that verifies the ID token, parses the payload with Zod, and scopes the
 * query by the uid **from the token**. `firestore.rules` is what makes a mistake
 * in one of those routes a bug rather than a breach — so after Slice 2b every
 * match block in the file is a denial, and **every case in this suite is an
 * `assertFails`**.
 *
 * That is why there is no `assertSucceeds` import. A suite with allow-cases in
 * it would be describing an enforcement boundary that no longer exists here, and
 * the next reader would have to work out which of the two files was in charge.
 */

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
 * A signed-in user who has confirmed their address — the *most* privileged
 * client there is. Everything below denies even them, which is the point: the
 * claim buys access to the API, not to the database.
 */
function verified(uid: string): Firestore {
  return asModular(env.authenticatedContext(uid, { email_verified: true }).firestore())
}

function anonymous(): Firestore {
  return asModular(env.unauthenticatedContext().firestore())
}

/** A complete, valid profile document — as a payload for a write that must fail. */
function profile() {
  return {
    email: 'alice@example.test',
    displayName: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

/**
 * Seed past the rules, so update and delete have something to be denied *on*.
 *
 * Still needed even though nothing succeeds: a denied update against a document
 * that does not exist proves less than a denied update against one that does.
 */
async function seedProfile(uid = 'alice'): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(asModular(ctx.firestore()), `users/${uid}`), profile())
  })
}

describe('users/{uid} — denied to its own owner', () => {
  /** AC-12. The owner reads their profile through `GET /api/profile`. */
  it('denies a verified owner reading their own profile', async () => {
    await seedProfile()

    await assertFails(getDoc(doc(verified('alice'), 'users/alice')))
  })

  /*
   * AC-13. Creating, changing and removing all belong to the API now.
   *
   * These two send exactly the payload the *old* owner-scoped rules accepted —
   * a create stamped `serverTimestamp()`, and an update touching only
   * `displayName` and `updatedAt`. Written any other way they would pass against
   * the old rules too, for reasons that have nothing to do with this change, and
   * would prove nothing about the deny-all that replaced them.
   */
  it('denies a verified owner creating their own profile', async () => {
    await assertFails(
      setDoc(doc(verified('alice'), 'users/alice'), {
        email: 'alice@example.test',
        displayName: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })

  it('denies a verified owner updating their own profile', async () => {
    await seedProfile()

    await assertFails(
      updateDoc(doc(verified('alice'), 'users/alice'), {
        displayName: 'Alice',
        updatedAt: serverTimestamp(),
      }),
    )
  })

  it('denies a verified owner deleting their own profile', async () => {
    await seedProfile()

    await assertFails(deleteDoc(doc(verified('alice'), 'users/alice')))
  })
})

describe('users/{uid} — denied to everyone else', () => {
  /** AC-14. */
  it('denies a different signed-in user, however verified they are', async () => {
    await seedProfile()
    const mallory = verified('mallory')

    await assertFails(getDoc(doc(mallory, 'users/alice')))
    await assertFails(setDoc(doc(mallory, 'users/alice'), profile()))
    await assertFails(deleteDoc(doc(mallory, 'users/alice')))
  })

  it('denies an unauthenticated client', async () => {
    await seedProfile()
    const anon = anonymous()

    await assertFails(getDoc(doc(anon, 'users/alice')))
    await assertFails(setDoc(doc(anon, 'users/alice'), profile()))
  })
})

/**
 * A complete, valid project document — as a payload for a write that must fail.
 *
 * Exactly what `POST /api/projects` writes, so the denial is on the rule and not
 * on the shape: a payload the rules would have refused for some other reason
 * would prove nothing about this block.
 */
function project() {
  return {
    name: 'Contact dashboard',
    description: null,
    locationId: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    deletedAt: null,
  }
}

async function seedProject(uid = 'alice', id = 'proj-1'): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(asModular(ctx.firestore()), `users/${uid}/projects/${id}`), {
      ...project(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })
}

describe('users/{uid}/projects/{projectId}', () => {
  /*
   * AC-21. The owner is the most privileged client there is, and every one of
   * their four operations is denied — the browser has `lib/projectsApi.ts` and
   * nothing else, and this is what makes a mistake in one of those routes a bug
   * rather than a breach.
   *
   * Rules do **not** cascade into subcollections, so `match /users/{uid}` above
   * says nothing at all about this path. The block being tested here is required
   * rather than decorative, and these cases are what would catch a later rule
   * that granted the parent recursively.
   */
  it('denies a verified owner reading their own project', async () => {
    await seedProject()

    await assertFails(getDoc(doc(verified('alice'), 'users/alice/projects/proj-1')))
  })

  it('denies a verified owner listing their own projects', async () => {
    await seedProject()

    await assertFails(getDocs(collection(verified('alice'), 'users/alice/projects')))
  })

  it('denies a verified owner creating a project', async () => {
    await assertFails(setDoc(doc(verified('alice'), 'users/alice/projects/proj-1'), project()))
  })

  it('denies a verified owner updating their own project', async () => {
    await seedProject()

    await assertFails(
      updateDoc(doc(verified('alice'), 'users/alice/projects/proj-1'), {
        name: 'Contacts',
        updatedAt: serverTimestamp(),
      }),
    )
  })

  /* Soft-delete belongs to the endpoint, which writes a timestamp rather than
   * removing the document. A client deleting it outright would destroy the one
   * record of when it went. */
  it('denies a verified owner deleting their own project', async () => {
    await seedProject()

    await assertFails(deleteDoc(doc(verified('alice'), 'users/alice/projects/proj-1')))
  })

  /** AC-22. */
  it('denies a different signed-in user, however verified they are', async () => {
    await seedProject()
    const mallory = verified('mallory')

    await assertFails(getDoc(doc(mallory, 'users/alice/projects/proj-1')))
    await assertFails(getDocs(collection(mallory, 'users/alice/projects')))
    await assertFails(setDoc(doc(mallory, 'users/alice/projects/proj-2'), project()))
    await assertFails(updateDoc(doc(mallory, 'users/alice/projects/proj-1'), { name: 'Stolen' }))
    await assertFails(deleteDoc(doc(mallory, 'users/alice/projects/proj-1')))
  })

  it('denies an unauthenticated client', async () => {
    await seedProject()
    const anon = anonymous()

    await assertFails(getDoc(doc(anon, 'users/alice/projects/proj-1')))
    await assertFails(setDoc(doc(anon, 'users/alice/projects/proj-2'), project()))
  })
})

describe('server-only collections', () => {
  /*
   * AC-15 — re-asserted because the rules file was rewritten. These two were
   * never client-reachable, and a rewrite is exactly the moment a collection
   * quietly loses its denial along with the helper it shared with something
   * else.
   *
   * The owner case is the one that matters and the one people skip. It is
   * tempting to let a user read their own connection — but a token readable by
   * the browser is a token readable by anyone who opens devtools.
   */
  it('denies even a verified owner reading their own HighLevel tokens', async () => {
    await assertFails(getDoc(doc(verified('alice'), 'hlConnections/alice')))
  })

  it('denies a verified owner writing their own connection', async () => {
    await assertFails(
      setDoc(doc(verified('alice'), 'hlConnections/alice'), {
        accessToken: 'live-access-token',
        refreshToken: 'live-refresh-token',
        locationId: 'lUanVn0CtZJTlymH8ySo',
        needsReconnect: false,
      }),
    )
  })

  it('denies a stranger and an anonymous client alike', async () => {
    const bob = verified('bob')
    const anon = anonymous()

    await assertFails(getDoc(doc(bob, 'hlConnections/alice')))
    await assertFails(setDoc(doc(bob, 'hlConnections/alice'), { accessToken: 'x' }))
    await assertFails(getDoc(doc(anon, 'hlConnections/alice')))
  })

  it('denies deleting a connection — disconnect goes through the endpoint', async () => {
    await assertFails(deleteDoc(doc(verified('alice'), 'hlConnections/alice')))
  })

  /*
   * Readable by a client, these would answer "has anyone tried to register this
   * address?" — the enumeration question the uniform registration response
   * exists to refuse.
   */
  it('denies every client the throttle counters', async () => {
    const alice = verified('alice')
    const anon = anonymous()

    await assertFails(getDoc(doc(alice, 'authThrottle/email:abc')))
    await assertFails(setDoc(doc(alice, 'authThrottle/email:abc'), { count: 0 }))
    await assertFails(getDoc(doc(anon, 'authThrottle/email:abc')))
  })
})

describe('unknown collections', () => {
  /** AC-16. Collections arrive slice by slice, each with its own denial test. */
  it('denies anything without an explicit rule', async () => {
    const alice = verified('alice')

    await assertFails(getDoc(doc(alice, 'projects/anything')))
    await assertFails(setDoc(doc(alice, 'somethingNew/doc'), { a: 1 }))
  })
})
