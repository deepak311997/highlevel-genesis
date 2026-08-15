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

describe('unknown collections', () => {
  it('denies anything without an explicit rule', async () => {
    const alice = env.authenticatedContext('alice').firestore()

    await assertFails(getDoc(doc(alice, 'projects/anything')))
    await assertFails(setDoc(doc(alice, 'somethingNew/doc'), { a: 1 }))
  })
})
