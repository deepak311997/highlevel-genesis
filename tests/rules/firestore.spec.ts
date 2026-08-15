import { readFileSync } from 'node:fs'

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

let env: RulesTestEnvironment

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-genesis',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
})

beforeEach(async () => {
  await env.clearFirestore()
})

afterAll(async () => {
  await env?.cleanup()
})

describe('users/{uid}', () => {
  it('lets the owner read and write their own profile', async () => {
    const db = env.authenticatedContext('alice').firestore()

    await assertSucceeds(setDoc(doc(db, 'users/alice'), { displayName: 'Alice' }))
    await assertSucceeds(getDoc(doc(db, 'users/alice')))
  })

  // The denial cases are the ones that matter — an allow test passes even when
  // the rules are wide open.
  it('denies a different signed-in user', async () => {
    const mallory = env.authenticatedContext('mallory').firestore()

    await assertFails(getDoc(doc(mallory, 'users/alice')))
    await assertFails(setDoc(doc(mallory, 'users/alice'), { displayName: 'pwned' }))
  })

  it('denies an unauthenticated caller', async () => {
    const anon = env.unauthenticatedContext().firestore()

    await assertFails(getDoc(doc(anon, 'users/alice')))
    await assertFails(setDoc(doc(anon, 'users/alice'), { displayName: 'anon' }))
  })
})

describe('hlConnections/{uid}', () => {
  it('denies even the owner — OAuth tokens are Admin-SDK only', async () => {
    const alice = env.authenticatedContext('alice').firestore()

    await assertFails(getDoc(doc(alice, 'hlConnections/alice')))
    await assertFails(setDoc(doc(alice, 'hlConnections/alice'), { accessToken: 'x' }))
  })
})

describe('_devMail/{id}', () => {
  // Deny-by-default already covers this, so the test is green before the rule
  // block exists. It is here as a regression pin: these documents hold live
  // action codes, and the day someone adds a broad `match /{doc=**}` this is
  // what fails.
  it('denies every client — recorded mail holds live action codes', async () => {
    const alice = env.authenticatedContext('alice').firestore()
    const anon = env.unauthenticatedContext().firestore()

    await assertFails(getDoc(doc(alice, '_devMail/some-id')))
    await assertFails(setDoc(doc(alice, '_devMail/some-id'), { to: 'x@y.test' }))
    await assertFails(getDoc(doc(anon, '_devMail/some-id')))
  })
})

describe('unknown collections', () => {
  it('denies anything without an explicit rule', async () => {
    const alice = env.authenticatedContext('alice').firestore()

    await assertFails(getDoc(doc(alice, 'projects/anything')))
    await assertFails(setDoc(doc(alice, 'somethingNew/doc'), { a: 1 }))
  })
})
