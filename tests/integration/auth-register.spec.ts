import { beforeEach, describe, expect, it } from 'vitest'

import { adminAuth, canSignIn, oobCodes, postJson, resetEmulators, seedUser } from './helpers'

const EMAIL = 'alice@example.test'
const UNKNOWN = 'nobody@example.test'
const PASSWORD = 'Correct-Horse-9'
const OTHER_PASSWORD = 'Different-Horse-7'

beforeEach(async () => {
  await resetEmulators()
})

describe('POST /auth/register — address not registered', () => {
  it('accepts the registration and reports nothing about the address', async () => {
    const res = await postJson('/auth/register', { email: EMAIL, password: PASSWORD })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('creates the account unverified, so the session gate has something to hold', async () => {
    await postJson('/auth/register', { email: EMAIL, password: PASSWORD })

    const user = await adminAuth().getUserByEmail(EMAIL)
    expect(user.emailVerified).toBe(false)
  })

  it('normalises the address, so casing cannot fork one account into two', async () => {
    await postJson('/auth/register', { email: '  Alice@Example.TEST ', password: PASSWORD })

    const user = await adminAuth().getUserByEmail(EMAIL)
    expect(user.email).toBe(EMAIL)
  })

  /**
   * Registration sends nothing at all. Verification is sent later by the gate,
   * once the user has signed in — which is what stops this endpoint from being
   * usable to mail someone who never asked for an account.
   */
  it('sends no email', async () => {
    await postJson('/auth/register', { email: EMAIL, password: PASSWORD })

    expect(await oobCodes()).toHaveLength(0)
  })
})

/**
 * The criterion the whole server-side design exists for.
 *
 * The client SDK's `createUserWithEmailAndPassword` reports EMAIL_EXISTS on the
 * wire, so branching in the browser closes nothing. Here nothing observable
 * differs between the two branches — not the status, not the body, and now not
 * even an email, since neither branch sends one.
 */
describe('POST /auth/register — address already registered', () => {
  it.each([
    ['verified', true],
    ['unverified', false],
  ])('responds byte-identically for an existing %s account', async (_label, verified) => {
    const fresh = await postJson('/auth/register', { email: UNKNOWN, password: PASSWORD })

    await seedUser(EMAIL, PASSWORD, verified)
    const existing = await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    expect(existing.status).toBe(fresh.status)
    expect(existing.raw).toBe(fresh.raw)
  })

  /** A registration request may well be an attacker probing someone else's address. */
  it.each([
    ['verified', true],
    ['unverified', false],
  ])('changes nothing about an existing %s account', async (_label, verified) => {
    await seedUser(EMAIL, PASSWORD, verified)

    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    expect(await canSignIn(EMAIL, PASSWORD)).toBe(true)
    expect(await canSignIn(EMAIL, OTHER_PASSWORD)).toBe(false)

    const user = await adminAuth().getUserByEmail(EMAIL)
    expect(user.emailVerified).toBe(verified)

    const { users } = await adminAuth().listUsers()
    expect(users.filter((u) => u.email === EMAIL)).toHaveLength(1)
  })

  it('sends nothing, so the branch is invisible from the mailbox too', async () => {
    await seedUser(EMAIL, PASSWORD, false)

    await postJson('/auth/register', { email: EMAIL, password: OTHER_PASSWORD })

    expect(await oobCodes()).toHaveLength(0)
  })
})

describe('POST /auth/register — rejected input', () => {
  /**
   * Validation must run before any Auth call. If a weak password were only rejected after
   * Firebase had been consulted, the difference between "refused instantly" and "refused after a
   * round trip" would answer the question the endpoint exists to refuse.
   */
  it('rejects a password that misses the policy without creating anything', async () => {
    const res = await postJson('/auth/register', { email: EMAIL, password: 'short' })

    expect(res.status).toBe(400)
    await expect(adminAuth().getUserByEmail(EMAIL)).rejects.toThrow()
  })

  it('rejects it identically for an address that does exist', async () => {
    await seedUser(EMAIL, PASSWORD, true)

    const unknown = await postJson('/auth/register', { email: UNKNOWN, password: 'short' })
    const known = await postJson('/auth/register', { email: EMAIL, password: 'short' })

    expect(known.status).toBe(unknown.status)
    expect(known.raw).toBe(unknown.raw)
    expect(await canSignIn(EMAIL, PASSWORD)).toBe(true)
  })

  it.each([
    ['no uppercase', 'correct-horse-9'],
    ['no digit', 'Correct-Horse-x'],
    ['no symbol', 'CorrectHorse9x'],
  ])('rejects a password with %s', async (_label, password) => {
    expect((await postJson('/auth/register', { email: EMAIL, password })).status).toBe(400)
  })

  it('rejects a malformed address', async () => {
    const res = await postJson('/auth/register', { email: 'not-an-email', password: PASSWORD })

    expect(res.status).toBe(400)
  })

  it('rejects a body that is not the expected shape', async () => {
    expect((await postJson('/auth/register', {})).status).toBe(400)
    expect((await postJson('/auth/register', { email: EMAIL })).status).toBe(400)
  })
})
